// repo-agents install: set a repository up for the agent suite.
//
// Labels, the two repository settings the stages rely on, and a pull request
// adding the caller workflow and a starter config. Nothing is pushed to the
// default branch; the maintainer merges the PR.

import fs from "node:fs";
import path from "node:path";
import { ensureLabel, gh, ghJson, tryRun } from "./github.mjs";
import { fill } from "./text.mjs";
import { TOOLKIT_ROOT } from "./engine.mjs";

export const CALLER_PATH = ".github/workflows/repo-agents.yml";
export const CONFIG_PATH = ".github/repo-agents.yml";
export const BRANCH = "repo-agents/install";
export const REQUIRED_SECRETS = ["ANTHROPIC_API_KEY"];
export const OPTIONAL_SECRETS = ["REPO_AGENTS_TOKEN"];
const EXTRA_LABELS = ["agents"];

/** Every label name the settings use, plus the PR label the stages add. */
export function labelNames(settings) {
  const names = Object.entries(settings.labels).filter(([k, v]) => k !== "reserved" && typeof v === "string").map(([, v]) => v);
  if (settings.resolve?.unverifiable_label) names.push(settings.resolve.unverifiable_label);
  for (const r of settings.routing ?? []) if (r.label) names.push(r.label);
  return [...new Set([...names, ...EXTRA_LABELS])];
}

/**
 * What install will do, from what the repository already has. Pure.
 * facts: { labels: Set, files: Set, secrets: Set, workflowPermissions, allowAutoMerge, openInstallPr }
 */
export function planInstall(settings, facts) {
  const steps = [];
  for (const l of labelNames(settings)) if (!facts.labels.has(l)) steps.push({ kind: "label", name: l });
  if (!facts.workflowPermissions?.can_approve_pull_request_reviews) steps.push({ kind: "allow_actions_approve" });
  if (!facts.allowAutoMerge) steps.push({ kind: "allow_auto_merge" });
  const files = [];
  if (!facts.files.has(CALLER_PATH)) files.push(CALLER_PATH);
  if (!facts.files.has(CONFIG_PATH)) files.push(CONFIG_PATH);
  if (files.length && !facts.openInstallPr) steps.push({ kind: "pull_request", files });
  const missing = REQUIRED_SECRETS.filter((s) => !facts.secrets.has(s));
  const optional = OPTIONAL_SECRETS.filter((s) => !facts.secrets.has(s));
  return { steps, missing, optional, pending: facts.openInstallPr ?? null };
}

export function starterConfig(repoInfo) {
  const template = fs.readFileSync(path.join(TOOLKIT_ROOT, "templates", "config.yml"), "utf8");
  const description = (repoInfo.description || `${repoInfo.name}: describe what this repository owns.`).replace(/\s+/g, " ").trim();
  return fill(template, { NAME: repoInfo.name, DESCRIPTION: description });
}

function facts(repo) {
  const info = ghJson(["api", `repos/${repo}`]);
  if (!info) throw new Error(`cannot read ${repo}; check the name and that gh is signed in with access`);
  const has = (p) => tryRun("gh", ["api", `repos/${repo}/contents/${p}`, "--jq", ".sha"]) !== null;
  const prs = ghJson(["pr", "list", "--repo", repo, "--head", BRANCH, "--state", "open", "--json", "number,url"]) ?? [];
  return {
    info,
    labels: new Set((ghJson(["label", "list", "--repo", repo, "--limit", "500", "--json", "name"]) ?? []).map((l) => l.name)),
    files: new Set([CALLER_PATH, CONFIG_PATH].filter(has)),
    secrets: new Set((ghJson(["secret", "list", "--repo", repo, "--json", "name"]) ?? []).map((s) => s.name)),
    workflowPermissions: ghJson(["api", `repos/${repo}/actions/permissions/workflow`]) ?? {},
    allowAutoMerge: Boolean(info.allow_auto_merge),
    openInstallPr: prs[0]?.url ?? null,
  };
}

function putFile(repo, file, content, branch, message) {
  gh(["api", "-X", "PUT", `repos/${repo}/contents/${file}`, "-f", `message=${message}`, "-f", `branch=${branch}`,
    "-f", `content=${Buffer.from(content).toString("base64")}`]);
}

/** Run the install. Returns printable lines. */
export function install({ repo, dryRun = false, settings }) {
  const f = facts(repo);
  const plan = planInstall(settings, f);
  const lines = [`repo-agents install ${repo}${dryRun ? " (dry run)" : ""}`];
  if (!plan.steps.length) lines.push("- nothing to change");
  for (const s of plan.steps) {
    if (s.kind === "label") {
      lines.push(`- create label ${s.name}`);
      if (!dryRun) ensureLabel(repo, s.name);
    } else if (s.kind === "allow_actions_approve") {
      lines.push("- let GitHub Actions approve pull requests (review posts approvals as the Actions bot)");
      if (!dryRun) {
        const perms = f.workflowPermissions.default_workflow_permissions ?? "read";
        gh(["api", "-X", "PUT", `repos/${repo}/actions/permissions/workflow`, "-f", `default_workflow_permissions=${perms}`, "-F", "can_approve_pull_request_reviews=true"]);
      }
    } else if (s.kind === "allow_auto_merge") {
      lines.push("- turn on auto-merge (review queues merges until checks pass)");
      if (!dryRun && tryRun("gh", ["api", "-X", "PATCH", `repos/${repo}`, "-F", "allow_auto_merge=true", "--jq", ".allow_auto_merge"]) !== "true") {
        lines.push("  not available on this plan; review merges directly once every check has passed");
      }
    } else if (s.kind === "pull_request") {
      lines.push(`- open a pull request adding ${s.files.join(" and ")}`);
      if (!dryRun) {
        const base = f.info.default_branch;
        const sha = gh(["api", `repos/${repo}/git/ref/heads/${base}`, "--jq", ".object.sha"]);
        tryRun("gh", ["api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${BRANCH}`, "-f", `sha=${sha}`]);
        if (s.files.includes(CALLER_PATH)) {
          putFile(repo, CALLER_PATH, fs.readFileSync(path.join(TOOLKIT_ROOT, "templates", "caller.yml"), "utf8"), BRANCH, "Add the repo-agents caller workflow");
        }
        if (s.files.includes(CONFIG_PATH)) putFile(repo, CONFIG_PATH, starterConfig(f.info), BRANCH, "Add a starter repo-agents config");
        const url = gh(["pr", "create", "--repo", repo, "--base", base, "--head", BRANCH, "--title", "Set up repo-agents",
          "--body", "Adds the caller workflow and a starter config. Fill in `project.description` and the resolve `setup` and `verify` commands before merging."]);
        lines.push(`  ${url}`);
      }
    }
  }
  if (plan.pending) lines.push(`- install pull request already open: ${plan.pending}`);
  for (const s of plan.missing) lines.push(`- missing secret ${s}: gh secret set ${s} --repo ${repo}`);
  for (const s of plan.optional) lines.push(`- optional secret ${s}: a fine-grained token with contents, issues and pull requests write, for transfers and for pushes and merges that must start other workflows`);
  return lines;
}

