import { describe, it, expect } from "vitest";
import { DEFAULTS, validate } from "../lib/config.mjs";
import { CALLER_PATH, CONFIG_PATH, labelNames, planInstall, starterConfig } from "../lib/install.mjs";

const settings = validate(DEFAULTS);
const base = { labels: new Set(), files: new Set(), secrets: new Set(), workflowPermissions: {}, allowAutoMerge: false, openInstallPr: null };

describe("install", () => {
  it("covers every label the stages write", () => {
    const names = labelNames(settings);
    for (const l of ["triaged", "needs-triage", "fixed-pending-release", "agent-working", "agents"]) expect(names).toContain(l);
    expect(names).not.toContain("bug");
  });

  it("plans everything on a bare repository", () => {
    const p = planInstall(settings, base);
    expect(p.steps.map((s) => s.kind)).toEqual([...labelNames(settings).map(() => "label"), "allow_actions_approve", "allow_auto_merge", "pull_request"]);
    expect(p.steps.at(-1).files).toEqual([CALLER_PATH, CONFIG_PATH]);
    expect(p.missing).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("plans nothing on a repository that is already set up", () => {
    const p = planInstall(settings, { ...base, labels: new Set(labelNames(settings)), files: new Set([CALLER_PATH, CONFIG_PATH]), secrets: new Set(["ANTHROPIC_API_KEY", "REPO_AGENTS_TOKEN"]), workflowPermissions: { can_approve_pull_request_reviews: true }, allowAutoMerge: true });
    expect(p).toEqual({ steps: [], missing: [], optional: [], pending: null });
  });

  it("does not open a second install pull request", () => {
    const p = planInstall(settings, { ...base, openInstallPr: "https://github.com/o/r/pull/9" });
    expect(p.steps.some((s) => s.kind === "pull_request")).toBe(false);
    expect(p.pending).toBe("https://github.com/o/r/pull/9");
  });

  it("writes a starter config that loads", async () => {
    const YAML = (await import("yaml")).default;
    const text = starterConfig({ name: "demo", description: "Demo owns the API." });
    expect(YAML.parse(text).settings.project).toMatchObject({ name: "demo", description: "Demo owns the API." });
  });
});
