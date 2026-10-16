// Resolve: an agent fixes one issue in a checkout, the workflow opens the PR.
// This module holds the pure decisions only. tasks/resolve.mjs and
// flows/resolve.yml run the agent, apply the patch, push and open the PR.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { READ_TOOLS, WRITE_TOOLS } from "../../lib/agent.mjs";
import { fill, matchesAny, neutralizeClosers, sanitize, sanitizeLong } from "../../lib/text.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROMPT_PATH = path.join(HERE, "prompt.md");
export const SCHEMA_PATH = path.join(HERE, "schema.json");
export const MARKER = "<!-- repo-agents:resolve -->";
export const STATUSES = ["fixed", "cannot-fix", "needs-human"];

const UNTRUSTED_TAG = /<<<\s*UNTRUSTED[^>]*>>>/gi;

/** Issue text for the prompt: delimiter look-alikes removed, length capped. */
export function untrusted(text, maxChars = 20000) {
  let t = String(text ?? "").replace(UNTRUSTED_TAG, "[removed]").trim();
  if (t.length > maxChars) t = `${t.slice(0, maxChars)}\n[truncated]`;
  return t || "(empty)";
}

/** Issue comments as one block, oldest first, each with its author and role. */
export function formatComments(comments, maxChars = 20000) {
  const text = (comments ?? [])
    .map((c) => `--- ${c.user?.login ?? "unknown"} (${(c.author_association ?? "NONE").toLowerCase()}) ---\n${c.body ?? ""}`)
    .join("\n\n");
  return text ? untrusted(text, maxChars) : "(none)";
}

function bullets(list, none = "(none)") {
  return list?.length ? list.map((x) => `   - \`${x}\``).join("\n") : `   ${none}`;
}

/**
 * Stage variables for prompt.md. claude_code fills CONTEXT, VOICE and the
 * project fields itself; values here win over its defaults.
 */
export function promptValues({ cfg, repo, issue, comments }) {
  const r = cfg.resolve;
  return {
    REPO: repo,
    NUMBER: issue.number,
    TITLE: untrusted(issue.title, 500),
    BODY: untrusted(issue.body),
    COMMENTS: formatComments(comments),
    PROJECT_DESCRIPTION: cfg.project.description || "(no description configured)",
    BANNED_PHRASES: cfg.project.banned_phrases.length ? cfg.project.banned_phrases.map((p) => `"${p}"`).join(", ") : "(none)",
    VERIFY: bullets(r.verify, "(none configured; run the project's tests if it has any)"),
    PROTECTED_PATHS: bullets(r.protected_paths),
    UNVERIFIABLE_PATHS: bullets(r.unverifiable_paths),
    ISSUE_REF: r.issue_ref,
    COMMIT_STYLE: r.commit_style,
  };
}

export function renderPrompt(template, values) {
  return fill(template, values);
}

/**
 * Tools and extra Bash patterns for the resolve agent: allow_commands plus each
 * verify command as a prefix pattern. claude_code adds READ_COMMANDS itself.
 */
export function agentAccess(cfg) {
  const commands = [...cfg.resolve.allow_commands, ...cfg.resolve.verify.map((c) => `${c.trim()}:*`)];
  return { tools: [...READ_TOOLS, ...WRITE_TOOLS], commands: [...new Set(commands)] };
}

export function branchName(cfg, n) {
  return `${cfg.resolve.branch_prefix}${n}`;
}

/** Files a git patch touches, both sides of a rename, from its diff headers. */
export function patchFiles(patch) {
  const files = new Set();
  for (const m of String(patch ?? "").matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    files.add(m[1]);
    files.add(m[2]);
  }
  return [...files];
}

/** The last maxChars of command output, cut at a line start. */
export function tail(text, maxChars = 4000) {
  const t = String(text ?? "").trimEnd();
  if (t.length <= maxChars) return t;
  const cut = t.slice(-maxChars);
  const nl = cut.indexOf("\n");
  return `[earlier output omitted]\n${nl >= 0 ? cut.slice(nl + 1) : cut}`;
}

/** Push URL carrying the token. Only set after agent-written code has run. */
export function pushUrl(repo, token) {
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}

