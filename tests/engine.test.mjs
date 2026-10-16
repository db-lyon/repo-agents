import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULTS, merge, validate } from "../lib/config.mjs";
import { createRunner, evaluateCondition, loadProject } from "../lib/engine.mjs";
import { auditTable, createHooks } from "../lib/hooks.mjs";
import { neutralizeClosers } from "../lib/text.mjs";
import { parseArgs, stepLines } from "../lib/cli.mjs";

function project(yaml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-engine-"));
  fs.mkdirSync(path.join(dir, ".github"));
  const file = path.join(dir, ".github", "repo-agents.yml");
  fs.writeFileSync(file, yaml);
  return { root: dir, file };
}

describe("settings", () => {
  it("loads the defaults from flows/settings.yml", () => {
    expect(DEFAULTS.triage.mode).toBe("act");
    expect(DEFAULTS.limits.writes_per_run).toBe(40);
    expect(loadProject({ root: os.tmpdir(), file: "does-not-exist.yml" }).settings.review.merge_method).toBe("squash");
  });

  it("merges a project's overrides", () => {
    const { settings } = loadProject(project("settings:\n  triage:\n    mode: propose\n"));
    expect(settings.triage.mode).toBe("propose");
    expect(settings.triage.model).toBe(DEFAULTS.triage.model);
  });

  it("rejects an unknown settings key with a suggestion", () => {
    expect(() => loadProject(project("settings:\n  triage:\n    mdoe: propose\n"))).toThrow(/settings\.triage\.mdoe.*mode/s);
  });

  it("rejects an unknown flow step key", () => {
    expect(() => loadProject(project("flows:\n  triage.apply:\n    steps:\n      10:\n        ignore_failur: true\n"))).toThrow(/ignore_failur/);
  });

  it("rejects a closing issue_ref when issues close on release", () => {
    expect(() => validate(merge(DEFAULTS, { resolve: { issue_ref: "Closes" } }))).toThrow(/issue_ref/);
    expect(validate(merge(DEFAULTS, { resolve: { issue_ref: "Closes" }, closeout: { close_on: "merge" } })).resolve.issue_ref).toBe("Closes");
  });

  it("lets an overlay insert a step and switch one off", async () => {
    const p = project([
      "tasks:",
      "  extra: { class_path: report, options: { text: hi } }",
      "flows:",
      "  triage.apply:",
      "    steps:",
      "      15: { task: extra }",
      "      30: { task: None }",
    ].join("\n"));
    const { runner } = createRunner({ ...p, hooks: {} });
    const r = await runner.run({ flowName: "triage.apply", params: { number: 1 }, plan: true });
    expect(r.steps.map((s) => [s.name, Boolean(s.skipped)])).toEqual([
      ["triage.facts", false], ["extra", false], ["triage.plan", false], ["None", true],
    ]);
  });
});

describe("conditions", () => {
  const refs = { settings: { on: true, off: false, list: [] } };
  it("resolves references and negates", () => {
    expect(evaluateCondition("${settings.on}", { references: refs })).toBe(true);
    expect(evaluateCondition("!${settings.on}", { references: refs })).toBe(false);
    expect(evaluateCondition("not ${settings.off}", { references: refs })).toBe(true);
    expect(evaluateCondition("${settings.list}", { references: refs })).toBe(false);
    expect(evaluateCondition("${steps.10.go}", { steps: [{ stepNumber: 10, name: "x", result: { data: { go: "false" } } }] })).toBe(false);
  });

  it("skips a disabled stage's flows with a reason", async () => {
    const { runner } = createRunner({ ...project("settings:\n  review:\n    enabled: false\n"), hooks: {} });
    const r = await runner.run({ flowName: "review.apply", params: { number: 1 } });
    expect(r.success).toBe(true);
    expect(r.steps.every((s) => s.skipped && s.skipReason === "check")).toBe(true);
    expect(r.checks).toEqual([expect.objectContaining({ triggered: true, message: "review is disabled in settings" })]);
  });

  it("preflights a disabled stage without running it", async () => {
    const { runner } = createRunner({ ...project("settings:\n  release:\n    enabled: false\n"), hooks: {} });
    const pf = await runner.preflight("release.publish", { version: "1.0.0" });
    expect(pf.checks.filter((c) => c.triggered).map((c) => c.message)).toEqual(["release is disabled in settings"]);
  });
});

describe("hooks", () => {
  const capture = () => {
    const out = { lines: [], outputs: {} };
    out.summary = (t) => out.lines.push(t);
    out.setOutput = (k, v) => { out.outputs[k] = v; };
    return out;
  };

  it("routes data.summary and data.outputs, and reports failures", async () => {
    const out = capture();
    const hooks = createHooks({ out });
    await hooks.afterStep({ name: "a" }, { result: { success: true, data: { summary: "hello", outputs: { version: "1.0.1", ok: true } } } });
    await hooks.afterStep({ name: "b" }, { ignoredFailure: true, result: { success: false, error: new Error("boom") } });
    await hooks.afterStep({ name: "c" }, { skipped: true });
    expect(out.lines).toEqual(["hello", "**b** failed (ignored): boom"]);
    expect(out.outputs).toEqual({ version: "1.0.1", ok: true });
  });

  it("writes fired checks and the audit trail", async () => {
    const out = capture();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-audit-"));
    const writer = { audit: [{ stage: "triage", kind: "close", target: "#3", outcome: "denied", error: "denied by mode: x | y" }] };
    await createHooks({ writer, outdir: dir, out }).afterRun({ checks: [{ triggered: true, flowName: "f", message: "off" }] });
    expect(out.lines[0]).toBe("> f: off");
    expect(out.lines[1]).toContain("| triage | close | #3 | denied: denied by mode: x / y |");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "audit.json"), "utf8"))).toEqual(writer.audit);
    expect(auditTable([])).toBe("");
  });
});

describe("text", () => {
  it("turns closing keywords into plain references", () => {
    expect(neutralizeClosers("Fixes #12. Closes: owner/repo#3. Resolved #4")).toBe("Refs #12. Refs owner/repo#3. Refs #4");
    expect(neutralizeClosers("fixed the bug in #x, prefix #4")).toBe("fixed the bug in #x, prefix #4");
  });
});

describe("cli", () => {
  it("parses params and formats steps", () => {
    expect(parseArgs(["run", "triage.apply", "--param", "number=12", "-p", "mode=propose", "--plan"]))
      .toEqual({ command: "run", flow: "triage.apply", params: { number: 12, mode: "propose" }, plan: true });
    expect(stepLines([{ stepNumber: 10, name: "a", skipped: true, skipReason: "when" }, { path: "20", name: "b", status: "error", checks: [{ triggered: true, action: "error", message: "no" }] }]))
      .toEqual([`${"10".padEnd(6)} ${"a".padEnd(28)} skipped (when)`, `${"20".padEnd(6)} ${"b".padEnd(28)} error`, "       error: no"]);
  });
});
