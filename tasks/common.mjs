// Generic tasks every stage uses.

import { BaseTask } from "@db-lyon/flowkit";
import { addLabels, closeIssue, dispatch, gh, removeLabels, repoSlug, summary, upsertComment, defaultBranch } from "../lib/github.mjs";

/**
 * issue.apply_plan: labels, marker comment, close, transfer and a follow-up
 * stage dispatch, in that order. The plan comes from a stage's planning task.
 */
export class IssueApplyPlan extends BaseTask {
  static description = "Apply a planned set of writes to one issue";
  static optionsSchema = {
    number: { type: "integer", required: true },
    plan: { type: "object", required: true },
    caller_workflow: { type: "string", default: "repo-agents.yml" },
  };
  get taskName() { return "issue.apply_plan"; }

  async execute() {
    const repo = repoSlug();
    const n = this.options.number;
    const p = this.options.plan;
    addLabels(repo, n, p.add ?? []);
    removeLabels(repo, n, p.remove ?? []);
    if (p.comment) upsertComment(repo, n, p.marker ?? "<!-- repo-agents -->", p.comment);
    if (p.close) closeIssue(repo, n, p.close);
    if (p.transfer) {
      gh(["issue", "transfer", String(n), p.transfer, "--repo", repo], { env: { ...process.env, GH_TOKEN: process.env.AGENTS_TOKEN } });
    }
    if (p.dispatch) {
      dispatch(repo, this.options.caller_workflow, defaultBranch(repo), { stage: p.dispatch.stage, number: String(n) });
    }
    return { success: true, data: { applied: true } };
  }
}

/** report: append text to the job summary (or stdout locally). */
export class Report extends BaseTask {
  static description = "Write text to the job summary";
  static optionsSchema = { text: { type: "string", default: "" } };
  get taskName() { return "report"; }
  async execute() {
    if (this.options.text) summary(this.options.text);
    return { success: true };
  }
}

export const TASKS = { report: Report, "issue.apply_plan": IssueApplyPlan };
