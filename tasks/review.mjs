// Review tasks. decide job: review.prepare decides whether to review and
// builds the prompt. apply job: review.facts reads the decision and the live
// PR; review.plan turns them into a review; review.post and review.merge
// perform the writes through the write seam.

import fs from "node:fs";
import path from "node:path";
import { BaseTask } from "@db-lyon/flowkit";
import { isInside, workDir } from "../lib/config.mjs";
import { ghJson, repoSlug, runKeep, tryRun } from "../lib/github.mjs";
import {
  alreadyReviewed, checksVerdict, diffFromJson, diffToJson, loadSchema, mergeArgs, normalizePr, parseDiff, planReview,
  promptVars, reviewAttempts, scrubAgentFiles, shouldSkip, staleChangeRequests, summaryText,
} from "../stages/review/review.mjs";

const META = "review-meta.json";
const PR_FIELDS = "number,title,body,state,isDraft,headRefName,headRefOid,isCrossRepository,labels,author";

const dispatched = (opt) => opt || process.env.GITHUB_EVENT_NAME === "workflow_dispatch";

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

/** Live PR facts, files from the paginated REST list (gh pr view caps them at 100). */
export function prFacts(repo, n) {
  const raw = ghJson(["pr", "view", String(n), "--repo", repo, "--json", PR_FIELDS]);
  if (!raw) return null;
  const pages = ghJson(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${n}/files?per_page=100`]) ?? [];
  return normalizePr(raw, pages.flat());
}

/**
 * Where the PR head is checked out. A relative pr_dir resolves against the
 * project root. It must be its own tree: not the root, not a parent of it.
 */
export function resolvePrDir(root, prDir) {
  const dir = path.resolve(root, prDir);
  if (isInside(root, dir)) return { dir, error: `the PR checkout ${dir} is the project root or contains it` };
  if (!fs.existsSync(dir)) return { dir, error: `no PR checkout at ${dir}` };
  return { dir, error: null };
}

/**
 * A PR checkout inside the project root (the review action's pr/) goes into
 * the root's .git/info/exclude, so no git add or status in the root picks
 * it up. Returns the excluded path, or null when it is outside the root.
 */
export function excludeFromRoot(root, dir) {
  if (!isInside(dir, root)) return null;
  const rel = `/${path.relative(path.resolve(root), dir).split(path.sep).join("/")}/`;
  const gitDir = tryRun("git", ["rev-parse", "--absolute-git-dir"], { cwd: root });
  if (!gitDir) return null;
  const file = path.join(gitDir, "info", "exclude");
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  if (!lines.includes(rel)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${lines.length && lines.at(-1) !== "" ? "\n" : ""}${rel}\n`);
  }
  return rel;
}

export class ReviewPrepare extends BaseTask {
  static description = "Decide whether to review, scrub the PR checkout, and build the prompt variables and schema";
  static optionsSchema = {
    number: { type: "integer", required: true },
    outdir: { type: "string", default: "" },
    pr_dir: { type: "string", default: "../pr", description: "PR head checkout, relative to the project root" },
    dispatched: { type: "boolean", default: false },
  };
  static outputs = { go: { type: "boolean" }, schema: { type: "object" }, vars: { type: "object" }, pr_dir: { type: "string", description: "The PR checkout, absolute; the agent's working directory" } };
  get taskName() { return "review.prepare"; }

  async execute() {
    const { root } = this.ctx;
    const repo = repoSlug();
    const n = this.options.number;
    const pr = prFacts(repo, n);
    const { dir: prDir, error } = resolvePrDir(root, this.options.pr_dir);
    let skip = !pr ? "PR not found" : shouldSkip(pr, { dispatched: dispatched(this.options.dispatched) });
    // The PR checkout must be its own tree; scrubbing the trusted root would be wrong.
    if (!skip && error) skip = error;
    if (!skip) excludeFromRoot(root, prDir);

    let removed = [];
    let sha = pr?.headSha ?? null;
    if (!skip) {
      removed = scrubAgentFiles(prDir);
      sha = tryRun("git", ["rev-parse", "HEAD"], { cwd: prDir }) ?? sha;
      const dir = workDir(this.options.outdir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, META), JSON.stringify({ number: n, head_sha: sha, scrubbed: removed }, null, 2));
    }
    const text = skip
      ? `### Review #${n}: skipped\n\n${skip}.`
      : `### Review #${n}: reviewing ${sha?.slice(0, 8) ?? "unknown head"}${removed.length ? `\n\nRemoved agent files from the PR checkout: ${removed.join(", ")}` : ""}`;
    return {
      success: true,
      data: {
        go: !skip,
        pr_dir: prDir,
        summary: text,
        schema: loadSchema(),
        vars: pr ? promptVars({ number: n, pr }) : {},
      },
    };
  }
}

