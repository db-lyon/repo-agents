import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseTask } from "@db-lyon/flowkit";
import { DEFAULTS, merge } from "../lib/config.mjs";
import { createRunner } from "../lib/engine.mjs";
import {
  CLOSE_MARKER, PRERELEASE_MARKER, citedShas, classify, closingComment, mergedComment, planMerged, planReleased, prereleaseComment, referencedIssues,
} from "../stages/closeout/logic.mjs";

const cfg = (over = {}) => merge(DEFAULTS, over);

describe("closeout classify", () => {
  const inTag = (c) => c.startsWith("in");
  it("is released only when every fix commit is in the tag", () => {
    expect(classify(["in1", "in2"], inTag)).toBe("released");
    expect(classify(["in1", "out"], inTag)).toBe("partial");
    expect(classify(["out"], inTag)).toBe("pending");
    expect(classify([], inTag)).toBe("unknown");
  });
});

describe("closeout citedShas", () => {
  it("finds commit-like hex and skips words, numbers and issue refs", () => {
    expect(citedShas("Fixed in 070ed7e5 and b8af5fce (#1239), released in v1.3.10. deadbeef 12345678 #abc1234 org/abc1234")).toEqual(["070ed7e5", "b8af5fce"]);
  });
});

describe("closeout comments", () => {
  it("cite short SHAs, the version and the PR", () => {
    expect(closingComment("v1.4.8", ["0123456789abcdef", "fedcba9876543210"])).toBe("Fixed in 01234567, fedcba98, released in v1.4.8.");
    expect(prereleaseComment("v1.4.8-rc.1", ["0123456789abcdef"])).toBe("Available in v1.4.8-rc.1 (fix: 01234567). This issue closes when a stable release ships the fix.");
    expect(prereleaseComment("v1.4.8-rc.1", ["0123456789abcdef"], "npm i x@next")).toContain("Install it with `npm i x@next`.");
    expect(mergedComment(12, "0123456789abcdef")).toBe("Fixed by #12 (01234567).");
    expect(mergedComment(12, "")).toBe("Fixed by #12.");
  });
});

describe("closeout referencedIssues", () => {
  it("reads closing keywords and Refs in this repository, not bare mentions or other repos", () => {
    const text = "Fixes #3. closes: owner/repo#4\nRefs #5, see #6\nResolved other/repo#7\nfix #3";
    expect(referencedIssues(text, "owner/repo")).toEqual([3, 4, 5]);
    expect(referencedIssues("Fixed #12a and ref #9", "owner/repo")).toEqual([9]);
  });
});

const issue = (number, over = {}) => ({ number, title: `issue ${number}`, state: "open", labels: [], isPullRequest: false, ...over });

