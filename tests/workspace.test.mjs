// Where the engine looks: the repository it acts on, and the review action's
// PR checkout at pr/ inside the project root.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BaseTask } from "@db-lyon/flowkit";
import { DEFAULTS, contextText, merge } from "../lib/config.mjs";
import { createRunner } from "../lib/engine.mjs";
import { envRepo } from "../lib/github.mjs";
import { untrackedFiles } from "../tasks/resolve.mjs";
import { excludeFromRoot, resolvePrDir } from "../tasks/review.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

function repoWithPr() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-ws-"));
  git(root, "init", "-q");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "base rules");
  fs.mkdirSync(path.join(root, "pr"));
  git(path.join(root, "pr"), "init", "-q");
  fs.writeFileSync(path.join(root, "pr", "CLAUDE.md"), "PR author rules");
  fs.writeFileSync(path.join(root, "pr", "a.js"), "x");
  return root;
}

describe("repository", () => {
  it("prefers REPO_AGENTS_REPOSITORY over GITHUB_REPOSITORY", () => {
    expect(envRepo({ REPO_AGENTS_REPOSITORY: "org/sandbox", GITHUB_REPOSITORY: "org/caller" })).toBe("org/sandbox");
    expect(envRepo({ GITHUB_REPOSITORY: "org/caller" })).toBe("org/caller");
    expect(envRepo({})).toBe("");
  });
});

describe("PR checkout inside the project root", () => {
  it("resolves a relative pr_dir against the root and refuses the root or a parent", () => {
    const root = repoWithPr();
    expect(resolvePrDir(root, "pr")).toEqual({ dir: path.join(root, "pr"), error: null });
    expect(resolvePrDir(root, ".").error).toMatch(/project root/);
    expect(resolvePrDir(path.join(root, "pr"), "..").error).toMatch(/project root or contains it/);
    expect(resolvePrDir(root, "missing").error).toMatch(/no PR checkout/);
  });

  it("is never an untracked file git add could stage, and is excluded from git in the root", () => {
    const root = repoWithPr();
    fs.writeFileSync(path.join(root, "new.js"), "y");
    expect(untrackedFiles(root).sort()).toEqual(["CLAUDE.md", "new.js"]);
    expect(excludeFromRoot(root, path.join(root, "pr"))).toBe("/pr/");
    expect(excludeFromRoot(root, path.join(root, "pr"))).toBe("/pr/");
    const exclude = fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === "/pr/")).toHaveLength(1);
    git(root, "add", "-A");
    expect(git(root, "diff", "--cached", "--name-only").split("\n").sort()).toEqual(["CLAUDE.md", "new.js"]);
    expect(excludeFromRoot(root, path.join(os.tmpdir(), "elsewhere"))).toBeNull();
  });

  it("keeps the PR's files out of the house rules", () => {
    const root = repoWithPr();
    const settings = merge(DEFAULTS, { project: { context_files: ["CLAUDE.md", "pr/CLAUDE.md"] } });
    expect(contextText(settings, root)).toContain("PR author rules");
    const text = contextText(settings, root, undefined, [path.join(root, "pr")]);
    expect(text).toContain("base rules");
    expect(text).not.toContain("PR author rules");
  });

  it("runs the review agent in the PR checkout review.prepare resolved", async () => {
    const root = repoWithPr();
    const seen = [];
    const { runner, registry } = createRunner({ root, file: "none.yml", hooks: {} });
    registry.register("review.prepare", class extends BaseTask {
      get taskName() { return "review.prepare"; }
      async execute() { return { success: true, data: { go: true, pr_dir: path.join(root, "pr"), vars: {}, schema: {} } }; }
    });
    registry.register("claude_code", class extends BaseTask {
      get taskName() { return "claude_code"; }
      async execute() { seen.push(this.options.cwd); return { success: true, data: {} }; }
    });
    const r = await runner.run({ flowName: "review.decide", params: { number: 4, pr_dir: "pr" } });
    expect(r.success).toBe(true);
    expect(seen).toEqual([path.join(root, "pr")]);
  });
});