export class ReviewFacts extends BaseTask {
  static description = "Read the review decision, the live PR and its diff";
  static optionsSchema = {
    number: { type: "integer", required: true },
    outdir: { type: "string", default: "" },
    dispatched: { type: "boolean", default: false },
  };
  static outputs = {
    go: { type: "boolean", description: "The PR is still reviewable" },
    agent: { type: "object" },
    pr: { type: "object", description: "normalizePr shape" },
    diff: { type: "object", description: "{ available, lines: { path: [line] } }" },
    reviewed_sha: { type: "string", description: "The head commit the agent saw" },
  };
  get taskName() { return "review.facts"; }

  async execute() {
    const repo = repoSlug();
    const n = this.options.number;
    const dir = workDir(this.options.outdir);
    const agent = readJson(path.join(dir, "decision.json")) ?? {};
    const meta = readJson(path.join(dir, META)) ?? {};
    const pr = prFacts(repo, n);
    const skip = !pr ? "PR not found" : shouldSkip(pr, { dispatched: dispatched(this.options.dispatched) });
    if (skip) return { success: true, data: { go: false, summary: summaryText({ n, skipped: skip }) } };
    const raw = tryRun("gh", ["pr", "diff", String(n), "--repo", repo]);
    return {
      success: true,
      data: {
        go: true,
        agent,
        pr,
        diff: { available: raw !== null, lines: raw === null ? {} : diffToJson(parseDiff(raw)) },
        reviewed_sha: meta.head_sha ?? "",
      },
    };
  }
}

export class ReviewPlan extends BaseTask {
  static description = "Plan the review and the merge from the decision and the PR facts";
  static optionsSchema = {
    number: { type: "integer", required: true },
    agent: { type: "object", default: {} },
    pr: { type: "object", required: true },
    diff: { type: "object", required: true },
    reviewed_sha: { type: "string", default: "" },
  };
  static outputs = {
    post: { type: "boolean" }, merge: { type: "boolean" }, plan: { type: "object" },
    sha: { type: "string" }, confidence: { type: "string" },
  };
  get taskName() { return "review.plan"; }

  async execute() {
    const { settings } = this.ctx;
    const { number: n, agent, pr, diff, reviewed_sha: reviewedSha } = this.options;
    const decision = agent.output ?? null;
    const diffLines = diff.available ? diffFromJson(diff.lines) : null;
    const plan = planReview({ decision, pr, cfg: settings, diffLines, reviewedSha: reviewedSha || null });
    return {
      success: true,
      data: {
        post: plan.post,
        merge: plan.merge,
        plan,
        sha: reviewedSha || pr.headSha,
        confidence: decision?.confidence ?? "",
        summary: summaryText({ n, decision, plan, agent }),
      },
    };
  }
}

export class ReviewPost extends BaseTask {
  static description = "Post the planned review on the reviewed commit";
  static optionsSchema = {
    number: { type: "integer", required: true },
    plan: { type: "object", required: true },
    sha: { type: "string", required: true },
    confidence: { type: "string", default: "" },
  };
  static outputs = { posted: { type: "boolean" }, event: { type: "string" } };
  get taskName() { return "review.post"; }

