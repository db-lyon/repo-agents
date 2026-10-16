// Closeout tasks. No model runs. closeout.pr_facts and closeout.release_facts
// read GitHub and git; closeout.plan_merged and closeout.plan_released apply
// the rules in stages/closeout; closeout.apply makes the writes through the
// write seam. The flows run in a job with a full-history checkout, so tags
// and the default branch are present.

import { BaseTask } from "@db-lyon/flowkit";
import { addLabels, closeIssue, defaultBranch, ghJson, issue as getIssue, repoSlug, removeLabels, run, succeeds, tryRun, upsertComment } from "../lib/github.mjs";
import { PRERELEASE_MARKER, citedShas, classify, planMerged, planReleased, referencedIssues } from "../stages/closeout/logic.mjs";

const PR_QUERY = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){
  closingIssuesReferences(first:50){nodes{number repository{nameWithOwner}}}
  timelineItems(first:100,itemTypes:[CONNECTED_EVENT]){nodes{... on ConnectedEvent{subject{... on Issue{number repository{nameWithOwner}}}}}}}}}`;

const ISSUE_QUERY = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){
  comments(last:50){nodes{body}}
  timelineItems(first:100,itemTypes:[CROSS_REFERENCED_EVENT,CONNECTED_EVENT]){nodes{
    ... on CrossReferencedEvent{source{... on PullRequest{merged mergeCommit{oid}}}}
    ... on ConnectedEvent{subject{... on PullRequest{merged mergeCommit{oid}}}}}}}}}`;

function graphql(query, repo, n) {
  const [owner, name] = repo.split("/");
  return ghJson(["api", "graphql", "-f", `query=${query}`, "-F", `o=${owner}`, "-F", `r=${name}`, "-F", `n=${n}`])?.data?.repository ?? null;
}

/** Issues a merged PR references: closing keywords and Refs in its title, body and commits, plus GitHub's own links. */
export function prIssueNumbers(repo, pr) {
  const sameRepo = (node) => node?.repository?.nameWithOwner?.toLowerCase() === repo.toLowerCase();
  const texts = [pr.title, pr.body, ...(pr.commits ?? []).map((c) => `${c.messageHeadline ?? ""}\n${c.messageBody ?? ""}`)];
  const found = new Set(referencedIssues(texts.join("\n"), repo));
  const links = graphql(PR_QUERY, repo, pr.number)?.pullRequest;
  for (const node of links?.closingIssuesReferences?.nodes ?? []) if (sameRepo(node)) found.add(node.number);
  for (const node of links?.timelineItems?.nodes ?? []) if (sameRepo(node?.subject)) found.add(node.subject.number);
  return [...found].sort((a, b) => a - b);
}

export class CloseoutPrFacts extends BaseTask {
  static description = "Read a merged pull request and the issues it references";
  static optionsSchema = { number: { type: "integer", required: true, description: "The merged pull request" } };
  static outputs = { go: { type: "boolean" }, pr: { type: "object" }, issues: { type: "array" } };
  get taskName() { return "closeout.pr_facts"; }

  async execute() {
    const repo = repoSlug();
    const n = this.options.number;
    const pr = ghJson(["pr", "view", String(n), "--repo", repo, "--json", "number,title,body,state,mergedAt,mergeCommit,commits"]);
    if (!pr || pr.state !== "MERGED") {
      return { success: true, data: { go: false, summary: `### Closeout #${n}: skipped, the pull request is not merged.` } };
    }
    const issues = prIssueNumbers(repo, pr).filter((i) => i !== n).map((i) => getIssue(repo, i)).filter(Boolean);
    return { success: true, data: { go: true, pr: { number: n, mergeCommit: pr.mergeCommit?.oid ?? "" }, issues } };
  }
}

/** Every commit on the default branch that cites issue n. */
export function fixCommits(repo, n, defaultRef) {
  const found = new Set();
  const log = tryRun("git", ["log", defaultRef, "-E", `--grep=#${n}([^0-9]|$)`, "--format=%H"]) ?? "";
  for (const sha of log.split("\n").filter(Boolean)) found.add(sha);
  const issue = graphql(ISSUE_QUERY, repo, n)?.issue;
  for (const node of issue?.timelineItems?.nodes ?? []) {
    const pr = node.source ?? node.subject;
    if (pr?.merged && pr.mergeCommit?.oid) found.add(pr.mergeCommit.oid);
  }
  for (const c of issue?.comments?.nodes ?? []) {
    for (const s of citedShas(c.body)) {
      if (!succeeds("git", ["cat-file", "-e", `${s}^{commit}`])) continue;
      found.add(run("git", ["rev-parse", s]));
    }
  }
  return [...found].filter((sha) => succeeds("git", ["merge-base", "--is-ancestor", sha, defaultRef]));
}

export class CloseoutReleaseFacts extends BaseTask {
  static description = "Read a published release and where each fixed_pending issue's fix stands against it";
  static optionsSchema = { tag: { type: "string", required: true, description: "The release tag" } };
  static outputs = { go: { type: "boolean" }, release: { type: "object" }, issues: { type: "array" } };
  get taskName() { return "closeout.release_facts"; }

