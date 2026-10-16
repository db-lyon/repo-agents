// Flow wiring, end to end: real flows and planners, with fact-gathering
// tasks stubbed and every GitHub write recorded instead of performed. The
// guards run for real.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseTask } from "@db-lyon/flowkit";
import { createRunner } from "../lib/engine.mjs";

let savedRepo;
beforeAll(() => { savedRepo = process.env.GITHUB_REPOSITORY; process.env.GITHUB_REPOSITORY = "owner/repo"; });
afterAll(() => { if (savedRepo === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = savedRepo; });

/** A task that returns fixed data, or fails. */
function stub(name, result, log = null) {
  return class extends BaseTask {
    get taskName() { return name; }
    async execute() {
      log?.push({ name, options: this.options });
      return typeof result === "function" ? result(this.options) : result;
    }
  };
}

function project(yaml = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-flows-"));
  fs.mkdirSync(path.join(dir, ".github"));
  const file = path.join(dir, ".github", "repo-agents.yml");
  fs.writeFileSync(file, yaml);
  return { root: dir, file };
}

function setup(yaml, stubs) {
  const ops = [];
  const perform = async (op) => { ops.push(op); return { status: 0, stdout: "", stderr: "" }; };
  const r = createRunner({ ...project(yaml), hooks: {}, perform });
  for (const [name, cls] of Object.entries(stubs)) r.registry.register(name, cls);
  return { ...r, ops };
}

const triageFacts = (decision) => ({
  success: true,
  data: {
    go: true,
    agent: { output: decision, cost: 0.05, turns: 3 },
    facts: { issue: { number: 5, state: "open", labels: [] }, duplicate: { number: 3, state: "open", labels: [], isPullRequest: false }, fix: null, canTransfer: false },
    context: { repoLabels: ["bug", "duplicate"], latestRelease: null },
  },
});
const dup = (confidence = "high") => ({ outcome: "duplicate", confidence, kind: "bug", areas: [], summary: "Same as #3.", evidence: "x", duplicateOf: 3 });

describe("triage.apply", () => {
  it("closes a verified duplicate through the guards", async () => {
    const { runner, ops } = setup("", { "triage.facts": stub("triage.facts", triageFacts(dup())) });
    const r = await runner.run({ flowName: "triage.apply", params: { number: 5 } });
    expect(r.success).toBe(true);
    expect(ops.map((o) => o.kind)).toEqual(["label", "unlabel", "comment", "close"]);
    expect(ops[3]).toMatchObject({ stage: "triage", kind: "close", reason: "duplicate", confidence: "high", target: "#5" });
  });

  it("proposes instead of closing in propose mode", async () => {
    const { runner, ops } = setup("", { "triage.facts": stub("triage.facts", triageFacts(dup())) });
    await runner.run({ flowName: "triage.apply", params: { number: 5, mode: "propose" } });
    expect(ops.map((o) => o.kind)).toEqual(["label", "comment"]);
    expect(ops[0].labels).toContain("needs-triage");
  });

  it("writes nothing in dry-run", async () => {
    const { runner, ops } = setup("", { "triage.facts": stub("triage.facts", triageFacts(dup())) });
    const r = await runner.run({ flowName: "triage.apply", params: { number: 5, mode: "dry-run" } });
    expect(r.success).toBe(true);
    expect(ops).toEqual([]);
  });

  it("stops at a project guard and makes no further writes", async () => {
    const yaml = "tasks:\n  guard.hold.beforeClose: { class_path: hold }\n";
    const { runner, ops, writer } = setup(yaml, {
      "triage.facts": stub("triage.facts", triageFacts(dup())),
      hold: stub("hold", { success: false, error: new Error("closes are on hold") }),
    });
    const r = await runner.run({ flowName: "triage.apply", params: { number: 5 } });
    expect(r.success).toBe(false);
    expect(ops.map((o) => o.kind)).toEqual(["label", "unlabel", "comment"]);
    expect(writer.audit.at(-1)).toMatchObject({ kind: "close", outcome: "denied", error: expect.stringContaining("closes are on hold") });
  });

  it("skips an issue the decide job did not triage", async () => {
    const { runner, ops } = setup("", { "triage.facts": stub("triage.facts", { success: true, data: { go: false } }) });
    const r = await runner.run({ flowName: "triage.apply", params: { number: 5 } });
    expect(r.steps.slice(1).every((s) => s.skipped)).toBe(true);
    expect(ops).toEqual([]);
  });
});

describe("resolve.apply", () => {
  const decision = { output: { status: "fixed", summary: "Fixed.", commit_message: "fix: a", pr_title: "fix: a", pr_body: "Body. Fixes #7", risk: "low" } };
  const base = (log) => ({
    "resolve.check": stub("resolve.check", { success: true, data: { go: true, decision, issue: { number: 7, state: "open" }, files: ["src/a.js"], patch: "p" } }),
    "resolve.apply_patch": stub("resolve.apply_patch", { success: true, data: { applied: true, files: ["src/a.js"], error: "" } }),
    "resolve.verify": stub("resolve.verify", { success: true, data: { results: [{ command: "npm test", ok: true }] } }),
    "resolve.commit": stub("resolve.commit", { success: true, data: { sha: "abc" } }),
    "resolve.push": stub("resolve.push", (o) => ({ success: true, data: { created: true }, rollback: { taskName: "resolve.delete_branch", payload: { branch: o.publish.branch } } }), log),
    "resolve.delete_branch": stub("resolve.delete_branch", { success: true }, log),
  });

  it("plans a PR whose text uses no closing keyword", async () => {
    const log = [];
    const { runner } = setup("settings:\n  resolve:\n    verify: [npm test]\n", {
      ...base(log),
      "resolve.open_pr": stub("resolve.open_pr", { success: true, data: { pr: 12, issue_plan: {} } }, log),
    });
    const r = await runner.run({ flowName: "resolve.apply", params: { number: 7 } });
    expect(r.success).toBe(true);
    const publish = log.find((l) => l.name === "resolve.open_pr").options.publish;
    expect(publish).toMatchObject({ branch: "agents/issue-7", draft: false, files: ["src/a.js"] });
    expect(publish.body).toContain("Body. Refs #7");
    expect(publish.body).not.toMatch(/Fixes #7/);
    expect(log.map((l) => l.name)).not.toContain("resolve.delete_branch");
  });

  it("deletes the pushed branch when opening the PR fails", async () => {
    const log = [];
    const { runner } = setup("settings:\n  resolve:\n    verify: [npm test]\n", {
      ...base(log),
      "resolve.open_pr": stub("resolve.open_pr", { success: false, error: new Error("gh pr create failed") }, log),
    });
    const r = await runner.run({ flowName: "resolve.apply", params: { number: 7 } });
    expect(r.success).toBe(false);
    expect(r.rollback).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(log.map((l) => l.name)).toEqual(["resolve.push", "resolve.open_pr", "resolve.delete_branch"]);
    expect(log[2].options.branch).toBe("agents/issue-7");
  });

  it("comments on the issue when the patch touches a protected path", async () => {
    const { runner, ops } = setup("", {
      ...base([]),
      "resolve.check": stub("resolve.check", { success: true, data: { go: false, decision, issue: { number: 7, state: "open" }, files: [".github/workflows/ci.yml"], patch: "p" } }),
    });
    const r = await runner.run({ flowName: "resolve.apply", params: { number: 7 } });
    expect(r.success).toBe(true);
    expect(ops.map((o) => o.kind)).toEqual(["label", "unlabel", "comment"]);
    expect(ops[2].text).toMatch(/protected paths/);
  });
});

describe("release.publish", () => {
  it("deletes the draft when the push fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-notes-"));
    const notes = path.join(dir, "release-notes.md");
    fs.writeFileSync(notes, "Notes.\n");
    const { runner, ops } = setup("settings:\n  release:\n    enabled: true\n    publish: draft-and-bump\n", {
      "release.check_notes": stub("release.check_notes", { success: true, data: { go: true, draft: true, publish: false, tag: "v1.0.1-beta.0", notes_file: notes, branch: "main" } }),
      "release.bump": stub("release.bump", { success: true, data: { sha: "abc123" } }),
      "release.push": stub("release.push", { success: false, error: new Error("push rejected") }),
    });
    const r = await runner.run({ flowName: "release.publish", params: { version: "1.0.1-beta.0" } });
    expect(r.success).toBe(false);
    expect(ops.map((o) => [o.kind, o.target])).toEqual([["release_create", "v1.0.1-beta.0"], ["release_delete", "v1.0.1-beta.0"]]);
  });

  it("publishes the plan as job outputs", async () => {
    const outputs = {};
    const facts = { sha: "abc", default_branch: "main", current: "1.0.0", version: "1.0.1-beta.0", prev_tag: "v1.0.0", shippable: [{ sha: "a", subject: "fix: x" }], workflows: [], draft: "" };
    const { runner } = setup("settings:\n  release:\n    enabled: true\n", { "release.facts": stub("release.facts", { success: true, data: facts }) });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-plan-"));
    const r = await runner.run({ flowName: "release.plan", params: { outdir: dir } });
    expect(r.success).toBe(true);
    Object.assign(outputs, r.steps[1].result.data.outputs);
    expect(outputs).toMatchObject({ enabled: true, should_release: true, version: "1.0.1-beta.0", prev_tag: "v1.0.0", sha: "abc", has_gates: false });
  });
});
