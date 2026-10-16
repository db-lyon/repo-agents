// Every config in examples/ loads strictly and plans every flow.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRunner, loadProject } from "../lib/engine.mjs";
import { SPEC_FLOWS } from "./spec-flows.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examples = fs.readdirSync(path.join(root, "examples")).filter((f) => f.endsWith(".yml")).sort();

describe("examples", () => {
  it("has the minimal and ue-mcp configs", () => {
    expect(examples).toEqual(expect.arrayContaining(["minimal.yml", "ue-mcp.yml"]));
  });

  for (const name of examples) {
    it(`${name} loads and plans every flow`, async () => {
      const file = path.join("examples", name);
      const { config } = loadProject({ root, file });
      for (const f of SPEC_FLOWS) expect(Object.keys(config.flows)).toContain(f);
      const { runner } = createRunner({ root, file, hooks: {} });
      for (const flow of Object.keys(config.flows)) {
        const r = await runner.run({ flowName: flow, params: { number: 1, tag: "v1.0.0" }, plan: true });
        expect(r.success, `${name} ${flow}`).toBe(true);
        expect(r.steps.length, `${name} ${flow}`).toBeGreaterThan(0);
      }
    });
  }

  it("ue-mcp closes on release with beta prereleases and draft-and-bump", () => {
    const { settings } = loadProject({ root, file: "examples/ue-mcp.yml" });
    expect(settings.closeout.close_on).toBe("release");
    expect(settings.release).toMatchObject({ bump: "prerelease", preid: "beta", publish: "draft-and-bump" });
    expect(settings.release.notes).toMatchObject({ headline: true, headline_validate: "node scripts/release-headline.mjs", style_doc: "docs/release-notes-style.md" });
    expect(settings.resolve.verify).toEqual(["npx tsc --noEmit", "npm run test:unit", "npm run lint:prose"]);
    expect(settings.resolve.protected_paths).toEqual(["tests/ue_mcp/Plugins/**", ".github/workflows/**"]);
    expect(settings.routing.filter((r) => r.repo).map((r) => r.repo)).toEqual([
      "db-lyon/ue-mcp-studio", "db-lyon/ue-mcp-studio-plugin", "db-lyon/pie-studio", "db-lyon/voxel-plugin-tools",
    ]);
    expect(settings.routing.filter((r) => r.label).map((r) => r.key)).toEqual(["perforce", "meshy", "fab-editor"]);
    expect(settings.triage.skip_maintainers).toBe(true);
    expect(settings.project.context_files).toEqual(["CLAUDE.md"]);
  });

  it("minimal keeps the neutral defaults", () => {
    const { settings } = loadProject({ root, file: "examples/minimal.yml" });
    expect(settings.closeout.close_on).toBe("merge");
    expect(settings.release.enabled).toBe(false);
  });
});
