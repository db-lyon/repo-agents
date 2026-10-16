// Resolve tasks. decide job: resolve.prepare, resolve.setup, claude_code,
// resolve.capture. apply job: resolve.plan (apply the patch, verify, plan),
// resolve.publish (commit, push, PR). Decisions live in stages/resolve.

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

function untrackedFiles(cwd) {
  return run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd }).split("\0").filter(Boolean);
}

export class ResolvePrepare extends BaseTask {
  static description = "Decide whether to resolve, and build the prompt variables, schema and command list";
  static optionsSchema = { number: { type: "integer", required: true } };
  get taskName() { return "resolve.prepare"; }

  async execute() {
    const { settings } = this.ctx;
    const repo = repoSlug();
    const n = this.options.number;
    const issue = getIssue(repo, n);
    const why = !settings.resolve.enabled ? "resolve is disabled" : !issue ? "issue not found"
      : issue.isPullRequest ? "the number is a pull request" : issue.state !== "open" ? "the issue is closed" : "";
    if (why) return { success: true, data: { go: false, summary: `### Resolve #${n}: skipped, ${why}.\n` } };
    const comments = (ghJson(["api", "--paginate", "--slurp", `repos/${repo}/issues/${n}/comments`]) ?? []).flat();
    const { commands } = agentAccess(settings);
    return { success: true, data: { go: true, vars: promptValues({ cfg: settings, repo, issue, comments }), schema: schema(), commands, summary: "" } };
  }
}

export class ResolveSetup extends BaseTask {
  static description = "Run the setup commands, then record the untracked files so they stay out of the patch";
  static optionsSchema = {
    number: { type: "integer", required: true },
    commands: { type: "array", default: [] },
    outdir: { type: "string", default: "" },
  };
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
      return { success: true, data: { go: false, results, summary: `### Resolve #${this.options.number}: ${error}\n\n\`\`\`\n${failed.output}\n\`\`\`\n` } };
    }
    return { success: true, data: { go: true, results, untracked: untrackedFiles(root), summary: "" } };
  }
}

export class ResolveCapture extends BaseTask {
  static description = "Write the agent's working tree changes to fix.patch, new files included";
  static optionsSchema = {
    number: { type: "integer", required: true },
    snapshot: { type: "array", default: [] },
    outdir: { type: "string", default: "" },
  };
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

export class ResolvePlan extends BaseTask {
  static description = "Apply the patch on a fresh branch, run setup and verify, and plan the writes";
  static optionsSchema = {
    number: { type: "integer", required: true },
    outdir: { type: "string", default: "" },
  };
  get taskName() { return "resolve.plan"; }

  async execute() {
    const { settings, root } = this.ctx;
    const repo = repoSlug();
    const n = this.options.number;
    const dir = workDir(this.options.outdir);
    const decision = readJson(path.join(dir, "decision.json"));
    const patchFile = path.join(dir, "fix.patch");
    const patch = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, "utf8") : "";
    const issue = getIssue(repo, n);
    const facts = { decision, cfg: settings, issue, changedFiles: patchFiles(patch), verifyResults: [] };

    // Each pass narrows the facts: the patch's own headers, then git's view of
    // the applied patch, then the verify results.
    let plan = planResolve(facts);
    const branch = branchName(settings, n);
    let base = null;
    if (plan.action === "pr") {
      base = defaultBranch(repo);
      run("git", ["checkout", "-B", branch, "HEAD"], { cwd: root });
      try {
        run("git", ["apply", "--index", "--binary", "--whitespace=nowarn", patchFile], { cwd: root });
        facts.changedFiles = run("git", ["-c", "core.quotePath=false", "diff", "--cached", "--name-only", "--no-renames"], { cwd: root })
          .split("\n").filter(Boolean);
      } catch (e) {
        facts.patchError = sanitize(String(e.stderr || e.message), { maxLength: 300 });
      }
      plan = planResolve(facts);
    }
    if (plan.action === "pr") {
      const setup = runCommands(settings.resolve.setup, { cwd: root, setup: true, logger: this.logger });
      const verify = setup.every((r) => r.ok) ? runCommands(settings.resolve.verify, { cwd: root, logger: this.logger }) : [];
      facts.verifyResults = [...setup, ...verify];
      plan = planResolve(facts);
    }

