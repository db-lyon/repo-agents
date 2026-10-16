// The CLI contract the action suite depends on, run as a real process from a
// project directory, the way run-flow calls it.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { logText } from "../lib/engine.mjs";
import { SPEC_FLOWS } from "./spec-flows.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");


function projectDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-cli-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function cli(args, { cwd = projectDir(), env = {} } = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("REPO_AGENTS_") && k !== "GITHUB_STEP_SUMMARY" && k !== "GITHUB_OUTPUT"));
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...clean, GITHUB_REPOSITORY: "owner/repo", ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("repo-agents CLI", () => {
  it("lists every flow the actions call", () => {
    const r = cli(["flows"]);
    expect(r.code).toBe(0);
    const names = r.out.split("\n").filter(Boolean).map((l) => l.split(/\s+/)[0]);
    for (const f of SPEC_FLOWS) expect(names).toContain(f);
  });

  it("plans a flow without running it", () => {
    const r = cli(["run", "triage.apply", "--param", "number=3", "--plan"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/10\s+triage\.facts\s+planned/);
    expect(r.out).not.toMatch(/object Object/);
  });

  it("prints the merged settings, reading the config from REPO_AGENTS_CONFIG", () => {
    const cwd = projectDir({ "ci/agents.yml": "settings:\n  triage:\n    mode: propose\n" });
    const r = cli(["settings"], { cwd, env: { REPO_AGENTS_CONFIG: "ci/agents.yml" } });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).triage.mode).toBe("propose");
    expect(JSON.parse(cli(["settings"], { cwd }).out).triage.mode).toBe("act");
  });

  it("loads .github/repo-agents.yml by default and fails on a typo in it", () => {
    const cwd = projectDir({ ".github/repo-agents.yml": "settings:\n  triage:\n    mdoe: act\n" });
    const r = cli(["flows"], { cwd });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/mdoe/);
  });

  it("preflights a flow: exit 0 when it would run, and reports a skip check", () => {
    expect(cli(["preflight", "triage.apply", "--param", "number=3"]).code).toBe(0);
    const r = cli(["preflight", "release.publish"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/release is disabled in settings/);
  });

  it("refuses an unknown command or flow with exit 2", () => {
    expect(cli([]).code).toBe(2);
    expect(cli(["deploy"]).code).toBe(2);
    const r = cli(["run", "triage.nope", "--plan"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown flow triage\.nope/);
    expect(cli(["help"]).out).toMatch(/REPO_AGENTS_WORK/);
  });
});

describe("log text", () => {
  it("drops a leading bindings object and keeps the message", () => {
    expect(logText([{ task: "x" }, "Running task x"])).toBe("Running task x");
    expect(logText(["a", 2])).toBe("a 2");
    expect(logText([new Error("boom")])).toBe("boom");
  });
});
