// Loads a project's .github/repo-agents.yml and fills in defaults.
// Every stage reads its section from the merged result, so a project only
// writes what differs from these defaults.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

export const DEFAULT_CONFIG_PATH = ".github/repo-agents.yml";

export const DEFAULTS = {
  project: {
    name: "",
    // What this repository owns, in plain sentences. Agents use it to decide
    // whether an issue belongs here.
    description: "",
    // Files the agents read first for house rules (relative to the repo root).
    context_files: [],
    // Words and characters public text must not contain.
    banned_phrases: [],
    voice: "Plain, short sentences. No greetings, apologies or thanks. No em dashes.",
  },
  ci: {
    // The project's CI workflow file. Dispatched on agent branches and on the
    // release commit when pushes are made with github.token, which cannot
    // trigger push events. It needs a workflow_dispatch trigger.
    workflow: "",
  },
  // Trackers an issue can move to. key is what the agent names; repo means a
  // transfer, label means it stays here under that label.
  routing: [],
  labels: {
    triaged: "triaged",
    needs_human: "needs-triage",
    needs_info: "needs-info",
    fixed_pending: "fixed-pending-release",
    resolve: "resolve",
    in_progress: "agent-working",
    duplicate: "duplicate",
    invalid: "invalid",
    limitation: "limitation",
    // Labels that are never area labels.
    reserved: ["bug", "enhancement", "documentation", "question", "good first issue", "help wanted", "wontfix", "planned", "merge-blocked"],
  },
  triage: {
    enabled: true,
    mode: "act", // act | propose | dry-run
    model: "claude-sonnet-5-5",
    max_budget_usd: 2,
    max_turns: 40,
    skip_maintainers: true,
    // Accepted bugs and requests get the resolve label automatically.
    auto_resolve: false,
    auto_resolve_kinds: ["bug"],
  },
  resolve: {
    enabled: true,
    model: "claude-opus-5-5",
    max_budget_usd: 8,
    max_turns: 120,
    // Commands run before the agent starts (install dependencies).
    setup: [],
    // Commands that must pass for the fix to count. The agent may run them;
    // the workflow runs them again itself before opening the PR.
    verify: [],
    // Extra commands the agent may run, as Claude Code permission patterns.
    allow_commands: [],
    // Paths the agent must not change. A diff touching them is rejected.
    protected_paths: [".github/workflows/**"],
    // Paths CI cannot verify (native code, engine builds). A PR touching them
    // gets the label below and is never auto-merged.
    unverifiable_paths: [],
    unverifiable_label: "needs-native-verification",
    branch_prefix: "agents/issue-",
    // How the PR body refers to the issue. "Refs" keeps it open on merge.
    issue_ref: "Refs",
    // When verification fails: draft-pr keeps the work, comment drops it.
    on_failure: "draft-pr",
    commit_style: "conventional",
  },
  review: {
    enabled: true,
    model: "claude-sonnet-5-5",
    max_budget_usd: 3,
    max_turns: 60,
    // Which PRs merge themselves once approved and green: none | agents | all
    auto_merge: "agents",
    merge_method: "squash",
    // Paths that always need a human approval, whatever the verdict.
    human_paths: [],
  },
  closeout: {
    enabled: true,
    // merge: close issues when the fixing PR merges. release: label them
    // fixed_pending on merge and close when a stable release contains the fix.
    close_on: "release",
    announce_prereleases: true,
    prerelease_install_hint: "",
  },
  release: {
    enabled: false,
    model: "claude-sonnet-5-5",
    max_budget_usd: 2,
    max_turns: 40,
    // prerelease: X.Y.Z-<preid>.N  patch: X.Y.Z+1
    bump: "prerelease",
    preid: "beta",
    // Where the version lives. package.json is read and written natively;
    // anything else needs version_command.
    version_file: "package.json",
    version_command: "",
    // Release only when there is something to ship: at least this many commits
    // since the last release, ignoring chore/docs/ci/test commits.
    min_changes: 1,
    // Commands that must pass on the release commit before anything ships.
    gates: [],
    // Runner labels for the gate job, e.g. [self-hosted, ue].
    gate_runner: ["ubuntu-latest"],
    // Workflow names whose latest run on the default branch must be green.
    required_workflows: [],
    notes: {
      style_doc: "",
      // Frontmatter with a headline array at the top of the draft body.
      headline: false,
      headline_validate: "",
      // Link prefixes release notes may keep, beyond github.com.
      allow_links: [],
    },
    // draft-and-bump: create a draft release and push the version bump; the
    // project's own CI publishes. publish: tag and publish the release here.
    publish: "publish",
    bump_commit_message: "chore(release): {version}",
  },
};

function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

export function merge(base, over) {
  if (!isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObject(base?.[k]) ? merge(base[k], v) : v;
  return out;
}

export function validate(cfg) {
  const errors = [];
  if (!["act", "propose", "dry-run"].includes(cfg.triage.mode)) errors.push(`triage.mode: ${cfg.triage.mode}`);
  if (!["none", "agents", "all"].includes(cfg.review.auto_merge)) errors.push(`review.auto_merge: ${cfg.review.auto_merge}`);
  if (!["merge", "release"].includes(cfg.closeout.close_on)) errors.push(`closeout.close_on: ${cfg.closeout.close_on}`);
  if (!["prerelease", "patch", "minor", "major"].includes(cfg.release.bump)) errors.push(`release.bump: ${cfg.release.bump}`);
  if (!["draft-and-bump", "publish"].includes(cfg.release.publish)) errors.push(`release.publish: ${cfg.release.publish}`);
  if (!["draft-pr", "comment"].includes(cfg.resolve.on_failure)) errors.push(`resolve.on_failure: ${cfg.resolve.on_failure}`);
  for (const r of cfg.routing) {
    if (!r.key || !r.owns || (!r.repo && !r.label)) errors.push(`routing entry needs key, owns and repo or label: ${JSON.stringify(r)}`);
  }
  if (errors.length) throw new Error(`invalid repo-agents config:\n  ${errors.join("\n  ")}`);
  return cfg;
}

export function loadConfig(root = process.cwd(), file = process.env.REPO_AGENTS_CONFIG || DEFAULT_CONFIG_PATH) {
  const full = path.resolve(root, file);
  const raw = fs.existsSync(full) ? YAML.parse(fs.readFileSync(full, "utf8")) ?? {} : {};
  return validate(merge(DEFAULTS, raw));
}

/** The project's house rules, from its context files, for agent prompts. */
export function contextText(cfg, root = process.cwd(), maxChars = 30000) {
  let out = "";
  for (const f of cfg.project.context_files) {
    const p = path.resolve(root, f);
    if (!fs.existsSync(p)) continue;
    out += `\n\n--- ${f} ---\n${fs.readFileSync(p, "utf8")}`;
    if (out.length > maxChars) return `${out.slice(0, maxChars)}\n[truncated]`;
  }
  return out.trim();
}

/** Where stage files go between jobs: outside the project checkout, so a patch never picks them up. */
export function workDir(outdir) {
  if (outdir) return path.resolve(outdir);
  return path.resolve(process.env.REPO_AGENTS_WORK || path.join(process.env.RUNNER_TEMP || os.tmpdir(), "repo-agents-work"));
}
