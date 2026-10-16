// Review stage: pure planning for a read-only PR review. The tasks in
// tasks/review.mjs gather facts and perform the writes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchesAny, sanitize, sanitizeLong } from "../../lib/text.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const MARKER = "<!-- repo-agents:review -->";
export const MAX_COMMENTS = 15;
export const AGENTS_LABEL = "agents";
const VERDICTS = ["approve", "request-changes", "comment"];
const CONFIDENCE = ["high", "medium", "low"];
const EVENTS = { approve: "APPROVE", "request-changes": "REQUEST_CHANGES", comment: "COMMENT" };

export function loadSchema() {
  return JSON.parse(fs.readFileSync(path.join(HERE, "schema.json"), "utf8"));
}

const UNTRUSTED_TAG = /<<<\s*UNTRUSTED[^>]*>>>/gi;

/** Untrusted text cannot close its own delimiter, and is capped. */
export function untrusted(text, maxChars = 20000) {
  const t = String(text ?? "").replace(UNTRUSTED_TAG, "[removed]").trim();
  return t.length > maxChars ? `${t.slice(0, maxChars)}\n[truncated]` : t;
}

/** Prompt variables beyond the ones claude_code fills (REPO, CONTEXT, VOICE, PROJECT_DESCRIPTION). */
export function promptVars({ number, pr }) {
  return { NUMBER: number, TITLE: untrusted(pr.title, 500) || "(empty)", BODY: untrusted(pr.body) || "(empty)" };
}

/** gh pr view --json plus the REST file list, in the shape planReview takes. */
export function normalizePr(raw, files = []) {
  return {
    number: raw.number,
    title: raw.title ?? "",
    body: raw.body ?? "",
    state: raw.state,
    isDraft: Boolean(raw.isDraft),
    headRefName: raw.headRefName ?? "",
    headSha: raw.headRefOid ?? null,
    isCrossRepository: Boolean(raw.isCrossRepository),
    author: raw.author?.login ?? null,
    labels: (raw.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
    files: files.flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean),
  };
}

// Files Claude Code or other agents pick up as instructions from their cwd.
const AGENT_FILES = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".mcp.json"]);
const AGENT_DIRS = new Set([".claude"]);

/** Delete agent instruction files from a throwaway PR checkout. Returns what it removed. */
export function scrubAgentFiles(dir) {
  const removed = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && e.name === ".git") continue;
      if ((e.isDirectory() && AGENT_DIRS.has(e.name)) || (!e.isDirectory() && AGENT_FILES.has(e.name))) {
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(path.relative(dir, full).replace(/\\/g, "/"));
      } else if (e.isDirectory() && !e.isSymbolicLink()) walk(full);
    }
  };
  walk(dir);
  return removed.sort();
}

/** The agent's output, checked again before anything uses it. Returns null when unusable. */
export function validateDecision(d) {
  if (!d || typeof d !== "object") return null;
  if (!VERDICTS.includes(d.verdict) || !CONFIDENCE.includes(d.confidence)) return null;
  if (typeof d.summary !== "string" || !d.summary.trim()) return null;
  const comments = (Array.isArray(d.comments) ? d.comments : [])
    .filter((c) => c && typeof c.path === "string" && Number.isInteger(c.line) && c.line > 0 && typeof c.body === "string" && c.body.trim());
  return { verdict: d.verdict, confidence: d.confidence, summary: d.summary, comments };
}

/** Closed PRs are never reviewed; drafts only when dispatched by hand. */
export function shouldSkip(pr, { dispatched = false } = {}) {
  if (pr.state && pr.state !== "OPEN") return `PR is ${pr.state.toLowerCase()}`;
  if (pr.isDraft && !dispatched) return "PR is a draft";
  return null;
}

