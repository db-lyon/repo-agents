// Resolve tasks. decide job: resolve.prepare, resolve.setup, claude_code,
// resolve.capture. apply job: resolve.check reads the decision and the patch,
// resolve.apply_patch puts it on a fresh branch, resolve.verify runs setup and
// verify, resolve.plan decides; resolve.commit, resolve.push and
// resolve.open_pr publish. resolve.delete_branch is the push's rollback.
// Decisions live in stages/resolve.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BaseTask } from "@db-lyon/flowkit";
import { workDir } from "../lib/config.mjs";
import { addPrLabels, defaultBranch, dispatch, ghJson, issue as getIssue, repoSlug, run, tryRun } from "../lib/github.mjs";
import { sanitize } from "../lib/text.mjs";
import {
  agentAccess, applySummary, branchName, chunks, commitMessage, decideSummary, issuePlan, newUntracked,
  patchFiles, planResolve, prBody, promptValues, pushUrl, schema, scrubEnv, tail,
} from "../stages/resolve/resolve.mjs";

const BOT = ["-c", "user.name=github-actions[bot]", "-c", "user.email=41898283+github-actions[bot]@users.noreply.github.com"];
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

/** Run commands in order with bash, tokens scrubbed, stopping at the first failure. */
export function runCommands(commands, { cwd, setup = false, timeoutMs = 30 * 60 * 1000, logger } = {}) {
  const results = [];
  for (const command of commands) {
    logger?.info(`$ ${command}`);
    const r = spawnSync("bash", ["-c", command], {
      cwd, env: scrubEnv(process.env), encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024,
    });
    const ok = r.status === 0;
    results.push({ command, ok, setup, output: tail(`${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`) });
    if (!ok) break;
  }
  return results;
}

/** Untracked files git add may stage. A nested checkout (an embedded repository, such as review's pr/) is never one. */
export function untrackedFiles(cwd) {
  return run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd }).split("\0").filter(Boolean)
    .filter((f) => !(f.endsWith("/") && fs.existsSync(path.join(cwd, f, ".git"))));
}

/** The token pushes and PRs use. PRs opened with github.token start no workflows, so the agents token wins. */
function pushToken() {
  return process.env.AGENTS_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
}

function ghEnv() {
  return process.env.AGENTS_TOKEN ? { env: { ...process.env, GH_TOKEN: process.env.AGENTS_TOKEN } } : {};
}

// decide job

export class ResolvePrepare extends BaseTask {
  static description = "Decide whether to resolve, and build the prompt variables, schema and command list";
  static optionsSchema = { number: { type: "integer", required: true } };
  static outputs = { go: { type: "boolean" }, vars: { type: "object" }, schema: { type: "object" }, commands: { type: "array" } };
  get taskName() { return "resolve.prepare"; }

  async execute() {
    const { settings } = this.ctx;
    const repo = repoSlug();
    const n = this.options.number;
    const issue = getIssue(repo, n);
    const why = !issue ? "issue not found" : issue.isPullRequest ? "the number is a pull request" : issue.state !== "open" ? "the issue is closed" : "";
    if (why) return { success: true, data: { go: false, summary: `### Resolve #${n}: skipped, ${why}.` } };
    const comments = (ghJson(["api", "--paginate", "--slurp", `repos/${repo}/issues/${n}/comments`]) ?? []).flat();
    const { commands } = agentAccess(settings);
    return { success: true, data: { go: true, vars: promptValues({ cfg: settings, repo, issue, comments }), schema: schema(), commands } };
  }
}

export class ResolveSetup extends BaseTask {
  static description = "Run the setup commands, then record the untracked files so they stay out of the patch";
  static optionsSchema = {
    number: { type: "integer", required: true },
    commands: { type: "array", default: [] },
    outdir: { type: "string", default: "" },
  };
  static outputs = { go: { type: "boolean" }, untracked: { type: "array" } };
  get taskName() { return "resolve.setup"; }

  async execute() {
    const { root } = this.ctx;
    const results = runCommands(this.options.commands, { cwd: root, setup: true, logger: this.logger });
    const failed = results.find((r) => !r.ok);
    if (failed) {
      // Recorded as the decision, so the apply job reports it on the issue.
      const dir = workDir(this.options.outdir);
      fs.mkdirSync(dir, { recursive: true });
      const error = `setup command failed: ${failed.command}`;
      fs.writeFileSync(path.join(dir, "decision.json"), JSON.stringify({ output: null, cost: 0, turns: 0, error, setup: results }, null, 2));
      return { success: true, data: { go: false, results, summary: `### Resolve #${this.options.number}: ${error}\n\n\`\`\`\n${failed.output}\n\`\`\`` } };
    }
    return { success: true, data: { go: true, results, untracked: untrackedFiles(root) } };
  }
}

