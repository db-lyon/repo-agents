import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRunner } from "../lib/engine.mjs";
import { TASKS } from "../tasks/index.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-flow-"));

describe("review flows", () => {
  it("registers every review task", () => {
    for (const t of ["review.prepare", "review.facts", "review.plan", "review.post", "review.merge", "claude_code", "report"]) expect(TASKS[t]).toBeTruthy();
  });

  it("plans review.decide with the agent in the PR checkout", async () => {
    const { runner } = createRunner({ root });
    const r = await runner.run({ flowName: "review.decide", params: { number: 1 }, plan: true });
    expect(r.success).not.toBe(false);
    const names = (r.steps ?? r.plan ?? []).map((s) => s.name);
    expect(names).toEqual(["review.prepare", "claude_code"]);
  });

  it("plans review.apply with post before merge", async () => {
    const { runner, config } = createRunner({ root });
    const r = await runner.run({ flowName: "review.apply", params: { number: 1 }, plan: true });
    expect(r.steps.map((s) => s.name)).toEqual(["review.facts", "review.plan", "review.post", "review.merge"]);
    const steps = config.flows["review.apply"].steps;
    expect(steps["30"].task).toBe("review.post");
    expect(steps["40"].task).toBe("review.merge");
    expect(config.flows["review.decide"].steps["20"].options.cwd).toBe("../pr");
  });

  it("merges with the configured method", () => {
    const { config, settings } = createRunner({ root });
    expect(config.tasks["review.merge"].options.method).toBe("${settings.review.merge_method}");
    expect(settings.review.merge_method).toBe("squash");
  });
});
