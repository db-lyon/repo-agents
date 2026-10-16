import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULTS, merge } from "../lib/config.mjs";
import { nextVersion, shippableCommits, readVersion, writeVersion, setPackageVersion, commitType } from "../stages/release/version.mjs";
import { buildBody, checkDecision, contributors, decisionSchema } from "../stages/release/body.mjs";

const cfgWith = (release) => merge(DEFAULTS, { release });

describe("nextVersion", () => {
  const pre = { bump: "prerelease", preid: "beta" };
  it("increments a prerelease of the same preid", () => {
    expect(nextVersion("1.4.8-beta.1", pre)).toBe("1.4.8-beta.2");
  });
  it("starts a prerelease on the next patch from a stable", () => {
    expect(nextVersion("1.4.7", pre)).toBe("1.4.8-beta.1");
  });
  it("restarts the counter for a different preid", () => {
    expect(nextVersion("1.4.8-alpha.3", pre)).toBe("1.4.8-beta.1");
  });
  it("bumps and promotes patch", () => {
    expect(nextVersion("1.4.7", { bump: "patch" })).toBe("1.4.8");
    expect(nextVersion("1.4.8-beta.3", { bump: "patch" })).toBe("1.4.8");
  });
  it("bumps minor and major", () => {
    expect(nextVersion("1.4.7", { bump: "minor" })).toBe("1.5.0");
    expect(nextVersion("1.4.7", { bump: "major" })).toBe("2.0.0");
    expect(nextVersion("1.5.0-beta.2", { bump: "minor" })).toBe("1.5.0");
    expect(nextVersion("1.4.8-beta.2", { bump: "minor" })).toBe("1.5.0");
    expect(nextVersion("2.0.0-rc.1", { bump: "major" })).toBe("2.0.0");
  });
  it("skips versions whose tags exist", () => {
    expect(nextVersion("1.4.8-beta.1", pre, ["v1.4.8-beta.2", "v1.4.8-beta.3"])).toBe("1.4.8-beta.4");
    expect(nextVersion("1.4.8-beta.3", { bump: "patch" }, ["v1.4.8"])).toBe("1.4.9");
    expect(nextVersion("1.4.7", { bump: "patch" }, ["1.4.8"])).toBe("1.4.9");
  });
  it("rejects bad input", () => {
    expect(() => nextVersion("one", pre)).toThrow();
    expect(() => nextVersion("1.0.0", { bump: "prerelease" })).toThrow();
    expect(() => nextVersion("1.0.0", { bump: "huge" })).toThrow();
  });
});

describe("shippableCommits", () => {
  it("drops non-shipping conventional types and their merges", () => {
    const lines = [
      "a1 feat(level): add nudge_component",
      "a2 fix: daemon start lock",
      "a3 chore(release): 1.4.8-beta.1",
      "a4 docs: tidy",
      "a5 ci(triage): build patterns",
      "a6 test: more cases",
      "a7 style: format",
      "a8 build: bump deps",
      "a9 Merge pull request #1432 from db-lyon/ci/issue-triage",
      "b1 Merge pull request #1430 from db-lyon/fix/prove-pending",
      "b2 Merge branch 'docs/readme'",
      "b3 Plain subject without a type",
      "b4 refactor!: split handlers",
      "",
    ];
    expect(shippableCommits(lines).map((c) => c.sha)).toEqual(["a1", "a2", "b1", "b3", "b4"]);
  });
  it("accepts git log text and keeps subjects", () => {
    expect(shippableCommits("abc feat: x\ndef chore: y\n")).toEqual([{ sha: "abc", subject: "feat: x" }]);
  });
  it("reads types", () => {
    expect(commitType("Merge pull request #1 from o/chore-deps")).toBe("chore");
    expect(commitType("Merge pull request #1 from o/main")).toBe(null);
  });
});

describe("contributors", () => {
  it("dedupes and drops owner, bots and blanks", () => {
    expect(contributors(["db-lyon", "alice", "alice", "dependabot[bot]", "", "null", "bob"], "db-lyon")).toEqual(["alice", "bob"]);
  });
});