export class ResolveCapture extends BaseTask {
  static description = "Write the agent's working tree changes to fix.patch, new files included";
  static optionsSchema = {
    number: { type: "integer", required: true },
    snapshot: { type: "array", default: [] },
    outdir: { type: "string", default: "" },
  };
  static outputs = { files: { type: "array" } };
  get taskName() { return "resolve.capture"; }

  async execute() {
    const { root } = this.ctx;
    const dir = workDir(this.options.outdir);
    fs.mkdirSync(dir, { recursive: true });
    const added = newUntracked(this.options.snapshot, untrackedFiles(root));
    for (const part of chunks(added, 200)) run("git", ["add", "-N", "--", ...part], { cwd: root });
    const patch = run("git", ["diff", "--binary", "HEAD"], { cwd: root });
    fs.writeFileSync(path.join(dir, "fix.patch"), patch ? `${patch}\n` : "");
    const files = patchFiles(patch);
    const decision = readJson(path.join(dir, "decision.json"));
    return { success: true, data: { files, summary: decideSummary({ n: this.options.number, decision, files }) } };
  }
}

// apply job

export class ResolveCheck extends BaseTask {
  static description = "Read the decision and the patch, and check them before anything touches the tree";
  static optionsSchema = {
    number: { type: "integer", required: true },
    outdir: { type: "string", default: "" },
  };
  static outputs = {
    go: { type: "boolean", description: "The patch is worth applying" },
    decision: { type: "object" }, issue: { type: "object" }, files: { type: "array", description: "Files the patch headers name" },
  };
  get taskName() { return "resolve.check"; }

  async execute() {
    const { settings } = this.ctx;
    const n = this.options.number;
    const dir = workDir(this.options.outdir);
    const decision = readJson(path.join(dir, "decision.json")) ?? {};
    const patchFile = path.join(dir, "fix.patch");
    const files = patchFiles(fs.existsSync(patchFile) ? fs.readFileSync(patchFile, "utf8") : "");
    const issue = getIssue(repoSlug(), n);
    const plan = planResolve({ decision, cfg: settings, issue, changedFiles: files });
    return { success: true, data: { go: plan.action === "pr", decision, issue: issue ?? {}, files, patch: patchFile } };
  }
}

export class ResolveApplyPatch extends BaseTask {
  static description = "Apply fix.patch to a fresh branch and stage it";
  static optionsSchema = {
    number: { type: "integer", required: true },
    patch: { type: "string", required: true },
  };
  static outputs = { applied: { type: "boolean" }, files: { type: "array", description: "Files git staged" }, error: { type: "string" } };
  get taskName() { return "resolve.apply_patch"; }

  async execute() {
    const { settings, root } = this.ctx;
    run("git", ["checkout", "-B", branchName(settings, this.options.number), "HEAD"], { cwd: root });
    try {
      run("git", ["apply", "--index", "--binary", "--whitespace=nowarn", this.options.patch], { cwd: root });
    } catch (e) {
      return { success: true, data: { applied: false, files: [], error: sanitize(String(e.stderr || e.message), { maxLength: 300 }) } };
    }
    const files = run("git", ["-c", "core.quotePath=false", "diff", "--cached", "--name-only", "--no-renames"], { cwd: root }).split("\n").filter(Boolean);
    return { success: true, data: { applied: true, files, error: "" } };
  }
}

export class ResolveVerify extends BaseTask {
  static description = "Run the setup and verify commands on the patched tree, tokens scrubbed";
  static optionsSchema = {
    setup: { type: "array", default: [] },
    verify: { type: "array", default: [] },
  };
  static outputs = { results: { type: "array", description: "{ command, ok, setup, output }" } };
  get taskName() { return "resolve.verify"; }

  async execute() {
    const { root } = this.ctx;
    const setup = runCommands(this.options.setup, { cwd: root, setup: true, logger: this.logger });
    const verify = setup.every((r) => r.ok) ? runCommands(this.options.verify, { cwd: root, logger: this.logger }) : [];
    return { success: true, data: { results: [...setup, ...verify] } };
  }
}

