import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TaskRegistry } from "@db-lyon/flowkit";
import { DEFAULTS, merge } from "../lib/config.mjs";
import { WriteDenied, createWriter } from "../lib/write.mjs";

const cfg = (over = {}) => merge(DEFAULTS, over);
const done = () => "ok";

async function attempt(op, settings = cfg(), opts = {}) {
  const w = createWriter({ settings, ...opts });
  try {
    await w.write(op, done);
    return { ok: true, audit: w.audit };
  } catch (e) {
    if (!(e instanceof WriteDenied)) throw e;
    return { ok: false, guard: e.guard, reason: e.reason, audit: w.audit };
  }
}

describe("write seam", () => {
  it("runs an allowed write and audits it", async () => {
    const r = await attempt({ stage: "triage", kind: "label", target: "#1" });
    expect(r.ok).toBe(true);
    expect(r.audit).toEqual([expect.objectContaining({ stage: "triage", kind: "label", target: "#1", outcome: "done" })]);
  });

  it("rejects an unknown kind", async () => {
    await expect(createWriter({ settings: cfg() }).write({ stage: "triage", kind: "nuke" }, done)).rejects.toThrow(/unknown write kind/);
  });

  it("dry-run denies everything; propose denies close, transfer and merge", async () => {
    expect((await attempt({ stage: "triage", kind: "comment", text: "hi", mode: "dry-run" })).guard).toBe("mode");
    expect((await attempt({ stage: "triage", kind: "comment", text: "hi", mode: "propose" })).ok).toBe(true);
    const close = await attempt({ stage: "triage", kind: "close", reason: "duplicate", confidence: "high", mode: "propose" });
    expect(close.guard).toBe("mode");
    expect((await attempt({ stage: "triage", kind: "label" }, cfg({ triage: { mode: "dry-run" } }))).guard).toBe("mode");
  });

  it("caps writes per run", async () => {
    const w = createWriter({ settings: cfg({ limits: { writes_per_run: 2 } }) });
    await w.write({ stage: "triage", kind: "label" }, done);
    await w.write({ stage: "triage", kind: "label" }, done);
    await expect(w.write({ stage: "triage", kind: "label" }, done)).rejects.toThrow(/rate/);
    expect(w.audit.map((a) => a.outcome)).toEqual(["done", "done", "denied"]);
  });

  it("needs high confidence for agent closes, transfers, merges and approvals", async () => {
    expect((await attempt({ stage: "triage", kind: "close", reason: "duplicate", confidence: "medium" })).guard).toBe("confidence");
    expect((await attempt({ stage: "triage", kind: "transfer" })).guard).toBe("confidence");
    expect((await attempt({ stage: "review", kind: "review", event: "APPROVE", text: "ok", confidence: "low" })).guard).toBe("confidence");
    expect((await attempt({ stage: "review", kind: "review", event: "COMMENT", text: "ok", confidence: "low" })).ok).toBe(true);
    expect((await attempt({ stage: "triage", kind: "close", reason: "duplicate", confidence: "high" })).ok).toBe(true);
  });

  it("closes as completed only with a fix in a stable release", async () => {
    const op = { stage: "triage", kind: "close", reason: "completed", confidence: "high" };
    expect((await attempt(op)).guard).toBe("close_policy");
    expect((await attempt({ ...op, releasedIn: "v1.2.0" })).ok).toBe(true);
    expect((await attempt({ ...op, reason: "not_planned" })).ok).toBe(true);
  });

  it("keeps resolve pushes on the agent prefix and off the default branch", async () => {
    const push = { stage: "resolve", kind: "push", branch: "agents/issue-7", defaultBranch: "main", files: ["src/a.js"], text: "fix: a" };
    expect((await attempt(push)).ok).toBe(true);
    expect((await attempt({ ...push, branch: "main" })).guard).toBe("push_targets");
    expect((await attempt({ ...push, branch: "feature/x" })).guard).toBe("push_targets");
    expect((await attempt({ stage: "release", kind: "push", branch: "main", defaultBranch: "main" })).ok).toBe(true);
    expect((await attempt({ stage: "resolve", kind: "delete_branch", branch: "main", defaultBranch: "main" })).guard).toBe("push_targets");
  });

  it("denies a resolve push touching protected paths", async () => {
    const r = await attempt({ stage: "resolve", kind: "push", branch: "agents/issue-7", defaultBranch: "main", files: [".github/workflows/ci.yml"] });
    expect(r.guard).toBe("paths");
  });

  it("merges only what the merge policy covers", async () => {
    const pr = { number: 4, isDraft: false, isCrossRepository: false, headRefName: "agents/issue-7", labels: [], files: ["src/a.js"] };
    const merge = { stage: "review", kind: "merge", confidence: "high", pr };
    expect((await attempt(merge)).ok).toBe(true);
    expect((await attempt({ ...merge, pr: { ...pr, isDraft: true } })).guard).toBe("merge_policy");
    expect((await attempt({ ...merge, pr: { ...pr, headRefName: "feature" } })).guard).toBe("merge_policy");
    expect((await attempt(merge, cfg({ review: { human_paths: ["src/**"] } }))).reason).toMatch(/need a human/);
    expect((await attempt(merge, cfg({ resolve: { unverifiable_paths: ["src/**"] } }))).reason).toMatch(/native/);
    expect((await attempt({ ...merge, pr: undefined })).guard).toBe("merge_policy");
  });

  it("denies banned text and closing keywords in public prose, not in fenced output", async () => {
    const settings = cfg({ project: { banned_phrases: ["Acme"] } });
    expect((await attempt({ stage: "triage", kind: "comment", text: "Try acme instead." }, settings)).guard).toBe("prose");
    expect((await attempt({ stage: "triage", kind: "comment", text: `a ${String.fromCharCode(0x2014)} b` })).guard).toBe("prose");
    expect((await attempt({ stage: "resolve", kind: "pr_create", text: "Body\n\nFixes #7" })).guard).toBe("prose");
    expect((await attempt({ stage: "resolve", kind: "pr_create", text: "Body\n\nRefs #7" })).ok).toBe(true);
    expect((await attempt({ stage: "resolve", kind: "pr_create", text: "Fixes #7" }, cfg({ closeout: { close_on: "merge" } }))).ok).toBe(true);
    const log = `Refs #7\n\n\`\`\`\nexpected Acme ${String.fromCharCode(0x2026)}\n\`\`\``;
    expect((await attempt({ stage: "resolve", kind: "pr_create", text: log }, settings)).ok).toBe(true);
  });

  it("never calls invoke when a guard denies", async () => {
    let called = false;
    const w = createWriter({ settings: cfg() });
    await expect(w.write({ stage: "triage", kind: "close", reason: "completed", confidence: "high" }, () => { called = true; })).rejects.toThrow(WriteDenied);
    expect(called).toBe(false);
  });

  it("loads project guard tasks from config, scoped by kind", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-guard-"));
    fs.writeFileSync(path.join(dir, "guard.mjs"), [
      'import { BaseTask } from "@db-lyon/flowkit";',
      "export default class NoClose extends BaseTask {",
      '  get taskName() { return "guard.no_close.beforeClose"; }',
      '  async execute() { return { success: false, error: new Error(`no closes on ${this.options.op.target}`) }; }',
      "}",
    ].join("\n"));
    const tasks = { "guard.no_close.beforeClose": { class_path: "./guard.mjs" } };
    const opts = { registry: new TaskRegistry(), tasks, root: dir };
    const denied = await attempt({ stage: "triage", kind: "close", reason: "duplicate", confidence: "high", target: "#9" }, cfg(), opts);
    expect(denied).toMatchObject({ ok: false, guard: "no_close", reason: "no closes on #9" });
    expect((await attempt({ stage: "triage", kind: "label", target: "#9" }, cfg(), { ...opts, registry: new TaskRegistry() })).ok).toBe(true);
  });

  it("refuses a project guard with an unknown scope", async () => {
    const reg = new TaskRegistry();
    const w = createWriter({ settings: cfg(), registry: reg, tasks: { "guard.x.beforeDeploy": { class_path: "report" } } });
    reg.register("report", class { constructor() {} });
    await expect(w.write({ stage: "triage", kind: "label" }, done)).rejects.toThrow(/scope 'deploy'/);
  });
});
