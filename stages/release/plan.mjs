// Release planning rules. Pure: tasks/release.mjs gathers the facts.

import { compareVersions, parseVersion } from "./version.mjs";

function versionOf(tag) {
  try { parseVersion(tag); return String(tag).replace(/^v/, ""); } catch { return null; }
}

/**
 * A draft release that blocks this one: a draft for `next`, or for any version
 * newer than the latest published release. Returns its tag or null.
 */
export function pendingDraft(releaseList, next) {
  const published = releaseList.filter((r) => !r.isDraft).map((r) => versionOf(r.tagName)).filter(Boolean);
  const latest = published.sort(compareVersions).pop() ?? null;
  for (const r of releaseList.filter((x) => x.isDraft)) {
    const v = versionOf(r.tagName);
    if (!v) continue;
    if (compareVersions(v, next) === 0 || !latest || compareVersions(v, latest) > 0) return r.tagName;
  }
  return null;
}

/** Whether a workflow's latest run on `sha` passed. runs come newest first from gh run list. */
export function workflowCheck(name, runs, sha) {
  const run = (runs ?? []).find((r) => r.headSha === sha);
  if (!run) return { name, ok: false, reason: `${name} has no run on ${sha.slice(0, 8)}` };
  if (run.status !== "completed") return { name, ok: false, reason: `${name} is still ${run.status} on ${sha.slice(0, 8)}` };
  if (run.conclusion !== "success") return { name, ok: false, reason: `${name} concluded ${run.conclusion} on ${sha.slice(0, 8)}` };
  return { name, ok: true, reason: "" };
}

/** The release decision from the gathered facts. */
export function decidePlan({ enabled, shippable, minChanges, force, workflows = [], draft = null, version }) {
  if (!enabled) return { should_release: false, reason: "release is disabled (settings.release.enabled)" };
  const blockers = [
    ...(draft ? [`draft release ${draft} is still pending; publish or delete it first`] : []),
    ...workflows.filter((w) => !w.ok).map((w) => w.reason),
  ];
  if (blockers.length) return { should_release: false, reason: blockers.join("; ") };
  if (shippable < minChanges && !force) {
    return { should_release: false, reason: `${shippable} shippable commit(s) since the last release, ${minChanges} needed` };
  }
  return { should_release: true, reason: `releasing v${version}: ${shippable} shippable commit(s)${force && shippable < minChanges ? ", forced" : ""}` };
}