export class ResolvePlan extends BaseTask {
  static description = "Decide between a PR, a draft PR and an issue comment, and build their text";
  static optionsSchema = {
    number: { type: "integer", required: true },
    decision: { type: "object", default: {} },
    issue: { type: "object", default: {} },
    patch_files: { type: "array", default: [], description: "Files the patch headers name" },
    applied: { type: "boolean", default: false },
    staged_files: { type: "array", default: [], description: "Files git staged, when the patch applied" },
    patch_error: { type: "string", default: "" },
    verify_results: { type: "array", default: [] },
  };
  static outputs = {
    pr: { type: "boolean" }, comment: { type: "boolean" }, plan: { type: "object" },
    issue_plan: { type: "object" }, publish: { type: "object" },
  };
  get taskName() { return "resolve.plan"; }

  async execute() {
    const { settings } = this.ctx;
    const o = this.options;
    const n = o.number;
    const decision = o.decision;
    const issue = o.issue?.number ? o.issue : null;
    const changedFiles = o.applied ? o.staged_files : o.patch_files;
    const plan = planResolve({ decision, cfg: settings, issue, changedFiles, patchError: o.patch_error || null, verifyResults: o.verify_results });
    const opensPr = plan.action === "pr" || plan.action === "draft-pr";
    return {
      success: true,
      data: {
        plan,
        comment: plan.action === "comment",
        pr: opensPr,
        issue_plan: plan.action === "comment" ? issuePlan({ plan, decision, cfg: settings }) : {},
        publish: opensPr ? {
          branch: branchName(settings, n),
          draft: plan.action === "draft-pr",
          labels: plan.labels,
          files: changedFiles,
          title: sanitize(decision.output.pr_title, { maxLength: 200 }) || `fix: resolve #${n}`,
          body: prBody({ decision, verifyResults: o.verify_results, cfg: settings, n }),
          commit_message: commitMessage(decision.output.commit_message, n),
          decision,
        } : {},
        summary: applySummary({ n, decision, plan, verifyResults: o.verify_results, changedFiles }),
      },
    };
  }
}

export class ResolveCommit extends BaseTask {
  static description = "Commit the staged fix locally, hooks off";
  static optionsSchema = {
    publish: { type: "object", required: true },
    outdir: { type: "string", default: "" },
  };
  static outputs = { sha: { type: "string" } };
  get taskName() { return "resolve.commit"; }

  async execute() {
    const { root } = this.ctx;
    const dir = workDir(this.options.outdir);
    fs.mkdirSync(dir, { recursive: true });
    const msgFile = path.join(dir, "commit-message.txt");
    fs.writeFileSync(msgFile, `${this.options.publish.commit_message}\n`);
    // Hooks are off: setup may have installed some, and they would run agent code.
    run("git", [...NO_HOOKS, ...BOT, "commit", "--no-verify", "-F", msgFile], { cwd: root });
    return { success: true, data: { sha: run("git", ["rev-parse", "HEAD"], { cwd: root }) } };
  }
}

export class ResolvePush extends BaseTask {
  static description = "Push the fix branch; a branch this run created is deleted again if a later step fails";
  static optionsSchema = { publish: { type: "object", required: true } };
  static outputs = { created: { type: "boolean", description: "The branch did not exist before this push" } };
  get taskName() { return "resolve.push"; }

  async execute() {
    const { root, writer } = this.ctx;
    const repo = repoSlug();
    const p = this.options.publish;
    const token = pushToken();
    if (!token) throw new Error("no token to push with: set AGENTS_TOKEN or GH_TOKEN");
    const op = {
      stage: "resolve", kind: "push", target: p.branch, branch: p.branch, defaultBranch: defaultBranch(repo),
      files: p.files, text: p.commit_message,
    };
    let created = false;
    await writer.write(op, () => {
      run("git", ["remote", "set-url", "origin", pushUrl(repo, token)], { cwd: root });
      try {
        created = !run("git", ["ls-remote", "--heads", "origin", `refs/heads/${p.branch}`], { cwd: root });
        run("git", [...NO_HOOKS, "push", "--no-verify", "--force", "origin", `HEAD:refs/heads/${p.branch}`], { cwd: root });
      } catch (e) {
        throw new Error(`git push ${p.branch} failed: ${String(e.stderr || e.message).split(token).join("***")}`);
      } finally {
        tryRun("git", ["remote", "set-url", "origin", `https://github.com/${repo}.git`], { cwd: root });
      }
    });
    const result = { success: true, data: { created } };
    if (created) result.rollback = { taskName: "resolve.delete_branch", payload: { branch: p.branch } };
    return result;
  }
}

