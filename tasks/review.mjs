// Review tasks. review.prepare decides whether to review and builds the
// prompt; review.plan verifies the decision against GitHub; review.post and
// review.merge perform the writes.

import fs from "node:fs";
import path from "node:path";
import { BaseTask } from "@db-lyon/flowkit";
import { workDir } from "../lib/config.mjs";
import { ghJson, repoSlug, runKeep, summary, tryRun } from "../lib/github.mjs";
import {
  alreadyReviewed, checksVerdict, loadSchema, mergeArgs, normalizePr, parseDiff, planReview, promptVars,
  reviewAttempts, scrubAgentFiles, shouldSkip, staleChangeRequests, summaryText,
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

export class ReviewPrepare extends BaseTask {
  static description = "Decide whether to review, scrub the PR checkout, and build the prompt variables and schema";
  static optionsSchema = {
    number: { type: "integer", required: true },
    outdir: { type: "string", default: "" },
    pr_dir: { type: "string", default: "../pr", description: "PR head checkout, relative to the project root" },
    dispatched: { type: "boolean", default: false },
  };
  get taskName() { return "review.prepare"; }

  async execute() {
    const { settings, root } = this.ctx;
    const repo = repoSlug();
    const n = this.options.number;
    const pr = prFacts(repo, n);
    const prDir = path.resolve(root, this.options.pr_dir);
    let skip = !settings.review.enabled ? "review is disabled" : !pr ? "PR not found" : shouldSkip(pr, { dispatched: dispatched(this.options.dispatched) });
    // The PR checkout must be its own tree; scrubbing the trusted root would be wrong.
    if (!skip && (prDir === path.resolve(root) || !fs.existsSync(prDir))) skip = `no PR checkout at ${prDir}`;

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
        summary: text,
        schema: loadSchema(),
        vars: pr ? promptVars({ number: n, pr }) : {},
      },
    };
  }
}

export class ReviewPlan extends BaseTask {
  static description = "Verify the review decision against GitHub and plan the review and merge";
  static optionsSchema = {
    number: { type: "integer", required: true },
    outdir: { type: "string", default: "" },
    dispatched: { type: "boolean", default: false },
  };
  get taskName() { return "review.plan"; }

  async execute() {
    const { settings } = this.ctx;
    const repo = repoSlug();
    const n = this.options.number;
    const dir = workDir(this.options.outdir);
    const agent = readJson(path.join(dir, "decision.json")) ?? {};
    const meta = readJson(path.join(dir, META)) ?? {};
    const decision = agent.output ?? null;
    const none = { post: false, merge: false, plan: {}, sha: "" };

    const pr = prFacts(repo, n);
    const skip = !settings.review.enabled ? "review is disabled" : !pr ? "PR not found" : shouldSkip(pr, { dispatched: dispatched(this.options.dispatched) });
    if (skip) return { success: true, data: { ...none, summary: summaryText({ n, skipped: skip }) } };

    const diff = tryRun("gh", ["pr", "diff", String(n), "--repo", repo]);
    const diffLines = diff === null ? null : parseDiff(diff);
    const plan = planReview({ decision, pr, cfg: settings, diffLines, reviewedSha: meta.head_sha ?? null });
    return {
      success: true,
      data: { post: plan.post, merge: plan.merge, plan, sha: meta.head_sha ?? pr.headSha, summary: summaryText({ n, decision, plan, agent }) },
    };
  }
}

export class ReviewPost extends BaseTask {
  static description = "Post the planned review on the reviewed commit";
  static optionsSchema = {
    number: { type: "integer", required: true },
    plan: { type: "object", required: true },
    sha: { type: "string", required: true },
  };
  get taskName() { return "review.post"; }

  async execute() {
    const repo = repoSlug();
    const n = this.options.number;
    const { plan, sha } = this.options;
    const reviews = (ghJson(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${n}/reviews?per_page=100`]) ?? []).flat();
    if (alreadyReviewed(reviews, sha)) {
      summary(`Review: already posted for ${sha.slice(0, 8)}, nothing new posted.`);
      return { success: true, data: { posted: false } };
    }

    let posted = null;
    let lastError = "";
    for (const attempt of reviewAttempts(plan, sha)) {
      const { note, ...payload } = attempt;
      const res = runKeep("gh", ["api", "-X", "POST", `repos/${repo}/pulls/${n}/reviews`, "--input", "-"], { input: JSON.stringify(payload) });
      if (res.status === 0) { posted = { event: payload.event, note }; break; }
      lastError = res.stderr || res.stdout;
      this.logger.warn(`review ${payload.event} refused: ${lastError}`);
    }
    if (!posted) throw new Error(`could not post the review: ${lastError}`);

    const stale = staleChangeRequests(reviews, posted.event);
    for (const id of stale) {
      tryRun("gh", ["api", "-X", "PUT", `repos/${repo}/pulls/${n}/reviews/${id}/dismissals`, "-f", "message=Superseded by a newer review.", "-f", "event=DISMISS"]);
    }
    summary(`Review: posted ${posted.event}${posted.note ? ` (${posted.note})` : ""}${stale.length ? `, dismissed ${stale.length} earlier change requests` : ""}.`);
    return { success: true, data: { posted: true, event: posted.event } };
  }
}

export class ReviewMerge extends BaseTask {
  static description = "Merge an approved PR: auto-merge when the repo allows it, else directly once every check passed";
  static optionsSchema = {
    number: { type: "integer", required: true },
    sha: { type: "string", required: true },
    method: { type: "string", enum: ["merge", "squash", "rebase"], default: "squash" },
  };
  get taskName() { return "review.merge"; }

  async execute() {
    const repo = repoSlug();
    const n = this.options.number;
    const { sha, method } = this.options;
    // A merge made with agents_token starts push workflows; github.token cannot.
    const env = { ...process.env, GH_TOKEN: process.env.AGENTS_TOKEN || process.env.GH_TOKEN };

    const auto = runKeep("gh", mergeArgs(repo, n, method, sha, true), { env });
    if (auto.status === 0) {
      summary(`Merge: auto-merge (${method}) enabled for ${sha.slice(0, 8)}.`);
      return { success: true, data: { merged: "auto" } };
    }
    this.logger.warn(`auto-merge refused: ${auto.stderr}`);

    const checks = runKeep("gh", ["pr", "checks", String(n), "--repo", repo, "--json", "name,bucket"]);
    let list = [];
    try { list = JSON.parse(checks.stdout || "[]"); } catch { list = []; }
    const verdict = checksVerdict(list);
    if (!verdict.ok) {
      summary(`Merge: not merged. Auto-merge is unavailable (${auto.stderr.split("\n")[0]}) and ${verdict.reason}.`);
      return { success: true, data: { merged: false } };
    }
    const direct = runKeep("gh", mergeArgs(repo, n, method, sha, false), { env });
    summary(direct.status === 0
      ? `Merge: merged ${sha.slice(0, 8)} (${method}), ${verdict.reason}.`
      : `Merge: not merged. ${direct.stderr.split("\n")[0]}`);
    return { success: true, data: { merged: direct.status === 0 } };
  }
}

export const TASKS = {
  "review.prepare": ReviewPrepare,
  "review.plan": ReviewPlan,
  "review.post": ReviewPost,
  "review.merge": ReviewMerge,
};
