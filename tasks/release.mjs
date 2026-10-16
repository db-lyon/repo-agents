// Release tasks. release.facts gathers what the plan needs and release.plan
// decides whether and what to ship; release.gates runs the gate commands;
// release.prepare_notes builds the notes prompt. Publishing is a chain:
// release.check_notes, release.bump, release.draft, release.push,
// release.create, release.ci. release.delete is the draft's rollback.

import fs from "node:fs";
import path from "node:path";
import { BaseTask } from "@db-lyon/flowkit";
import { workDir } from "../lib/config.mjs";
import { defaultBranch, dispatch, gh, ghJson, releases, repoSlug, run, tryRun } from "../lib/github.mjs";
import { isPrerelease, nextVersion, readVersion, shippableCommits, writeVersion } from "../stages/release/version.mjs";
import { decidePlan, pendingDraft, workflowCheck } from "../stages/release/plan.mjs";
import { buildBody, checkDecision, contributors, decisionSchema } from "../stages/release/body.mjs";

const BOT_NAME = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
export const PLAN_OUTPUTS = ["enabled", "should_release", "version", "prev_tag", "reason", "sha", "default_branch", "gate_runner", "has_gates"];

/** The latest v-tag reachable from HEAD; stable tags only when the release is stable. */
export function previousTag(stableOnly) {
  const args = ["describe", "--tags", "--abbrev=0", "--match", "v*"];
  if (stableOnly) args.push("--exclude", "v*-*");
  return tryRun("git", [...args, "HEAD"]) ?? "";
}

/** `<sha> <subject>` lines since prev (all history when there is none). */
export function commitLines(prev) {
  const out = tryRun("git", ["log", "--format=%H %s", prev ? `${prev}..HEAD` : "HEAD"]) ?? "";
  return out.split("\n").filter(Boolean);
}

/** Commit authors since prev, as credited contributors. */
export function rangeContributors(repo, prev, sha) {
  if (!prev) return [];
  const out = tryRun("gh", ["api", `repos/${repo}/compare/${prev}...${sha}`, "--jq", ".commits[].author.login"]) ?? "";
  return contributors(out.split("\n"), repo.split("/")[0]);
}

export class ReleaseFacts extends BaseTask {
  static description = "Find the release commit, the next version, the previous tag, shippable commits, required workflows and drafts";
  static outputs = {
    sha: { type: "string" }, default_branch: { type: "string" }, current: { type: "string" }, version: { type: "string" },
    prev_tag: { type: "string" }, shippable: { type: "array" }, workflows: { type: "array" }, draft: { type: "string" },
  };
  get taskName() { return "release.facts"; }

  async execute() {
    const { settings, root } = this.ctx;
    const r = settings.release;
    const repo = repoSlug();
    const sha = run("git", ["rev-parse", "HEAD"]);
    const branch = defaultBranch(repo);
    const all = releases(repo, { drafts: true });
    const gitTags = (tryRun("git", ["tag", "--list", "v*"]) ?? "").split("\n").filter(Boolean);
    const current = readVersion(settings, root);
    const version = nextVersion(current, r, [...gitTags, ...all.map((x) => x.tagName)]);
    const prev = previousTag(!isPrerelease(version));
    const workflows = r.required_workflows.map((name) => workflowCheck(
      name,
      ghJson(["run", "list", "--repo", repo, "--workflow", name, "--branch", branch, "--limit", "30", "--json", "headSha,conclusion,status"]),
      sha,
    ));
    return {
      success: true,
      data: {
        sha, default_branch: branch, current, version, prev_tag: prev,
        shippable: shippableCommits(commitLines(prev)), workflows, draft: pendingDraft(all, version) ?? "",
      },
    };
  }
}

export class ReleasePlan extends BaseTask {
  static description = "Decide whether there is something to release, and publish the decision as job outputs";
  static optionsSchema = {
    facts: { type: "object", required: true },
    force: { type: "boolean", default: false, description: "Release even without shippable commits" },
    outdir: { type: "string", default: "" },
  };
  static outputs = { outputs: { type: "object", description: `Job outputs: ${PLAN_OUTPUTS.join(", ")}` } };
  get taskName() { return "release.plan"; }

