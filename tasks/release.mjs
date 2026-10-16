// Release tasks. release.plan decides whether and what to ship;
// release.gates runs the gate commands; release.prepare_notes builds the
// notes prompt; release.publish turns the decision into a release.

import fs from "node:fs";
import path from "node:path";
import { BaseTask } from "@db-lyon/flowkit";
import { workDir } from "../lib/config.mjs";
import { defaultBranch, dispatch, gh, ghJson, releases, repoSlug, run, setOutput, summary, tryRun } from "../lib/github.mjs";
import { isPrerelease, nextVersion, readVersion, shippableCommits, writeVersion } from "../stages/release/version.mjs";
import { decidePlan, pendingDraft, workflowCheck } from "../stages/release/plan.mjs";
import { buildBody, checkDecision, contributors, decisionSchema } from "../stages/release/body.mjs";

const BOT_NAME = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";

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

export class ReleasePlan extends BaseTask {
  static description = "Decide whether there is something to release and which version";
  static optionsSchema = {
    force: { type: "boolean", default: false, description: "Release even without shippable commits" },
    outdir: { type: "string", default: "" },
  };
  get taskName() { return "release.plan"; }

  async execute() {
    const { settings, root } = this.ctx;
    const r = settings.release;
    const repo = repoSlug();
    const base = { enabled: r.enabled, gate_runner: r.gate_runner, has_gates: r.gates.length > 0 };
    let plan;
    if (!r.enabled) {
      plan = { ...base, ...decidePlan({ enabled: false }), version: "", prev_tag: "", sha: "", default_branch: "", shippable: [] };
    } else {
      const sha = run("git", ["rev-parse", "HEAD"]);
      const branch = defaultBranch(repo);
      const all = releases(repo, { drafts: true });
      const gitTags = (tryRun("git", ["tag", "--list", "v*"]) ?? "").split("\n").filter(Boolean);
      const current = readVersion(settings, root);
      const version = nextVersion(current, r, [...gitTags, ...all.map((x) => x.tagName)]);
      const prev = previousTag(!isPrerelease(version));
      const shippable = shippableCommits(commitLines(prev));
      const workflows = r.required_workflows.map((name) => workflowCheck(
        name,
        ghJson(["run", "list", "--repo", repo, "--workflow", name, "--branch", branch, "--limit", "30", "--json", "headSha,conclusion,status"]),
        sha,
      ));
      const decision = decidePlan({
        enabled: true,
        shippable: shippable.length,
        minChanges: r.min_changes,
        force: Boolean(this.options.force),
        workflows,
        draft: pendingDraft(all, version),
        version,
      });
      plan = { ...base, ...decision, version, current, prev_tag: prev, sha, default_branch: branch, workflows, shippable };
    }

    const dir = workDir(this.options.outdir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan, null, 2));
    for (const k of ["enabled", "should_release", "version", "prev_tag", "reason", "sha", "default_branch", "gate_runner", "has_gates"]) {
      setOutput(k, plan[k]);
    }
    const text = [
      `### Release plan: ${plan.should_release ? `v${plan.version}` : "nothing to ship"}`,
      "",
      plan.reason,
      plan.prev_tag ? `\nSince ${plan.prev_tag}, ${plan.shippable.length} shippable commit(s).` : "",
    ].join("\n");
    return { success: true, data: { ...plan, summary: text } };
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

/** git push with the token in the URL; errors are redacted before they surface. */
function pushRef(repo, token, refspec) {
  try {
    run("git", ["-c", "http.https://github.com/.extraheader=", "push", pushUrl(repo, token), refspec]);
  } catch (e) {
    throw new Error(`git push ${refspec} failed: ${String(e.stderr || e.message).split(token).join("***")}`);
  }
}

export class ReleasePublish extends BaseTask {
  static description = "Write the version bump and create the release from the notes decision";
  static optionsSchema = {
    version: { type: "string", required: true },
    prev_tag: { type: "string", default: "" },
    default_branch: { type: "string", default: "" },
    outdir: { type: "string", default: "" },
  };
  get taskName() { return "release.publish"; }

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

    if (!decision) {
      return { success: false, error: new Error(`no notes decision for ${tag}${agent.error ? `: ${agent.error}` : ""}`) };
    }
    if (decision.skip) {
      return { success: true, data: { published: false, summary: `### Release ${tag} skipped\n\n${decision.skip_reason || "The notes agent found nothing to ship."}` } };
    }
    const errors = checkDecision(decision, settings);
    if (errors.length) return { success: false, error: new Error(`notes for ${tag} rejected: ${errors.join("; ")}`) };

    const sha = run("git", ["rev-parse", "HEAD"]);
    const body = buildBody({ decision, cfg: settings, version, contributors: rangeContributors(repo, prev, sha) });
    const notesFile = path.join(dir, "release-notes.md");
    fs.writeFileSync(notesFile, body);

    if (r.notes.headline_validate) {
      const check = await this.step("shell", { command: `${r.notes.headline_validate} < "${notesFile}"`, cwd: root });
      if (!check.success) return { success: false, error: new Error(`release notes failed ${r.notes.headline_validate}`) };
    }

    writeVersion(settings, root, version);
    run("git", [
      "-c", "core.hooksPath=/dev/null", "-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`,
      "commit", "--no-verify", "-a", "-m", r.bump_commit_message.replace(/\{version\}/g, version),
    ]);
    const bumpSha = run("git", ["rev-parse", "HEAD"]);
    const branch = this.options.default_branch || defaultBranch(repo);
    const token = process.env.AGENTS_TOKEN || process.env.GH_TOKEN;
    if (!token) return { success: false, error: new Error("AGENTS_TOKEN or GH_TOKEN is required to push") };
    const pre = isPrerelease(version) ? ["--prerelease"] : [];

    if (r.publish === "draft-and-bump") {
      gh(["release", "create", tag, "--repo", repo, "--draft", "--title", tag, "--notes-file", notesFile, ...pre]);
      try {
        pushRef(repo, token, `HEAD:refs/heads/${branch}`);
      } catch (e) {
        // A stranded draft would block every later plan.
        tryRun("gh", ["release", "delete", tag, "--repo", repo, "--yes"]);
        throw e;
      }
    } else {
      pushRef(repo, token, `HEAD:refs/heads/${branch}`);
      gh(["release", "create", tag, "--repo", repo, "--title", tag, "--notes-file", notesFile, "--target", bumpSha, ...pre]);
    }

    let ci = "";
    if (!process.env.AGENTS_TOKEN && settings.ci.workflow) {
      dispatch(repo, settings.ci.workflow, branch, {});
      ci = ` Dispatched ${settings.ci.workflow} on ${branch}.`;
    }
    const mode = r.publish === "draft-and-bump" ? "Draft created and version bump pushed; the project's CI publishes it." : "Published.";
    return {
      success: true,
      data: { published: true, tag, sha: bumpSha, summary: `### Release ${tag}\n\n${mode}${ci}\n\nCommit ${bumpSha.slice(0, 8)} on ${branch}.` },
    };
  }
}

export const TASKS = {
  "release.plan": ReleasePlan,
  "release.gates": ReleaseGates,
  "release.prepare_notes": ReleasePrepareNotes,
  "release.publish": ReleasePublish,
};
