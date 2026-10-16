// Raw gh and git calls. A write function here is called only inside writer.write (lib/write.mjs), so every write passes the guards.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";

export function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  }).trim();
}

export function tryRun(cmd, args, opts) {
  try { return run(cmd, args, opts); } catch { return null; }
}

/** Run and keep the output on a non-zero exit (gh pr checks exits 8 while checks are pending). */
export function runKeep(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
  return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? r.error?.message ?? "").trim() };
}

export function succeeds(cmd, args, opts) {
  return tryRun(cmd, args, opts) !== null;
}

export function gh(args, opts) {
  return run("gh", args, opts);
}

export function ghJson(args, opts) {
  const out = tryRun("gh", args, opts);
  return out ? JSON.parse(out) : null;
}

/**
 * The repository from the environment. REPO_AGENTS_REPOSITORY wins over
 * GITHUB_REPOSITORY, because Actions ignores a workflow's assignment to a
 * GITHUB_* variable, so tests and cross-repo runs need a variable of their own.
 */
export function envRepo(env = process.env) {
  return env.REPO_AGENTS_REPOSITORY || env.GITHUB_REPOSITORY || "";
}

export function repoSlug() {
  return envRepo() || gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
}

export function issue(repo, n) {
  const i = ghJson(["api", `repos/${repo}/issues/${n}`]);
  if (!i) return null;
  return {
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    state: i.state,
    locked: i.locked,
    author: i.user?.login,
    association: i.author_association,
    isPullRequest: Boolean(i.pull_request),
    labels: i.labels.map((l) => (typeof l === "string" ? l : l.name)),
  };
}

export function repoLabels(repo) {
  return new Set((ghJson(["label", "list", "--repo", repo, "--limit", "500", "--json", "name"]) ?? []).map((l) => l.name));
}

const LABEL_COLORS = ["C2E0C6", "FBCA04", "D876E3", "BFD4F2", "0E8A16", "D93F0B", "5319E7"];

export function ensureLabel(repo, name, description = "") {
  const color = LABEL_COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % LABEL_COLORS.length];
  tryRun("gh", ["label", "create", name, "--repo", repo, "--color", color, "--description", description]);
}

export function addLabels(repo, n, labels) {
  const list = [...new Set(labels)].filter(Boolean);
  if (!list.length) return;
  for (const l of list) ensureLabel(repo, l);
  gh(["issue", "edit", String(n), "--repo", repo, "--add-label", list.join(",")]);
}

/** Labels on a pull request; gh issue edit refuses PR numbers. */
export function addPrLabels(repo, n, labels) {
  const list = [...new Set(labels)].filter(Boolean);
  if (!list.length) return;
  for (const l of list) ensureLabel(repo, l);
  gh(["pr", "edit", String(n), "--repo", repo, "--add-label", list.join(",")]);
}

export function removeLabels(repo, n, labels) {
  for (const l of labels) tryRun("gh", ["issue", "edit", String(n), "--repo", repo, "--remove-label", l]);
}

/** Post a comment, or edit the earlier one carrying the same marker. */
export function upsertComment(repo, n, marker, body) {
  const pages = ghJson(["api", "--paginate", "--slurp", `repos/${repo}/issues/${n}/comments`]) ?? [];
  const mine = pages.flat().find((c) => c.body?.includes(marker));
  const full = `${marker}\n${body}`;
  if (mine) gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${mine.id}`, "-f", `body=${full}`]);
  else gh(["api", "-X", "POST", `repos/${repo}/issues/${n}/comments`, "-f", `body=${full}`]);
}

export function closeIssue(repo, n, reason) {
  const close = (r) => gh(["api", "-X", "PATCH", `repos/${repo}/issues/${n}`, "-f", "state=closed", "-f", `state_reason=${r}`]);
  try { close(reason); } catch { close(reason === "duplicate" ? "not_planned" : "completed"); }
}

/** Published releases; drafts too with { drafts: true }. */
export function releases(repo, { drafts = false } = {}) {
  return (ghJson(["release", "list", "--repo", repo, "--limit", "200", "--json", "tagName,isDraft,isPrerelease,isLatest,publishedAt"]) ?? [])
    .filter((r) => drafts || !r.isDraft);
}

export function defaultBranch(repo) {
  return gh(["api", `repos/${repo}`, "--jq", ".default_branch"]);
}

export function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  else console.log(text);
}

export function setOutput(key, value) {
  const line = `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`;
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  else console.log(line);
}

/** Dispatch a workflow in this repo. Works with GITHUB_TOKEN, unlike most events. */
export function dispatch(repo, workflow, ref, inputs) {
  const args = ["workflow", "run", workflow, "--repo", repo, "--ref", ref];
  for (const [k, v] of Object.entries(inputs)) args.push("-f", `${k}=${v}`);
  gh(args);
}
