// Version math and the project's version file. Pure apart from the file and
// command I/O in readVersion / writeVersion.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(v) {
  const m = String(v ?? "").trim().match(SEMVER);
  if (!m) throw new Error(`not a semver version: ${v}`);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : [] };
}

export function formatVersion({ major, minor, patch, pre }) {
  return `${major}.${minor}.${patch}${pre.length ? `-${pre.join(".")}` : ""}`;
}

/** One bump, no tag checks. Follows npm: a prerelease promotes to its base when that is the target. */
function bumpOnce(current, bump, preid) {
  const v = parseVersion(current);
  const isPre = v.pre.length > 0;
  const base = (major, minor, patch) => ({ major, minor, patch, pre: [] });
  switch (bump) {
    case "major":
      return formatVersion(isPre && v.minor === 0 && v.patch === 0 ? base(v.major, 0, 0) : base(v.major + 1, 0, 0));
    case "minor":
      return formatVersion(isPre && v.patch === 0 ? base(v.major, v.minor, 0) : base(v.major, v.minor + 1, 0));
    case "patch":
      return formatVersion(isPre ? base(v.major, v.minor, v.patch) : base(v.major, v.minor, v.patch + 1));
    case "prerelease": {
      if (!preid) throw new Error("prerelease bump needs a preid");
      const [id, n] = v.pre;
      if (isPre && id === preid && v.pre.length === 2 && /^\d+$/.test(n)) {
        return formatVersion({ ...v, pre: [preid, String(+n + 1)] });
      }
      if (isPre) return formatVersion({ ...v, pre: [preid, "1"] });
      return formatVersion({ ...v, patch: v.patch + 1, pre: [preid, "1"] });
    }
    default:
      throw new Error(`unknown bump: ${bump}`);
  }
}

/**
 * The version to release after `current`. Any candidate whose v-tag is in
 * existingTags (git tags and draft release tags) is skipped by bumping again.
 */
export function nextVersion(current, { bump, preid } = {}, existingTags = []) {
  const taken = new Set([...existingTags].map((t) => (String(t).startsWith("v") ? String(t) : `v${t}`)));
  let next = bumpOnce(current, bump, preid);
  for (let i = 0; taken.has(`v${next}`); i++) {
    if (i > 1000) throw new Error(`no free version after ${current}`);
    next = bumpOnce(next, bump, preid);
  }
  return next;
}

export function isPrerelease(version) {
  return parseVersion(version).pre.length > 0;
}

// Conventional commit types that never make a release on their own.
export const NON_SHIPPABLE_TYPES = ["chore", "docs", "ci", "test", "style", "build"];

/** The conventional type of a subject, or of the branch a merge commit merged. */
export function commitType(subject) {
  const conv = subject.match(/^(\w+)(?:\([^)]*\))?!?:/);
  if (conv) return conv[1].toLowerCase();
  const merge = subject.match(/^Merge pull request #\d+ from [^/\s]+\/(\S+)/) ?? subject.match(/^Merge branch '([^']+)'/);
  if (merge) {
    const prefix = merge[1].match(/^(\w+)[/-]/);
    return prefix ? prefix[1].toLowerCase() : null;
  }
  return null;
}

/** Filter `<sha> <subject>` lines to the ones that are worth a release. */
export function shippableCommits(lines) {
  const list = Array.isArray(lines) ? lines : String(lines ?? "").split("\n");
  return list
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(" ");
      return i < 0 ? { sha: l, subject: "" } : { sha: l.slice(0, i), subject: l.slice(i + 1).trim() };
    })
    .filter((c) => !NON_SHIPPABLE_TYPES.includes(commitType(c.subject)));
}

function isPackageJson(cfg) {
  return path.basename(cfg.release.version_file || "") === "package.json";
}

function runCommand(command, root) {
  return execFileSync("bash", ["-c", command], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The project's current version. */
export function readVersion(cfg, root = process.cwd()) {
  if (isPackageJson(cfg)) {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(root, cfg.release.version_file), "utf8"));
    return formatVersion(parseVersion(pkg.version));
  }
  if (!cfg.release.version_command) throw new Error("release.version_command is required when version_file is not package.json");
  const out = runCommand(cfg.release.version_command.replace(/\{version\}/g, "").trim(), root);
  return formatVersion(parseVersion(out.split("\n").pop()));
}

/**
 * Replace the top-level "version" of package.json text, keeping every other
 * byte: indent, inline objects, line endings and the trailing newline.
 */
export function setPackageVersion(text, version) {
  const indent = text.match(/^\{\r?\n([ \t]+)"/)?.[1];
  if (indent !== undefined) {
    const re = new RegExp(`^(${indent}"version"\\s*:\\s*)"[^"]*"`, "m");
    if (re.test(text)) return text.replace(re, `$1${JSON.stringify(version)}`);
  }
  // Minified or no version key yet: rewrite the object.
  const pkg = JSON.parse(text);
  pkg.version = version;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const out = JSON.stringify(pkg, null, indent ?? (text.trim().includes("\n") ? 2 : 0)).replace(/\n/g, eol);
  return /\r?\n$/.test(text) ? `${out}${eol}` : out;
}

/** Write the new version where the project keeps it. */
export function writeVersion(cfg, root = process.cwd(), version) {
  formatVersion(parseVersion(version));
  if (isPackageJson(cfg)) {
    const file = path.resolve(root, cfg.release.version_file);
    fs.writeFileSync(file, setPackageVersion(fs.readFileSync(file, "utf8"), version));
    return;
  }
  if (!cfg.release.version_command) throw new Error("release.version_command is required when version_file is not package.json");
  if (!cfg.release.version_command.includes("{version}")) throw new Error("release.version_command needs {version} to write a version");
  runCommand(cfg.release.version_command.replace(/\{version\}/g, version), root);
}

/** Semver precedence: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return +p - +q;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * The version to release: the current one when it has never been tagged or
 * released (a first release, or a bump made by hand), else the next one.
 */
export function releaseVersion(current, opts, existingTags = []) {
  const taken = new Set(existingTags.map((t) => String(t).replace(/^v/, "")));
  return taken.has(String(current)) ? nextVersion(current, opts, existingTags) : String(current);
}