  async execute() {
    const { settings } = this.ctx;
    const repo = repoSlug();
    const tag = this.options.tag;
    const release = ghJson(["release", "view", tag, "--repo", repo, "--json", "isDraft,isPrerelease"]);
    if (!release) return { success: true, data: { go: false, summary: `### Closeout ${tag}: no release, nothing to close.` } };
    if (release.isDraft) return { success: true, data: { go: false, summary: `### Closeout ${tag}: still a draft, nothing to close.` } };
    if (!succeeds("git", ["rev-parse", "--verify", `${tag}^{commit}`])) {
      return { success: false, error: new Error(`tag ${tag} is not in the checkout; fetch tags (fetch-depth: 0)`) };
    }

    const defaultRef = `origin/${defaultBranch(repo)}`;
    const label = settings.labels.fixed_pending;
    const open = ghJson(["issue", "list", "--repo", repo, "--state", "open", "--label", label, "--limit", "500", "--json", "number,title"]) ?? [];
    const issues = open.map(({ number, title }) => {
      const commits = fixCommits(repo, number, defaultRef);
      const state = classify(commits, (c) => succeeds("git", ["merge-base", "--is-ancestor", c, tag]));
      let announced = false;
      if (state === "released" && release.isPrerelease) {
        const comments = ghJson(["api", "--paginate", "--slurp", `repos/${repo}/issues/${number}/comments`]) ?? [];
        announced = comments.flat().some((c) => c.body?.includes(PRERELEASE_MARKER));
      }
      return { number, title, commits, state, announced };
    });
    return { success: true, data: { go: true, release: { isPrerelease: Boolean(release.isPrerelease) }, issues } };
  }
}

function planResult(heading, plan) {
  return { success: true, data: { write: plan.items.length > 0, plan, summary: [heading, "", ...plan.lines].join("\n") } };
}

export class CloseoutPlanMerged extends BaseTask {
  static description = "Plan the closes or labels for a merged pull request's issues";
  static optionsSchema = {
    number: { type: "integer", required: true },
    pr: { type: "object", required: true },
    issues: { type: "array", default: [] },
  };
  static outputs = { write: { type: "boolean" }, plan: { type: "object" } };
  get taskName() { return "closeout.plan_merged"; }

  async execute() {
    const { settings } = this.ctx;
    const plan = planMerged({ pr: this.options.pr, issues: this.options.issues, settings });
    return planResult(`### Closeout #${this.options.number} (merged, close_on ${settings.closeout.close_on})`, plan);
  }
}

export class CloseoutPlanReleased extends BaseTask {
  static description = "Plan the closes and prerelease announcements for a published release";
  static optionsSchema = {
    tag: { type: "string", required: true },
    release: { type: "object", required: true },
    issues: { type: "array", default: [] },
  };
  static outputs = { write: { type: "boolean" }, plan: { type: "object" } };
  get taskName() { return "closeout.plan_released"; }

  async execute() {
    const { settings } = this.ctx;
    const { tag, release, issues } = this.options;
    const plan = planReleased({ tag, release, issues, settings });
    return planResult(`### Closeout ${tag} (${release.isPrerelease ? "prerelease" : "stable"})`, plan);
  }
}

/** closeout.apply: per issue, labels, unlabel, marker comment and close, each through the write seam. */
export class CloseoutApply extends BaseTask {
  static description = "Apply a closeout plan to its issues";
  static optionsSchema = { plan: { type: "object", required: true } };
  static outputs = { applied: { type: "array", description: "Issue numbers written to" } };
  get taskName() { return "closeout.apply"; }

  async execute() {
    const repo = repoSlug();
    const { writer } = this.ctx;
    const applied = [];
    for (const item of this.options.plan.items ?? []) {
      const n = item.number;
      const base = { stage: "closeout", target: `#${n}` };
      if (item.add?.length) await writer.write({ ...base, kind: "label", labels: item.add }, () => addLabels(repo, n, item.add));
      if (item.remove?.length) await writer.write({ ...base, kind: "unlabel", labels: item.remove }, () => removeLabels(repo, n, item.remove));
      if (item.comment) await writer.write({ ...base, kind: "comment", text: item.comment }, () => upsertComment(repo, n, item.marker, item.comment));
      if (item.close) {
        await writer.write({ ...base, kind: "close", reason: item.close, releasedIn: item.releasedIn ?? null, fixedIn: item.fixedIn ?? null }, () => closeIssue(repo, n, item.close));
      }
      applied.push(n);
    }
    return { success: true, data: { applied } };
  }
}

export const TASKS = {
  "closeout.pr_facts": CloseoutPrFacts,
  "closeout.release_facts": CloseoutReleaseFacts,
  "closeout.plan_merged": CloseoutPlanMerged,
  "closeout.plan_released": CloseoutPlanReleased,
  "closeout.apply": CloseoutApply,
};