export class ResolveDeleteBranch extends BaseTask {
  static description = "Delete a fix branch that has no open PR (the rollback for resolve.push)";
  static optionsSchema = { branch: { type: "string", required: true } };
  get taskName() { return "resolve.delete_branch"; }

  async execute() {
    const repo = repoSlug();
    const { branch } = this.options;
    const open = ghJson(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number"], ghEnv()) ?? [];
    if (open.length) return { success: true, data: { deleted: false, summary: `Kept \`${branch}\`: PR #${open[0].number} is open on it.` } };
    await this.ctx.writer.write(
      { stage: "resolve", kind: "delete_branch", target: branch, branch, defaultBranch: defaultBranch(repo) },
      () => run("gh", ["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${branch}`], ghEnv()),
    );
    return { success: true, data: { deleted: true, summary: `Deleted \`${branch}\` after a later step failed.` } };
  }
}

export class ResolveOpenPr extends BaseTask {
  static description = "Open the PR for the pushed branch, or update the open one";
  static optionsSchema = {
    number: { type: "integer", required: true },
    publish: { type: "object", required: true },
    outdir: { type: "string", default: "" },
  };
  static outputs = { pr: { type: "integer" }, issue_plan: { type: "object" } };
  get taskName() { return "resolve.open_pr"; }

  async execute() {
    const { settings, writer } = this.ctx;
    const repo = repoSlug();
    const n = this.options.number;
    const p = this.options.publish;
    const env = ghEnv();
    const dir = workDir(this.options.outdir);
    fs.mkdirSync(dir, { recursive: true });
    const bodyFile = path.join(dir, "pr-body.md");
    fs.writeFileSync(bodyFile, p.body);
    const op = { stage: "resolve", text: `${p.title}\n\n${p.body}` };

    const existing = (ghJson(["pr", "list", "--repo", repo, "--head", p.branch, "--state", "open", "--json", "number,isDraft"], env) ?? [])[0];
    let pr;
    if (existing) {
      pr = existing.number;
      await writer.write({ ...op, kind: "pr_edit", target: `#${pr}` }, () => {
        run("gh", ["pr", "edit", String(pr), "--repo", repo, "--title", p.title, "--body-file", bodyFile], env);
        if (existing.isDraft && !p.draft) run("gh", ["pr", "ready", String(pr), "--repo", repo], env);
        if (!existing.isDraft && p.draft) run("gh", ["pr", "ready", String(pr), "--repo", repo, "--undo"], env);
      });
    } else {
      const base = defaultBranch(repo);
      const args = ["pr", "create", "--repo", repo, "--base", base, "--head", p.branch, "--title", p.title, "--body-file", bodyFile];
      if (p.draft) args.push("--draft");
      const url = await writer.write({ ...op, kind: "pr_create", target: p.branch }, () => run("gh", args, env));
      pr = Number(url.match(/\/pull\/(\d+)/)?.[1]);
      if (!pr) throw new Error(`could not read the PR number from: ${url}`);
    }
    if (p.labels?.length) await writer.write({ stage: "resolve", kind: "pr_label", target: `#${pr}`, labels: p.labels }, () => addPrLabels(repo, pr, p.labels));
    let ci = "";
    if (!process.env.AGENTS_TOKEN && settings.ci.workflow) {
      await writer.write({ stage: "resolve", kind: "dispatch", target: p.branch, workflow: settings.ci.workflow }, () => dispatch(repo, settings.ci.workflow, p.branch, {}));
      ci = ` Dispatched ${settings.ci.workflow} on it.`;
    }

    const plan = { action: p.draft ? "draft-pr" : "pr", reasons: [], labels: p.labels };
    return {
      success: true,
      data: {
        pr,
        issue_plan: issuePlan({ plan, decision: p.decision, cfg: settings, pr, updated: Boolean(existing) }),
        summary: `${existing ? "Updated" : "Opened"} ${p.draft ? "draft " : ""}PR #${pr} from \`${p.branch}\`.${ci}`,
      },
    };
  }
}

export const TASKS = {
  "resolve.prepare": ResolvePrepare,
  "resolve.setup": ResolveSetup,
  "resolve.capture": ResolveCapture,
  "resolve.check": ResolveCheck,
  "resolve.apply_patch": ResolveApplyPatch,
  "resolve.verify": ResolveVerify,
  "resolve.plan": ResolvePlan,
  "resolve.commit": ResolveCommit,
  "resolve.push": ResolvePush,
  "resolve.delete_branch": ResolveDeleteBranch,
  "resolve.open_pr": ResolveOpenPr,
};