  async execute() {
    const r = this.ctx.settings.release;
    const f = this.options.facts;
    const decision = decidePlan({
      enabled: true,
      shippable: f.shippable.length,
      minChanges: r.min_changes,
      force: Boolean(this.options.force),
      workflows: f.workflows,
      draft: f.draft || null,
      version: f.version,
    });
    const plan = { enabled: true, gate_runner: r.gate_runner, has_gates: r.gates.length > 0, ...f, ...decision };
    const dir = workDir(this.options.outdir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan, null, 2));
    const summary = [
      `### Release plan: ${plan.should_release ? `v${plan.version}` : "nothing to ship"}`,
      "",
      plan.reason,
      plan.prev_tag ? `\nSince ${plan.prev_tag}, ${plan.shippable.length} shippable commit(s).` : "",
    ].join("\n");
    return { success: true, data: { ...plan, outputs: Object.fromEntries(PLAN_OUTPUTS.map((k) => [k, plan[k]])), summary } };
  }
}

export class ReleaseGates extends BaseTask {
  static description = "Run every release gate command; stop at the first failure";
  static optionsSchema = { commands: { type: "array", default: [] } };
  get taskName() { return "release.gates"; }

  static expand(options) {
    return Array.isArray(options.commands) ? options.commands.map((command) => ({ task: "shell", options: { command } })) : null;
  }

  async execute() {
    for (const command of this.options.commands) {
      const res = await this.step("shell", { command, cwd: this.ctx.root, timeout: 6 * 60 * 60 * 1000 });
      if (!res.success) return { success: false, error: new Error(`gate failed: ${command}`), data: { failed: command } };
    }
    return { success: true, data: { passed: this.options.commands.length } };
  }
}

export class ReleasePrepareNotes extends BaseTask {
  static description = "Build the release notes prompt variables and schema";
  static optionsSchema = {
    version: { type: "string", required: true },
    prev_tag: { type: "string", default: "" },
  };
  static outputs = { go: { type: "boolean" }, schema: { type: "object" }, vars: { type: "object" } };
  get taskName() { return "release.prepare_notes"; }

  async execute() {
    const { settings, root } = this.ctx;
    const repo = repoSlug();
    const { version, prev_tag: prev } = this.options;
    const sha = run("git", ["rev-parse", "HEAD"]);
    const commits = shippableCommits(commitLines(prev));

    // Pull requests merged in range, found from their commits.
    const prs = new Map();
    for (const c of commits.slice(0, 100)) {
      for (const pr of ghJson(["api", `repos/${repo}/commits/${c.sha}/pulls`]) ?? []) {
        if (pr.merged_at && !prs.has(pr.number)) prs.set(pr.number, pr);
      }
    }
    const prText = [...prs.values()]
      .map((p) => `#${p.number} ${p.title} (by ${p.user?.login ?? "unknown"})\n${String(p.body ?? "").slice(0, 3000)}`)
      .join("\n\n---\n\n");

    const stable = releases(repo).find((x) => !x.isPrerelease);
    const stableBody = stable ? tryRun("gh", ["release", "view", stable.tagName, "--repo", repo, "--json", "body", "--jq", ".body"]) : null;
    const styleFile = settings.release.notes.style_doc ? path.resolve(root, settings.release.notes.style_doc) : "";
    const styleDoc = styleFile && fs.existsSync(styleFile) ? fs.readFileSync(styleFile, "utf8") : "";
    const credited = rangeContributors(repo, prev, sha);

    return {
      success: true,
      data: {
        go: Boolean(version),
        schema: decisionSchema(settings),
        vars: {
          REPO: repo,
          VERSION: version,
          PREV_TAG: prev || "(none, this is the first release)",
          COMMITS: commits.map((c) => `- ${c.sha.slice(0, 8)} ${c.subject}`).join("\n") || "(none)",
          PULL_REQUESTS: prText || "(none)",
          CONTRIBUTORS: credited.map((h) => `@${h}`).join(", ") || "(none)",
          STABLE_BODY: stableBody || "(no stable release yet)",
          STYLE_DOC: styleDoc || settings.project.voice,
          HEADLINE_REQUIRED: settings.release.notes.headline ? "yes" : "no",
        },
      },
    };
  }
}

