// Generic tasks every stage uses.

import { BaseTask } from "@db-lyon/flowkit";
import { addLabels, closeIssue, defaultBranch, dispatch, gh, removeLabels, repoSlug, summary, upsertComment } from "../lib/github.mjs";

/**
 * issue.apply_plan: labels, marker comment, close, transfer and a follow-up
 * stage dispatch, in that order, each through the write seam. The plan comes
 * from a stage's planning task; plan.confidence and plan.releasedIn are the
 * evidence the guards check closes and transfers against.
 */
export class IssueApplyPlan extends BaseTask {
  static description = "Apply a planned set of writes to one issue";
  static optionsSchema = {
    number: { type: "integer", required: true },
    plan: { type: "object", required: true },
    stage: { type: "string", required: true, description: "The stage the writes belong to, for the guards" },
    mode: { type: "string", enum: ["act", "propose", "dry-run"], default: "act" },
    caller_workflow: { type: "string", default: "repo-agents.yml" },
  };
  static outputs = { applied: { type: "array", description: "Kinds of the writes made" } };
  get taskName() { return "issue.apply_plan"; }

  async execute() {
    const repo = repoSlug();
    const n = this.options.number;
    const p = this.options.plan;
    const { writer } = this.ctx;
    const base = { stage: this.options.stage, target: `#${n}`, mode: this.options.mode, confidence: p.confidence };
    const applied = [];
    const write = async (op, fn) => { await writer.write({ ...base, ...op }, fn); applied.push(op.kind); };

    const add = [...new Set(p.add ?? [])].filter(Boolean);
    if (add.length) await write({ kind: "label", labels: add }, () => addLabels(repo, n, add));
    if (p.remove?.length) await write({ kind: "unlabel", labels: p.remove }, () => removeLabels(repo, n, p.remove));
    if (p.comment) {
      const marker = p.marker ?? "<!-- repo-agents -->";
      await write({ kind: "comment", text: p.comment }, () => upsertComment(repo, n, marker, p.comment));
    }
    if (p.close) await write({ kind: "close", reason: p.close, releasedIn: p.releasedIn ?? null }, () => closeIssue(repo, n, p.close));
    if (p.transfer) {
      await write({ kind: "transfer", destination: p.transfer }, () =>
        gh(["issue", "transfer", String(n), p.transfer, "--repo", repo], { env: { ...process.env, GH_TOKEN: process.env.AGENTS_TOKEN } }));
    }
    if (p.dispatch) {
      await write({ kind: "dispatch", workflow: this.options.caller_workflow, next: p.dispatch.stage }, () =>
        dispatch(repo, this.options.caller_workflow, defaultBranch(repo), { stage: p.dispatch.stage, number: String(n) }));
    }
    return { success: true, data: { applied } };
  }
}

/** report: append text to the job summary (or stdout locally). For project overlays; stages return data.summary instead. */
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