  async execute() {
    const repo = repoSlug();
    const n = this.options.number;
    const { plan, sha, confidence } = this.options;
    const { writer } = this.ctx;
    const reviews = (ghJson(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${n}/reviews?per_page=100`]) ?? []).flat();
    if (alreadyReviewed(reviews, sha)) {
      return { success: true, data: { posted: false, summary: `Review: already posted for ${sha.slice(0, 8)}, nothing new posted.` } };
    }

    let posted = null;
    let lastError = "";
    for (const attempt of reviewAttempts(plan, sha)) {
      const { note, ...payload } = attempt;
      const op = { stage: "review", kind: "review", target: `#${n}`, event: payload.event, text: payload.body, confidence };
      const res = await writer.write(op, () => runKeep("gh", ["api", "-X", "POST", `repos/${repo}/pulls/${n}/reviews`, "--input", "-"], { input: JSON.stringify(payload) }));
      if (res.status === 0) { posted = { event: payload.event, note }; break; }
      lastError = res.stderr || res.stdout;
      this.logger.warn(`review ${payload.event} refused: ${lastError}`);
    }
    if (!posted) throw new Error(`could not post the review: ${lastError}`);

    const stale = staleChangeRequests(reviews, posted.event);
    for (const id of stale) {
      await writer.write({ stage: "review", kind: "dismiss", target: `#${n} review ${id}` }, () =>
        tryRun("gh", ["api", "-X", "PUT", `repos/${repo}/pulls/${n}/reviews/${id}/dismissals`, "-f", "message=Superseded by a newer review.", "-f", "event=DISMISS"]));
    }
    return {
      success: true,
      data: {
        posted: true,
        event: posted.event,
        summary: `Review: posted ${posted.event}${posted.note ? ` (${posted.note})` : ""}${stale.length ? `, dismissed ${stale.length} earlier change requests` : ""}.`,
      },
    };
  }
}

export class ReviewMerge extends BaseTask {
  static description = "Merge an approved PR: auto-merge when the repo allows it, else directly once every check passed";
  static optionsSchema = {
    number: { type: "integer", required: true },
    sha: { type: "string", required: true },
    pr: { type: "object", required: true, description: "PR facts the merge guard checks" },
    confidence: { type: "string", default: "" },
    method: { type: "string", enum: ["merge", "squash", "rebase"], default: "squash" },
  };
  static outputs = { merged: { type: "string", description: "auto, direct or none" } };
  get taskName() { return "review.merge"; }

  async execute() {
    const repo = repoSlug();
    const n = this.options.number;
    const { sha, method, pr, confidence } = this.options;
    const { writer } = this.ctx;
    const op = { stage: "review", kind: "merge", target: `#${n}`, pr, confidence, method };
    // A merge made with agents_token starts push workflows; github.token cannot.
    const env = { ...process.env, GH_TOKEN: process.env.AGENTS_TOKEN || process.env.GH_TOKEN };

    const auto = await writer.write({ ...op, auto: true }, () => runKeep("gh", mergeArgs(repo, n, method, sha, true), { env }));
    if (auto.status === 0) {
      // gh merges at once when the PR is already mergeable; say which happened.
      const state = runKeep("gh", ["pr", "view", String(n), "--repo", repo, "--json", "state", "--jq", ".state"], { env }).stdout.trim();
      const done = state === "MERGED";
      return { success: true, data: { merged: done ? "direct" : "auto", summary: done ? `Merge: merged ${sha.slice(0, 8)} (${method}).` : `Merge: auto-merge (${method}) enabled for ${sha.slice(0, 8)}.` } };
    }
    this.logger.warn(`auto-merge refused: ${auto.stderr}`);

    const checks = runKeep("gh", ["pr", "checks", String(n), "--repo", repo, "--json", "name,bucket"]);
    let list = [];
    try { list = JSON.parse(checks.stdout || "[]"); } catch { list = []; }
    const verdict = checksVerdict(list);
    if (!verdict.ok) {
      return { success: true, data: { merged: "none", summary: `Merge: not merged. Auto-merge is unavailable (${auto.stderr.split("\n")[0]}) and ${verdict.reason}.` } };
    }
    const direct = await writer.write({ ...op, auto: false }, () => runKeep("gh", mergeArgs(repo, n, method, sha, false), { env }));
    return {
      success: true,
      data: {
        merged: direct.status === 0 ? "direct" : "none",
        summary: direct.status === 0 ? `Merge: merged ${sha.slice(0, 8)} (${method}), ${verdict.reason}.` : `Merge: not merged. ${direct.stderr.split("\n")[0]}`,
      },
    };
  }
}

export const TASKS = {
  "review.prepare": ReviewPrepare,
  "review.facts": ReviewFacts,
  "review.plan": ReviewPlan,
  "review.post": ReviewPost,
  "review.merge": ReviewMerge,
};