function diffPath(raw, prefix) {
  let p = raw.replace(/\t.*$/, "").trim();
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).replace(/\\(["\\])/g, "$1");
  if (p === "/dev/null") return null;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/**
 * Parse a unified diff (gh pr diff) into Map(path -> Set of new-side line
 * numbers a review comment can land on: added and context lines). Deleted,
 * binary and renamed-away paths are present with an empty set.
 */
export function parseDiff(text) {
  const files = new Map();
  const ensure = (p) => {
    if (!p) return null;
    if (!files.has(p)) files.set(p, new Set());
    return files.get(p);
  };
  let cur = null;
  let oldPath = null;
  let oldLeft = 0;
  let newLeft = 0;
  let line = 0;
  for (const raw of String(text ?? "").split("\n")) {
    const l = raw.replace(/\r$/, "");
    if (oldLeft > 0 || newLeft > 0) {
      const c = l[0];
      if (c === "+") { cur?.add(line++); newLeft--; }
      else if (c === "-") oldLeft--;
      else if (c === "\\") { /* no newline at end of file */ }
      else { cur?.add(line++); newLeft--; oldLeft--; }
      continue;
    }
    if (l.startsWith("diff --git ")) { cur = null; oldPath = null; continue; }
    const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h) {
      oldLeft = h[1] === undefined ? 1 : Number(h[1]);
      line = Number(h[2]);
      newLeft = h[3] === undefined ? 1 : Number(h[3]);
      continue;
    }
    if (l.startsWith("--- ")) { oldPath = diffPath(l.slice(4), "a/"); continue; }
    if (l.startsWith("+++ ")) {
      const p = diffPath(l.slice(4), "b/");
      if (oldPath && oldPath !== p) ensure(oldPath);
      cur = ensure(p);
      continue;
    }
    if (l.startsWith("rename from ")) { ensure(l.slice(12).trim()); continue; }
    if (l.startsWith("rename to ")) { ensure(l.slice(10).trim()); continue; }
    const bin = /^Binary files (.+) and (.+) differ$/.exec(l);
    if (bin) { ensure(diffPath(bin[1], "a/")); ensure(diffPath(bin[2], "b/")); }
  }
  return files;
}

/** gh pr checks --json name,bucket: merge directly only when every check passed. */
export function checksVerdict(checks) {
  const list = Array.isArray(checks) ? checks : [];
  if (!list.length) return { ok: false, reason: "no checks reported" };
  const bad = list.filter((c) => !["pass", "skipping"].includes(c.bucket));
  if (bad.length) return { ok: false, reason: `checks not passed: ${bad.map((c) => `${c.name} (${c.bucket})`).join(", ")}` };
  return { ok: true, reason: `${list.length} checks passed` };
}

/** Does auto_merge policy cover this PR? */
export function policyAllows(pr, cfg) {
  const policy = cfg.review.auto_merge;
  if (policy === "all") return true;
  if (policy !== "agents") return false;
  if ((pr.labels ?? []).includes(AGENTS_LABEL)) return true;
  // A fork can name its branch anything, so the prefix only counts in-repo.
  return !pr.isCrossRepository && String(pr.headRefName ?? "").startsWith(cfg.resolve.branch_prefix);
}

function normPath(p) {
  return String(p).trim().replace(/\\/g, "/").replace(/^\.?\//, "");
}

/**
 * Plan the review. decision: agent output (or null). pr: { state, isDraft,
 * headRefName, headSha, isCrossRepository, labels: [name], files: [path] }.
 * diffLines: parseDiff output, or null when the diff could not be fetched.
 * reviewedSha: the head commit the agent saw.
 */
export function planReview({ decision, pr, cfg, diffLines, reviewedSha = null }) {
  const reasons = [];
  const d = validateDecision(decision);
  if (!d) {
    return { event: "COMMENT", body: "", comments: [], post: false, merge: false, reasons: ["no usable decision from the agent"] };
  }
  if (reviewedSha && pr.headSha && reviewedSha !== pr.headSha) {
    return { event: "COMMENT", body: "", comments: [], post: false, merge: false, reasons: [`head moved from ${reviewedSha.slice(0, 7)} to ${pr.headSha.slice(0, 7)}; a newer review covers it`] };
  }

  const notes = [];
  let event = EVENTS[d.verdict];
  if (event === "APPROVE" && d.confidence !== "high") {
    event = "COMMENT";
    reasons.push(`approval withheld: confidence ${d.confidence}`);
    notes.push(`Approval withheld: confidence ${d.confidence}.`);
  }

  const comments = [];
  const dropped = [];
  for (const c of d.comments) {
    const p = normPath(c.path);
    const body = sanitize(c.body, { maxLength: 1500 });
    if (!body) continue;
    if (comments.length < MAX_COMMENTS && diffLines?.get(p)?.has(c.line)) comments.push({ path: p, line: c.line, side: "RIGHT", body });
    else dropped.push(`- ${p}:${c.line}: ${body}`);
  }
  if (dropped.length) reasons.push(`${dropped.length} comments not on diff lines, moved to the body`);

  const touched = [...new Set([...(pr.files ?? []), ...(diffLines ? diffLines.keys() : [])].map(normPath))];
  const human = touched.filter((f) => matchesAny(f, cfg.review.human_paths ?? []));
  const unverifiable = (pr.labels ?? []).includes(cfg.resolve.unverifiable_label)
    || touched.some((f) => matchesAny(f, cfg.resolve.unverifiable_paths ?? []));

  let merge = d.verdict === "approve" && d.confidence === "high";
  const block = (why) => { if (merge) reasons.push(`no merge: ${why}`); merge = false; };
  if (human.length) {
    block(`touches paths that need a human: ${human.join(", ")}`);
    notes.push(`Needs a human approval: touches ${human.slice(0, 10).join(", ")}${human.length > 10 ? " and more" : ""}.`);
  }
  if (unverifiable) block("needs native verification");
  if (!diffLines) block("diff unavailable");
  if (pr.isDraft) block("draft");
  if (!policyAllows(pr, cfg)) block(`auto_merge policy ${cfg.review.auto_merge}`);
  if (merge) reasons.push(`merge with ${cfg.review.merge_method}`);

  const parts = [sanitizeLong(d.summary, { maxLength: 4000 })];
  if (dropped.length) parts.push(`Notes outside the diff:\n${dropped.join("\n")}`);
  if (notes.length) parts.push(notes.join(" "));
  return { event, body: `${MARKER}\n${parts.filter(Boolean).join("\n\n")}`, comments, post: true, merge, reasons };
}

/** Request bodies for POST /pulls/{n}/reviews, best first. Later ones survive what GitHub may refuse. */
export function reviewAttempts(plan, sha) {
  const base = { commit_id: sha ?? undefined };
  const attempts = [{ ...base, event: plan.event, body: plan.body, comments: plan.comments }];
  if (plan.event === "APPROVE") {
    attempts.push({ ...base, event: "COMMENT", body: `${plan.body}\n\nPosted as a comment: this token cannot approve pull requests.`, comments: plan.comments, note: "APPROVE refused, posted as COMMENT" });
  }
  if (plan.comments.length) {
    const inline = plan.comments.map((c) => `- ${c.path}:${c.line}: ${c.body}`).join("\n");
    const event = plan.event === "APPROVE" ? "COMMENT" : plan.event;
    attempts.push({ ...base, event, body: `${plan.body}\n\nInline notes:\n${inline}`, comments: [], note: "inline comments refused, moved to the body" });
  }
  return attempts;
}

/** Has this toolkit already reviewed this exact commit? Re-runs then post nothing. */
export function alreadyReviewed(reviews, sha) {
  return (reviews ?? []).some((r) => r.body?.includes(MARKER) && r.commit_id === sha);
}

/** Earlier change requests of ours that a newer non-blocking review supersedes. */
export function staleChangeRequests(reviews, event) {
  if (event === "REQUEST_CHANGES") return [];
  return (reviews ?? []).filter((r) => r.state === "CHANGES_REQUESTED" && r.body?.includes(MARKER)).map((r) => r.id);
}

export function mergeArgs(repo, n, method, sha, auto) {
  const args = ["pr", "merge", String(n), "--repo", repo, `--${method}`];
  if (sha) args.push("--match-head-commit", sha);
  if (auto) args.push("--auto");
  return args;
}

/** Job summary for the apply job: decision, plan, cost. */
export function summaryText({ n, decision, plan, agent, skipped }) {
  if (skipped) return `### Review #${n}: skipped\n\n${skipped}.`;
  const cost = agent?.cost == null ? "n/a" : `$${Number(agent.cost).toFixed(3)}`;
  return [
    `### Review #${n}: ${plan.post ? plan.event : "nothing posted"}${plan.merge ? ", merge" : ""}`,
    "",
    `Verdict ${decision?.verdict ?? "n/a"}, confidence ${decision?.confidence ?? "n/a"}. Cost ${cost}, ${agent?.turns ?? "?"} turns.${agent?.error ? ` Agent error: ${agent.error}` : ""}`,
    plan.reasons.length ? `\n${plan.reasons.map((r) => `- ${r}`).join("\n")}` : "",
    "",
    "```json",
    JSON.stringify({ decision, plan: { event: plan.event, post: plan.post, merge: plan.merge, comments: plan.comments.length } }, null, 2),
    "```",
  ].join("\n");
}