describe("buildBody", () => {
  const plain = cfgWith({});
  const headed = cfgWith({ notes: { headline: true } });

  it("sanitizes a plain body", () => {
    const dash = String.fromCharCode(0x2014);
    const body = buildBody({ decision: { skip: false, body: `## v1.0.0\n\nAdds x ${dash} fast. Thanks @alice and @mallory.` }, cfg: plain, version: "1.0.0", contributors: ["alice"] });
    expect(body).toBe("## v1.0.0\n\nAdds x, fast. Thanks @alice and mallory.\n");
  });
  it("adds headline frontmatter", () => {
    const body = buildBody({ decision: { skip: false, headline: ["Daemon start lock", "Odd: item"], body: "## v1.4.8-beta.2\n\n## Fixes\n\n- Fixed it (#1405)." }, cfg: headed, version: "1.4.8-beta.2" });
    expect(body).toBe('---\nheadline:\n  - Daemon start lock\n  - "Odd: item"\n---\n\n## v1.4.8-beta.2\n\n## Fixes\n\n- Fixed it (#1405).\n');
  });
  it("keeps details and summary blocks", () => {
    const body = buildBody({ decision: { skip: false, body: "<details><summary>Fixes</summary>\n\n- Fixed y.\n\n</details>\n<script>x</script>" }, cfg: plain, version: "1.0.0" });
    expect(body).toBe("<details><summary>Fixes</summary>\n\n- Fixed y.\n\n</details>\nx\n");
  });
  it("rejects missing headline, empty body and skip", () => {
    expect(() => buildBody({ decision: { skip: false, body: "x" }, cfg: headed, version: "1.0.0" })).toThrow(/headline/);
    expect(() => buildBody({ decision: { skip: false, body: " " }, cfg: plain, version: "1.0.0" })).toThrow(/empty/);
    expect(() => buildBody({ decision: { skip: true, body: "" }, cfg: plain, version: "1.0.0" })).toThrow(/skip/);
    expect(checkDecision({ skip: false, headline: ["a\nb"], body: "x" }, headed)).toHaveLength(1);
  });
  it("requires headline in the schema only when configured", () => {
    expect(decisionSchema(plain).required).not.toContain("headline");
    expect(decisionSchema(headed).required).toContain("headline");
  });
});

describe("package.json version", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ra-release-"));

  it("round trips and keeps formatting", () => {
    const dir = tmp();
    const text = '{\r\n    "name": "x",\r\n    "version": "1.4.7",\r\n    "engines": { "node": ">=20" },\r\n    "dependencies": {\r\n        "y": { "version": "9.9.9" }\r\n    }\r\n}\r\n';
    fs.writeFileSync(path.join(dir, "package.json"), text);
    const cfg = cfgWith({});
    expect(readVersion(cfg, dir)).toBe("1.4.7");
    writeVersion(cfg, dir, "1.4.8-beta.1");
    expect(readVersion(cfg, dir)).toBe("1.4.8-beta.1");
    expect(fs.readFileSync(path.join(dir, "package.json"), "utf8")).toBe(text.replace('"1.4.7"', '"1.4.8-beta.1"'));
  });
  it("handles a nested version_file and missing trailing newline", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "pkg"));
    fs.writeFileSync(path.join(dir, "pkg", "package.json"), '{\n  "version": "0.1.0"\n}');
    const cfg = cfgWith({ version_file: "pkg/package.json" });
    writeVersion(cfg, dir, "0.1.1");
    expect(fs.readFileSync(path.join(dir, "pkg", "package.json"), "utf8")).toBe('{\n  "version": "0.1.1"\n}');
  });
  it("adds a version to minified or versionless files", () => {
    expect(setPackageVersion('{"name":"x"}', "1.0.0")).toBe('{"name":"x","version":"1.0.0"}');
    expect(setPackageVersion('{\n  "name": "x"\n}\n', "1.0.0")).toBe('{\n  "name": "x",\n  "version": "1.0.0"\n}\n');
  });
  it("rejects a non-semver write", () => {
    expect(() => writeVersion(cfgWith({}), tmp(), "latest")).toThrow();
  });
  it("uses version_command for other files", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "VERSION"), "2.0.0\n");
    const cfg = cfgWith({ version_file: "VERSION", version_command: "if [ -n \"{version}\" ]; then echo {version} > VERSION; else cat VERSION; fi" });
    expect(readVersion(cfg, dir)).toBe("2.0.0");
    writeVersion(cfg, dir, "2.0.1");
    expect(fs.readFileSync(path.join(dir, "VERSION"), "utf8").trim()).toBe("2.0.1");
  });
});

import { compareVersions } from "../stages/release/version.mjs";
import { decidePlan, pendingDraft, workflowCheck } from "../stages/release/plan.mjs";
import { ReleaseGates } from "../tasks/release.mjs";
import { createRunner } from "../lib/engine.mjs";