function pushUrl(repo, token) {
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}

function releaseToken() {
  return process.env.AGENTS_TOKEN || process.env.GH_TOKEN || "";
}

export class ReleaseCheckNotes extends BaseTask {
  static description = "Validate the notes decision and write the release body";
  static optionsSchema = {
    version: { type: "string", required: true },
    prev_tag: { type: "string", default: "" },
    default_branch: { type: "string", default: "" },
    outdir: { type: "string", default: "" },
  };
  static outputs = {
    go: { type: "boolean" }, draft: { type: "boolean", description: "Draft first, then push (draft-and-bump)" },
    publish: { type: "boolean", description: "Push, then publish here" }, tag: { type: "string" },
    notes_file: { type: "string" }, branch: { type: "string" },
  };
  get taskName() { return "release.check_notes"; }

  async execute() {
    const { settings, root } = this.ctx;
    const r = settings.release;
    const repo = repoSlug();
    const { version, prev_tag: prev } = this.options;
    const tag = `v${version}`;
    const dir = workDir(this.options.outdir);
    const file = path.join(dir, "decision.json");
    const agent = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    const decision = agent.output ?? null;

    if (!decision) return { success: false, error: new Error(`no notes decision for ${tag}${agent.error ? `: ${agent.error}` : ""}`) };
    if (decision.skip) {
      return { success: true, data: { go: false, draft: false, publish: false, summary: `### Release ${tag} skipped\n\n${decision.skip_reason || "The notes agent found nothing to ship."}` } };
    }
    const errors = checkDecision(decision, settings);
    if (errors.length) return { success: false, error: new Error(`notes for ${tag} rejected: ${errors.join("; ")}`) };

    const sha = run("git", ["rev-parse", "HEAD"]);
    const body = buildBody({ decision, cfg: settings, version, contributors: rangeContributors(repo, prev, sha) });
    fs.mkdirSync(dir, { recursive: true });
    const notesFile = path.join(dir, "release-notes.md");
    fs.writeFileSync(notesFile, body);
    if (r.notes.headline_validate) {
      const check = await this.step("shell", { command: `${r.notes.headline_validate} < "${notesFile}"`, cwd: root });
      if (!check.success) return { success: false, error: new Error(`release notes failed ${r.notes.headline_validate}`) };
    }
    const draft = r.publish === "draft-and-bump";
    return {
      success: true,
      data: { go: true, draft, publish: !draft, tag, notes_file: notesFile, branch: this.options.default_branch || defaultBranch(repo) },
    };
  }
}

export class ReleaseBump extends BaseTask {
  static description = "Write the new version and commit it locally";
  static optionsSchema = { version: { type: "string", required: true } };
  static outputs = { sha: { type: "string", description: "The bump commit" } };
  get taskName() { return "release.bump"; }

  async execute() {
    const { settings, root } = this.ctx;
    const { version } = this.options;
    writeVersion(settings, root, version);
    run("git", [
      "-c", "core.hooksPath=/dev/null", "-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`,
      "commit", "--no-verify", "-a", "-m", settings.release.bump_commit_message.replace(/\{version\}/g, version),
    ]);
    return { success: true, data: { sha: run("git", ["rev-parse", "HEAD"]) } };
  }
}

export class ReleaseDraft extends BaseTask {
  static description = "Create the draft release; it is deleted again if a later step fails";
  static optionsSchema = { tag: { type: "string", required: true }, notes_file: { type: "string", required: true } };
  get taskName() { return "release.draft"; }

  async execute() {
    const repo = repoSlug();
    const { tag, notes_file: notesFile } = this.options;
    const pre = isPrerelease(tag.replace(/^v/, "")) ? ["--prerelease"] : [];
    await this.ctx.writer.write(
      { stage: "release", kind: "release_create", target: tag, draft: true, text: fs.readFileSync(notesFile, "utf8") },
      () => gh(["release", "create", tag, "--repo", repo, "--draft", "--title", tag, "--notes-file", notesFile, ...pre]),
    );
    // A stranded draft would block every later plan.
    return { success: true, data: { tag }, rollback: { taskName: "release.delete", payload: { tag } } };
  }
}