    const opensPr = plan.action === "pr" || plan.action === "draft-pr";
    const data = {
      plan,
      comment: plan.action === "comment",
      pr: opensPr,
      issue_plan: plan.action === "comment" ? issuePlan({ plan, decision, cfg: settings }) : null,
      publish: opensPr ? {
        branch,
        base,
        draft: plan.action === "draft-pr",
        labels: plan.labels,
        title: sanitize(decision.output.pr_title, { maxLength: 200 }) || `fix: resolve #${n}`,
        body: prBody({ decision, verifyResults: facts.verifyResults, cfg: settings, n }),
        commit_message: commitMessage(decision.output.commit_message, n),
        decision,
      } : null,
      summary: applySummary({ n, decision, plan, verifyResults: facts.verifyResults, changedFiles: facts.changedFiles }),
    };
    return { success: true, data };
  }
}

export class ResolvePublish extends BaseTask {
  static description = "Commit the staged fix, push the branch, open or update the PR";
  static optionsSchema = {
    number: { type: "integer", required: true },
    publish: { type: "object", required: true },
    outdir: { type: "string", default: "" },
  };
  get taskName() { return "resolve.publish"; }

  async execute() {
    const { settings, root } = this.ctx;
    const repo = repoSlug();
    const n = this.options.number;
    const p = this.options.publish;
    const agentsToken = process.env.AGENTS_TOKEN || "";
    const token = agentsToken || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) throw new Error("no token to push with: set AGENTS_TOKEN or GH_TOKEN");
    // PRs opened with github.token start no workflows, so prefer the agents token.
    const ghEnv = agentsToken ? { env: { ...process.env, GH_TOKEN: agentsToken } } : {};
    const dir = workDir(this.options.outdir);
    fs.mkdirSync(dir, { recursive: true });
    const msgFile = path.join(dir, "commit-message.txt");
    const bodyFile = path.join(dir, "pr-body.md");
    fs.writeFileSync(msgFile, `${p.commit_message}\n`);
    fs.writeFileSync(bodyFile, p.body);

    // Hooks are off: setup may have installed some, and they would run agent code with the token.
    run("git", [...NO_HOOKS, ...BOT, "commit", "--no-verify", "-F", msgFile], { cwd: root });
    run("git", ["remote", "set-url", "origin", pushUrl(repo, token)], { cwd: root });
    try {
      run("git", [...NO_HOOKS, "push", "--no-verify", "--force", "origin", `HEAD:refs/heads/${p.branch}`], { cwd: root });
    } finally {
      tryRun("git", ["remote", "set-url", "origin", `https://github.com/${repo}.git`], { cwd: root });
    }

    const existing = (ghJson(["pr", "list", "--repo", repo, "--head", p.branch, "--state", "open", "--json", "number,isDraft"], ghEnv) ?? [])[0];
    let pr;
    if (existing) {
      pr = existing.number;
      run("gh", ["pr", "edit", String(pr), "--repo", repo, "--title", p.title, "--body-file", bodyFile], ghEnv);
      if (existing.isDraft && !p.draft) run("gh", ["pr", "ready", String(pr), "--repo", repo], ghEnv);
      if (!existing.isDraft && p.draft) run("gh", ["pr", "ready", String(pr), "--repo", repo, "--undo"], ghEnv);
    } else {
      const args = ["pr", "create", "--repo", repo, "--base", p.base, "--head", p.branch, "--title", p.title, "--body-file", bodyFile];
      if (p.draft) args.push("--draft");
      const url = run("gh", args, ghEnv);
      pr = Number(url.match(/\/pull\/(\d+)/)?.[1]);
      if (!pr) throw new Error(`could not read the PR number from: ${url}`);
    }
    addPrLabels(repo, pr, p.labels);
    if (!agentsToken && settings.ci.workflow) dispatch(repo, settings.ci.workflow, p.branch, {});

    const plan = { action: p.draft ? "draft-pr" : "pr", reasons: [], labels: p.labels };
    return {
      success: true,
      data: {
        pr,
        issue_plan: issuePlan({ plan, decision: p.decision, cfg: settings, pr, updated: Boolean(existing) }),
        summary: `\n${existing ? "Updated" : "Opened"} ${p.draft ? "draft " : ""}PR #${pr} from \`${p.branch}\`.\n`,
      },
    };
  }
}

export const TASKS = {
  "resolve.prepare": ResolvePrepare,
  "resolve.setup": ResolveSetup,
  "resolve.capture": ResolveCapture,
  "resolve.plan": ResolvePlan,
  "resolve.publish": ResolvePublish,
};