export function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Files that appeared while the agent ran, so setup output stays out of the patch. */
export function newUntracked(before, after) {
  const seen = new Set(before);
  return after.filter((f) => f && !seen.has(f));
}

const SECRET_ENV = /^(GH_TOKEN|GITHUB_TOKEN|AGENTS_TOKEN|ANTHROPIC_API_KEY|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN|ACTIONS_ID_TOKEN_REQUEST_URL)$/;

/** Environment for setup and verify commands in the apply job: agent-written code never sees a token. */
export function scrubEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_ENV.test(k)));
}

const TRAILER = /^[A-Za-z][\w-]*:\s+\S/;
const ATTRIBUTION = /(co-authored-by|signed-off-by|claude-session|generated with|claude\.ai\/code)/i;

/** The agent's commit message, sanitized and without trailers or attribution. */
export function commitMessage(text, n) {
  const lines = sanitizeLong(text, { allowLinks: [] }).split("\n").filter((l) => !ATTRIBUTION.test(l));
  const paras = lines.join("\n").trim().split(/\n\s*\n/);
  if (paras.length > 1 && paras[paras.length - 1].split("\n").every((l) => TRAILER.test(l.trim()))) paras.pop();
  const msg = paras.join("\n\n").trim();
  return msg || `fix: resolve #${n}`;
}