describe("closeout planMerged", () => {
  const pr = { number: 20, mergeCommit: "abcdef1234567890" };
  it("closes referenced issues citing the PR when issues close on merge", () => {
    const p = planMerged({ pr, issues: [issue(3, { labels: ["fixed-pending-release"] }), issue(4, { state: "closed" }), issue(20), issue(5, { isPullRequest: true })], settings: cfg() });
    expect(p.items).toEqual([{ number: 3, remove: ["fixed-pending-release"], comment: "Fixed by #20 (abcdef12).", marker: CLOSE_MARKER, close: "completed", fixedIn: "#20" }]);
    expect(p.lines).toEqual(["- #3 closed. issue 3", "- #4 already closed. issue 4"]);
  });

  it("labels them fixed_pending when issues close on release", () => {
    const p = planMerged({ pr, issues: [issue(3), issue(4, { labels: ["fixed-pending-release"] })], settings: cfg({ closeout: { close_on: "release" } }) });
    expect(p.items).toEqual([{ number: 3, add: ["fixed-pending-release"] }]);
    expect(p.lines[1]).toMatch(/#4 already labeled/);
  });
});

describe("closeout planReleased", () => {
  const issues = [
    { number: 1, title: "a", commits: ["1111111aaaa"], state: "released", announced: false },
    { number: 2, title: "b", commits: [], state: "unknown", announced: false },
    { number: 3, title: "c", commits: ["3333333cccc"], state: "released", announced: true },
  ];
  it("closes released issues on a stable tag", () => {
    const p = planReleased({ tag: "v2.0.0", release: { isPrerelease: false }, issues, settings: cfg() });
    expect(p.items.map((i) => [i.number, i.close, i.releasedIn])).toEqual([[1, "completed", "v2.0.0"], [3, "completed", "v2.0.0"]]);
    expect(p.items[0]).toMatchObject({ remove: ["fixed-pending-release"], comment: "Fixed in 1111111a, released in v2.0.0.", marker: CLOSE_MARKER });
    expect(p.lines).toContain("- #2 unknown: no fix commit found. b");
  });

  it("announces once on a prerelease, and not at all when announcements are off", () => {
    const p = planReleased({ tag: "v2.0.0-rc.1", release: { isPrerelease: true }, issues, settings: cfg() });
    expect(p.items).toEqual([expect.objectContaining({ number: 1, marker: PRERELEASE_MARKER })]);
    expect(p.items[0].close).toBeUndefined();
    expect(planReleased({ tag: "v2.0.0-rc.1", release: { isPrerelease: true }, issues, settings: cfg({ closeout: { announce_prereleases: false } }) }).items).toEqual([]);
  });
});

// Flows, with the fact tasks stubbed and writes recorded; plans, guards and apply run for real.
let savedRepo;
beforeAll(() => { savedRepo = process.env.GITHUB_REPOSITORY; process.env.GITHUB_REPOSITORY = "owner/repo"; });
afterAll(() => { if (savedRepo === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = savedRepo; });

function stub(name, result) {
  return class extends BaseTask {
    get taskName() { return name; }
    async execute() { return result; }
  };
}

function setup(yaml, stubs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-closeout-"));
  fs.mkdirSync(path.join(dir, ".github"));
  const file = path.join(dir, ".github", "repo-agents.yml");
  fs.writeFileSync(file, yaml);
  const ops = [];
  const r = createRunner({ root: dir, file, hooks: {}, perform: async (op) => { ops.push(op); } });
  for (const [name, cls] of Object.entries(stubs)) r.registry.register(name, cls);
  return { ...r, ops };
}

const prFacts = { success: true, data: { go: true, pr: { number: 20, mergeCommit: "abcdef1234567890" }, issues: [issue(3, { labels: ["fixed-pending-release"] })] } };
const releaseFacts = (isPrerelease) => ({ success: true, data: { go: true, release: { isPrerelease }, issues: [{ number: 3, title: "c", commits: ["3333333cccc"], state: "released", announced: false }] } });

describe("closeout.merged", () => {
  it("closes the PR's issues through the guards", async () => {
    const { runner, ops } = setup("", { "closeout.pr_facts": stub("closeout.pr_facts", prFacts) });
    const r = await runner.run({ flowName: "closeout.merged", params: { number: 20 } });
    expect(r.success).toBe(true);
    expect(ops.map((o) => o.kind)).toEqual(["unlabel", "comment", "close"]);
    expect(ops[2]).toMatchObject({ stage: "closeout", target: "#3", reason: "completed", fixedIn: "#20" });
  });

  it("labels instead when issues close on release", async () => {
    const { runner, ops } = setup("settings:\n  closeout:\n    close_on: release\n", {
      "closeout.pr_facts": stub("closeout.pr_facts", { ...prFacts, data: { ...prFacts.data, issues: [issue(3)] } }),
    });
    await runner.run({ flowName: "closeout.merged", params: { number: 20 } });
    expect(ops).toEqual([expect.objectContaining({ kind: "label", labels: ["fixed-pending-release"], target: "#3" })]);
  });

  it("skips an unmerged PR and writes nothing in dry-run", async () => {
    const a = setup("", { "closeout.pr_facts": stub("closeout.pr_facts", { success: true, data: { go: false } }) });
    const r = await a.runner.run({ flowName: "closeout.merged", params: { number: 20 } });
    expect(r.steps.slice(1).every((s) => s.skipped)).toBe(true);
    expect(a.ops).toEqual([]);
    const b = setup("settings:\n  closeout:\n    mode: dry-run\n", { "closeout.pr_facts": stub("closeout.pr_facts", prFacts) });
    expect((await b.runner.run({ flowName: "closeout.merged", params: { number: 20 } })).success).toBe(false);
    expect(b.ops).toEqual([]);
    expect(b.writer.audit[0]).toMatchObject({ outcome: "denied" });
  });
});

describe("closeout.released", () => {
  it("closes on a stable release, citing the version", async () => {
    const { runner, ops } = setup("settings:\n  closeout:\n    close_on: release\n", { "closeout.release_facts": stub("closeout.release_facts", releaseFacts(false)) });
    const r = await runner.run({ flowName: "closeout.released", params: { tag: "v2.0.0" } });
    expect(r.success).toBe(true);
    expect(ops.map((o) => o.kind)).toEqual(["unlabel", "comment", "close"]);
    expect(ops[2]).toMatchObject({ releasedIn: "v2.0.0" });
  });

  it("only comments on a prerelease", async () => {
    const { runner, ops } = setup("settings:\n  closeout:\n    close_on: release\n", { "closeout.release_facts": stub("closeout.release_facts", releaseFacts(true)) });
    await runner.run({ flowName: "closeout.released", params: { tag: "v2.0.0-rc.1" } });
    expect(ops.map((o) => o.kind)).toEqual(["comment"]);
  });

  it("is skipped when closeout is disabled", async () => {
    const { runner } = setup("settings:\n  closeout:\n    enabled: false\n", {});
    const pf = await runner.preflight("closeout.released", { tag: "v1.0.0" });
    expect(pf.checks.filter((c) => c.triggered).map((c) => c.message)).toEqual(["closeout is disabled in settings"]);
  });
});

describe("closeout planMerged working labels", () => {
  const pr = { number: 20, mergeCommit: "abcdef1234567890" };
  it("drops the agent-working and resolve labels once the fix merges", () => {
    const p = planMerged({ pr, issues: [issue(3, { labels: ["agent-working", "bug"] })], settings: cfg({ closeout: { close_on: "release" } }) });
    expect(p.items).toEqual([{ number: 3, add: ["fixed-pending-release"], remove: ["agent-working"] }]);
    const q = planMerged({ pr, issues: [issue(3, { labels: ["agent-working", "resolve"] })], settings: cfg() });
    expect(q.items[0].remove).toEqual(["agent-working", "resolve"]);
  });
});
