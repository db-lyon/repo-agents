// Triage tasks. triage.prepare builds the prompt variables and the schema;
// triage.plan verifies the agent's decision and plans the writes.

import fs from "node:fs";
import path from "node:path";
import { BaseTask } from "@db-lyon/flowkit";
import { workDir } from "../lib/config.mjs";
import { ghJson, issue as getIssue, releases, repoLabels, repoSlug, succeeds, tryRun, run } from "../lib/github.mjs";
import { areaLabels, candidateTable, decisionSchema, duplicateQueries, planActions, resolveDecision, routingTable, shouldTriage } from "../stages/triage/logic.mjs";

export class TriagePrepare extends BaseTask {
  static description = "Decide whether to triage, and build the triage prompt variables and schema";
  static optionsSchema = { number: { type: "integer", required: true } };
  get taskName() { return "triage.prepare"; }

  async execute() {
    const { settings } = this.ctx;
    const repo = repoSlug();
    const issue = getIssue(repo, this.options.number);
    const go = settings.triage.enabled && shouldTriage(process.env.GITHUB_EVENT_NAME, issue, settings);
    const labels = repoLabels(repo);
    const seen = new Map();
    for (const q of go ? duplicateQueries(issue.title, issue.body) : []) {
      for (const c of ghJson(["issue", "list", "--repo", repo, "--state", "all", "--limit", "8", "--search", q, "--json", "number,title,state"]) ?? []) {
        if (!seen.has(c.number)) seen.set(c.number, c);
      }
    }
    return {
      success: true,
      data: {
        go,
        schema: decisionSchema(settings),
        vars: {
          NUMBER: this.options.number,
          REPO: repo,
          ROUTING: routingTable(settings),
          CANDIDATES: candidateTable([...seen.values()], this.options.number),
          AREAS: areaLabels(settings, labels).map((l) => `\`${l}\``).join(", ") || "(none)",
        },
      },
    };
  }
}

/** Where a commit stands: on the default branch, and the first stable and prerelease tags containing it. */
export function fixFacts(sha, published, defaultRef = "origin/HEAD") {
  if (!sha || !succeeds("git", ["cat-file", "-e", `${sha}^{commit}`])) return null;
  const full = run("git", ["rev-parse", sha]);
  const onDefault = succeeds("git", ["merge-base", "--is-ancestor", full, defaultRef]);
  const tags = (tryRun("git", ["tag", "--contains", full, "--sort=version:refname"]) ?? "").split("\n").filter(Boolean);
  const byTag = new Map(published.map((r) => [r.tagName, r]));
  const firstStable = tags.find((t) => byTag.get(t) && !byTag.get(t).isPrerelease) ?? null;
  const firstPre = tags.find((t) => byTag.get(t)?.isPrerelease) ?? null;
  return { sha: full, short: full.slice(0, 8), onDefault, releasedIn: firstStable, prerelease: firstStable ? null : firstPre };
}

export class TriagePlan extends BaseTask {
  static description = "Verify the triage decision against GitHub and git, and plan the writes";
  static optionsSchema = {
    number: { type: "integer", required: true },
    outdir: { type: "string", default: "" },
    mode: { type: "string", enum: ["act", "propose", "dry-run"], required: true },
  };
  get taskName() { return "triage.plan"; }

  async execute() {
    const { settings, root } = this.ctx;
    const repo = repoSlug();
    const n = this.options.number;
    const file = path.join(workDir(this.options.outdir), "decision.json");
    const agent = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    const decision = agent.output ?? null;

    const issue = getIssue(repo, n);
    if (!issue || issue.state !== "open" || issue.locked || issue.isPullRequest) {
      return { success: true, data: { write: false, summary: `#${n}: skipped, the issue is no longer open.` } };
    }
    const published = releases(repo);
    tryRun("git", ["remote", "set-head", "origin", "--auto"]);
    const facts = {
      issue,
      duplicate: decision?.duplicateOf ? getIssue(repo, decision.duplicateOf) : null,
      fix: decision?.fixCommit ? fixFacts(decision.fixCommit, published) : null,
      canTransfer: Boolean(process.env.AGENTS_TOKEN),
    };
    const ctx = { settings, repoLabels: repoLabels(repo), latestRelease: published.find((r) => r.isLatest)?.tagName ?? null };
    const resolved = resolveDecision(decision, facts, settings, this.options.mode);
    const plan = planActions(resolved, decision, ctx);
    const summary = [
      `### Triage #${n}: ${resolved.outcome}${resolved.proposed && resolved.proposed !== resolved.outcome ? ` (proposed ${resolved.proposed})` : ""}`,
      "",
      `Mode \`${this.options.mode}\`. Confidence ${decision?.confidence ?? "n/a"}. Cost ${agent.cost == null ? "n/a" : `$${Number(agent.cost).toFixed(3)}`}, ${agent.turns ?? "?"} turns.${agent.error ? ` Agent error: ${agent.error}` : ""}`,
      resolved.reason ? `\nNot applied as proposed: ${resolved.reason}.` : "",
      "",
      "```json",
      JSON.stringify({ decision, plan }, null, 2),
      "```",
    ].join("\n");
    return { success: true, data: { write: this.options.mode !== "dry-run", plan, summary } };
  }
}

export const TASKS = { "triage.prepare": TriagePrepare, "triage.plan": TriagePlan };