describe("compareVersions", () => {
  it("orders by semver precedence", () => {
    const sorted = ["1.4.8", "1.4.8-beta.10", "1.4.7", "1.4.8-beta.2", "1.4.8-alpha.1", "1.5.0"].sort(compareVersions);
    expect(sorted).toEqual(["1.4.7", "1.4.8-alpha.1", "1.4.8-beta.2", "1.4.8-beta.10", "1.4.8", "1.5.0"]);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });
});

describe("pendingDraft", () => {
  const rel = (tagName, isDraft = false) => ({ tagName, isDraft });
  it("blocks on a draft newer than the latest published release", () => {
    expect(pendingDraft([rel("v1.4.8-beta.1", true), rel("v1.4.7")], "1.4.8-beta.2")).toBe("v1.4.8-beta.1");
  });
  it("blocks on a draft for the computed version", () => {
    expect(pendingDraft([rel("v1.4.8", true), rel("v1.4.9")], "1.4.8")).toBe("v1.4.8");
  });
  it("ignores stale drafts and drafts without a semver tag", () => {
    expect(pendingDraft([rel("v1.4.6", true), rel("notes", true), rel("v1.4.7")], "1.4.8")).toBe(null);
  });
  it("blocks on any draft when nothing is published", () => {
    expect(pendingDraft([rel("v0.1.0", true)], "0.2.0")).toBe("v0.1.0");
  });
});

describe("workflowCheck", () => {
  const sha = "abcdef1234567890";
  it("needs a completed successful run on the sha", () => {
    expect(workflowCheck("CI", [{ headSha: sha, status: "completed", conclusion: "success" }], sha).ok).toBe(true);
    expect(workflowCheck("CI", [{ headSha: "other", status: "completed", conclusion: "success" }], sha).reason).toMatch(/no run/);
    expect(workflowCheck("CI", [{ headSha: sha, status: "in_progress", conclusion: "" }], sha).reason).toMatch(/still in_progress/);
    expect(workflowCheck("CI", [{ headSha: sha, status: "completed", conclusion: "failure" }, { headSha: sha, status: "completed", conclusion: "success" }], sha).ok).toBe(false);
    expect(workflowCheck("CI", null, sha).ok).toBe(false);
  });
});

describe("decidePlan", () => {
  const base = { enabled: true, shippable: 2, minChanges: 1, force: false, version: "1.0.1" };
  it("releases when there is something to ship", () => {
    expect(decidePlan(base)).toMatchObject({ should_release: true });
  });
  it("refuses when disabled, drafted, red or empty", () => {
    expect(decidePlan({ ...base, enabled: false }).should_release).toBe(false);
    expect(decidePlan({ ...base, draft: "v1.0.1" }).reason).toMatch(/draft release v1.0.1/);
    expect(decidePlan({ ...base, workflows: [{ ok: false, reason: "CI concluded failure" }] }).reason).toBe("CI concluded failure");
    expect(decidePlan({ ...base, shippable: 0 }).should_release).toBe(false);
  });
  it("force overrides only the change count", () => {
    expect(decidePlan({ ...base, shippable: 0, force: true }).reason).toMatch(/forced/);
    expect(decidePlan({ ...base, shippable: 0, force: true, draft: "v1.0.1" }).should_release).toBe(false);
  });
});

describe("release flows", () => {
  it("expands one shell step per gate", () => {
    expect(ReleaseGates.expand({ commands: ["npm test", "npm run lint"] })).toEqual([
      { task: "shell", options: { command: "npm test" } },
      { task: "shell", options: { command: "npm run lint" } },
    ]);
  });
  it("plans every release flow", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-flows-"));
    fs.mkdirSync(path.join(dir, ".github"));
    fs.writeFileSync(path.join(dir, ".github", "repo-agents.yml"), "settings:\n  release:\n    enabled: true\n    gates: [npm test]\n");
    const { runner, settings } = createRunner({ root: dir, file: path.join(dir, ".github", "repo-agents.yml") });
    expect(settings.release.gates).toEqual(["npm test"]);
    for (const flowName of ["release.plan", "release.gate", "release.notes", "release.publish"]) {
      const res = await runner.run({ flowName, plan: true, params: { version: "1.0.1", outdir: dir } });
      expect(res.success, flowName).toBe(true);
    }
  });
});
