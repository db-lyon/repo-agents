// Settings: the defaults in flows/settings.yml, the schema that rejects
// unknown keys, and the value checks zod cannot express from the defaults.
// Every stage reads its section from the merged result, so a project only
// writes what differs from the defaults.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";

export const DEFAULT_CONFIG_PATH = ".github/repo-agents.yml";
export const SETTINGS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "flows", "settings.yml");
export const DEFAULTS = YAML.parse(fs.readFileSync(SETTINGS_FILE, "utf8")).settings;

function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

export function merge(base, over) {
  if (!isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObject(base?.[k]) ? merge(base[k], v) : v;
  return out;
}

/**
 * A zod schema shaped like the defaults: every declared key is optional and
 * typed loosely, and any undeclared key is unknown, which strict loading turns
 * into an error with a suggestion.
 */
export function shapeOf(value) {
  if (Array.isArray(value)) return z.array(z.any());
  if (isObject(value)) return z.object(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shapeOf(v).optional()])));
  return z.any();
}

export const SettingsSchema = shapeOf(DEFAULTS);

export function validate(cfg) {
  const errors = [];
  if (!["act", "propose", "dry-run"].includes(cfg.triage.mode)) errors.push(`triage.mode: ${cfg.triage.mode}`);
  if (!["none", "agents", "all"].includes(cfg.review.auto_merge)) errors.push(`review.auto_merge: ${cfg.review.auto_merge}`);
  if (!["merge", "release"].includes(cfg.closeout.close_on)) errors.push(`closeout.close_on: ${cfg.closeout.close_on}`);
  if (!["act", "dry-run"].includes(cfg.closeout.mode)) errors.push(`closeout.mode: ${cfg.closeout.mode}`);
  if (!["prerelease", "patch", "minor", "major"].includes(cfg.release.bump)) errors.push(`release.bump: ${cfg.release.bump}`);
  if (cfg.release.bump === "prerelease" && !cfg.release.preid) errors.push("release.preid: a prerelease bump needs a preid (beta, rc)");
  if (!["draft-and-bump", "publish"].includes(cfg.release.publish)) errors.push(`release.publish: ${cfg.release.publish}`);
  if (!["draft-pr", "comment"].includes(cfg.resolve.on_failure)) errors.push(`resolve.on_failure: ${cfg.resolve.on_failure}`);
  if (cfg.closeout.close_on === "release" && /^(close[sd]?|fix(e[sd])?|resolve[sd]?)$/i.test(cfg.resolve.issue_ref)) {
    errors.push(`resolve.issue_ref: ${cfg.resolve.issue_ref} closes the issue on merge, but closeout.close_on is release`);
  }
  for (const k of ["writes_per_run", "closeout_writes_per_run"]) {
    if (!(Number.isInteger(cfg.limits[k]) && cfg.limits[k] > 0)) errors.push(`limits.${k}: ${cfg.limits[k]}`);
  }
  for (const r of cfg.routing) {
    if (!r.key || !r.owns || (!r.repo && !r.label)) errors.push(`routing entry needs key, owns and repo or label: ${JSON.stringify(r)}`);
  }
  if (errors.length) throw new Error(`invalid repo-agents config:\n  ${errors.join("\n  ")}`);
  return cfg;
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