function fence(text) {
  const t = String(text ?? "");
  const ticks = "`".repeat(Math.max(3, ...[...t.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}\n${t}\n${ticks}`;
}

/** PR body: the agent's text, then the verification this workflow ran, then the issue reference. */
export function prBody({ decision, verifyResults, cfg, n }) {
  const out = decision?.output ?? {};
  const parts = [neutralizeClosers(sanitizeLong(out.pr_body))];
  parts.push("## Verification");
  if (!verifyResults.length) parts.push("No verify commands are configured.");
  for (const v of verifyResults) parts.push(`- \`${v.command}\`: ${v.ok ? "pass" : "fail"}${v.setup ? " (setup)" : ""}`);
  for (const v of verifyResults.filter((x) => !x.ok && x.output)) {
    parts.push(`<details><summary>${v.command}</summary>\n\n${fence(v.output)}\n\n</details>`);
  }
  if (out.risk) parts.push(`Risk: ${out.risk}`);
  parts.push(`${cfg.resolve.issue_ref} #${n}`);
  return parts.filter(Boolean).join("\n\n");
}

/** Issue comment when no PR is opened: the agent's summary and the reasons. */
export function issueComment({ decision, plan }) {
  const summary = sanitize(decision?.output?.summary ?? "");
  const reasons = plan.reasons.map((r) => `- ${r}`).join("\n");
  return [summary, reasons ? `No pull request was opened:\n${reasons}` : ""].filter(Boolean).join("\n\n");
}

/** Issue comment linking the PR. */
export function prLinkComment({ decision, pr, draft, updated }) {
  const verb = updated ? "Updated" : "Opened";
  const kind = draft ? "draft pull request" : "pull request";
  const summary = sanitize(decision?.output?.summary ?? "");
  return [`${verb} ${kind} #${pr}.`, summary].filter(Boolean).join("\n\n");
}

/**
 * What to do with the agent's result. labels go on the PR for pr and draft-pr,
 * and on the issue for comment. verifyResults is [] before verification runs.
 */
export function planResolve({ decision, changedFiles = [], verifyResults = [], patchError = null, cfg, issue }) {
  const r = cfg.resolve;
  const needsHuman = (reasons) => ({ action: "comment", reasons, labels: [cfg.labels.needs_human] });
  if (!r.enabled) return { action: "skip", reasons: ["resolve is disabled in the config"], labels: [] };
  if (!issue) return { action: "skip", reasons: ["issue not found"], labels: [] };
  if (issue.isPullRequest) return { action: "skip", reasons: ["number is a pull request"], labels: [] };
  if (issue.state !== "open") return { action: "skip", reasons: ["issue is closed"], labels: [] };

  const out = decision?.output;
  if (!out) return needsHuman([`the agent returned no decision${decision?.error ? `: ${sanitize(decision.error, { maxLength: 200 })}` : ""}`]);
  if (!STATUSES.includes(out.status)) return needsHuman([`the agent returned an unknown status: ${out.status}`]);
  if (out.status !== "fixed") return needsHuman([`the agent reported ${out.status}`]);
  if (patchError) return needsHuman([`the patch does not apply: ${patchError}`]);
  if (!changedFiles.length) return needsHuman(["the agent reported a fix but changed no files"]);

  const protectedHits = changedFiles.filter((f) => matchesAny(f, r.protected_paths));
  if (protectedHits.length) return needsHuman([`the patch touches protected paths: ${protectedHits.join(", ")}`]);

  const labels = ["agents"];
  const reasons = [];
  const unverifiable = changedFiles.filter((f) => matchesAny(f, r.unverifiable_paths));
  if (unverifiable.length) {
    labels.push(r.unverifiable_label);
    reasons.push(`CI cannot verify: ${unverifiable.join(", ")}`);
  }
  if (!r.verify.length) reasons.push("no verify commands are configured");

  const failed = verifyResults.filter((v) => !v.ok);
  if (failed.length) {
    const why = `verification failed: ${failed.map((v) => v.command).join(", ")}`;
    if (r.on_failure === "comment") return needsHuman([why]);
    return { action: "draft-pr", reasons: [why, ...reasons], labels };
  }
  return { action: "pr", reasons, labels };
}

/**
 * Issue writes for issue.apply_plan. comment: the reasons and the needs-human
 * label. pr and draft-pr: in-progress label and a comment linking the PR.
 */
export function issuePlan({ plan, decision, cfg, pr = null, updated = false }) {
  const base = { marker: MARKER };
  if (plan.action === "comment") {
    return { ...base, add: plan.labels, remove: [cfg.labels.resolve, cfg.labels.in_progress], comment: issueComment({ decision, plan }) };
  }
  if (plan.action === "pr" || plan.action === "draft-pr") {
    return {
      ...base,
      add: [cfg.labels.in_progress],
      remove: [cfg.labels.resolve],
      comment: prLinkComment({ decision, pr, draft: plan.action === "draft-pr", updated }),
    };
  }
  return { ...base, add: [], remove: [] };
}

function money(cost) {
  return cost == null ? "n/a" : `$${Number(cost).toFixed(3)}`;
}

/** Job summary for the apply job. */
export function applySummary({ n, decision, plan, verifyResults, changedFiles }) {
  const out = decision?.output;
  const lines = [
    `### Resolve #${n}: ${plan.action}`,
    "",
    `Agent status ${out?.status ?? "none"}, risk ${out?.risk ?? "n/a"}. Cost ${money(decision?.cost)}, ${decision?.turns ?? "?"} turns.${decision?.error ? ` Agent error: ${decision.error}` : ""}`,
  ];
  if (plan.reasons.length) lines.push("", ...plan.reasons.map((r) => `- ${r}`));
  if (changedFiles.length) lines.push("", `Changed files: ${changedFiles.map((f) => `\`${f}\``).join(", ")}`);
  if (verifyResults.length) lines.push("", ...verifyResults.map((v) => `- \`${v.command}\`: ${v.ok ? "pass" : "fail"}${v.setup ? " (setup)" : ""}`));
  lines.push("", "```json", JSON.stringify({ decision: out ?? null, plan }, null, 2), "```");
  return lines.join("\n");
}

/** Job summary for the decide job. */
export function decideSummary({ n, decision, files }) {
  const out = decision?.output;
  return [
    `### Resolve #${n}: agent ${out?.status ?? "returned no decision"}`,
    "",
    `Cost ${money(decision?.cost)}, ${decision?.turns ?? "?"} turns.${decision?.error ? ` Agent error: ${decision.error}` : ""}`,
    out?.summary ? `\n${out.summary}` : "",
    files.length ? `\nPatch touches ${files.length} file(s): ${files.map((f) => `\`${f}\``).join(", ")}` : "\nEmpty patch.",
  ].join("\n");
}

/** The resolve schema as an object. */
export function schema() {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
}