export class ReleaseDelete extends BaseTask {
  static description = "Delete a draft release (the rollback for release.draft)";
  static optionsSchema = { tag: { type: "string", required: true } };
  get taskName() { return "release.delete"; }

  async execute() {
    const repo = repoSlug();
    const { tag } = this.options;
    await this.ctx.writer.write({ stage: "release", kind: "release_delete", target: tag }, () => gh(["release", "delete", tag, "--repo", repo, "--yes"]));
    return { success: true, data: { summary: `Deleted draft ${tag} after a later step failed.` } };
  }
}

export class ReleasePush extends BaseTask {
  static description = "Push the bump commit to the default branch";
  static optionsSchema = { branch: { type: "string", required: true } };
  get taskName() { return "release.push"; }

  async execute() {
    const repo = repoSlug();
    const { branch } = this.options;
    const token = releaseToken();
    if (!token) return { success: false, error: new Error("AGENTS_TOKEN or GH_TOKEN is required to push") };
    const refspec = `HEAD:refs/heads/${branch}`;
    await this.ctx.writer.write({ stage: "release", kind: "push", target: branch, branch, defaultBranch: branch }, () => {
      try {
        run("git", ["-c", "http.https://github.com/.extraheader=", "push", pushUrl(repo, token), refspec]);
      } catch (e) {
        throw new Error(`git push ${refspec} failed: ${String(e.stderr || e.message).split(token).join("***")}`);
      }
    });
    return { success: true, data: {} };
  }
}

export class ReleaseCreate extends BaseTask {
  static description = "Tag and publish the release on the bump commit";
  static optionsSchema = {
    tag: { type: "string", required: true },
    notes_file: { type: "string", required: true },
    sha: { type: "string", required: true },
  };
  get taskName() { return "release.create"; }

  async execute() {
    const repo = repoSlug();
    const { tag, notes_file: notesFile, sha } = this.options;
    const pre = isPrerelease(tag.replace(/^v/, "")) ? ["--prerelease"] : [];
    await this.ctx.writer.write(
      { stage: "release", kind: "release_create", target: tag, draft: false, text: fs.readFileSync(notesFile, "utf8") },
      () => gh(["release", "create", tag, "--repo", repo, "--title", tag, "--notes-file", notesFile, "--target", sha, ...pre]),
    );
    return { success: true, data: {} };
  }
}

export class ReleaseCi extends BaseTask {
  static description = "Dispatch the project's CI on the bump when the push could not trigger it, and report";
  static optionsSchema = {
    tag: { type: "string", required: true },
    sha: { type: "string", required: true },
    branch: { type: "string", required: true },
    draft: { type: "boolean", default: false },
  };
  get taskName() { return "release.ci"; }

  async execute() {
    const { settings, writer } = this.ctx;
    const repo = repoSlug();
    const { tag, sha, branch, draft } = this.options;
    let ci = "";
    if (!process.env.AGENTS_TOKEN && settings.ci.workflow) {
      await writer.write({ stage: "release", kind: "dispatch", target: branch, workflow: settings.ci.workflow }, () => dispatch(repo, settings.ci.workflow, branch, {}));
      ci = ` Dispatched ${settings.ci.workflow} on ${branch}.`;
    }
    const mode = draft ? "Draft created and version bump pushed; the project's CI publishes it." : "Published.";
    return { success: true, data: { tag, sha, summary: `### Release ${tag}\n\n${mode}${ci}\n\nCommit ${sha.slice(0, 8)} on ${branch}.` } };
  }
}

export const TASKS = {
  "release.facts": ReleaseFacts,
  "release.plan": ReleasePlan,
  "release.gates": ReleaseGates,
  "release.prepare_notes": ReleasePrepareNotes,
  "release.check_notes": ReleaseCheckNotes,
  "release.bump": ReleaseBump,
  "release.draft": ReleaseDraft,
  "release.delete": ReleaseDelete,
  "release.push": ReleasePush,
  "release.create": ReleaseCreate,
  "release.ci": ReleaseCi,
};
