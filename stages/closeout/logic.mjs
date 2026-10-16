// Closeout rules. Pure: the tasks gather facts from GitHub and git, these
// functions decide what each issue gets.
//
// closeout.merged: a merged PR's referenced issues close citing the PR
// (close_on merge) or get the fixed_pending label (close_on release).
// closeout.released: an issue's fix is every commit on the default branch
// that cites it (commit messages naming #N, merge commits of merged PRs that
// reference it, commit SHAs cited in its comments). A stable release that
// contains all of them closes the issue; a prerelease that contains all of
// them gets one comment saying where to get it. An issue with no fix commit
// found is listed in the summary and left alone.

export const CLOSE_MARKER = "<!-- repo-agents:closeout -->";
export const PRERELEASE_MARKER = "<!-- repo-agents:closeout:prerelease -->";

/** released: every fix commit is in the tag. pending: none is. partial: some are. unknown: none found. */
export function classify(fixCommits, inTag) {
  if (!fixCommits.length) return "unknown";
  const shipped = fixCommits.filter((c) => inTag(c)).length;
  if (shipped === fixCommits.length) return "released";
  return shipped ? "partial" : "pending";
}

export const NOT_RELEASED = {
  unknown: "no fix commit found",
  pending: "fix is not in this release",
  partial: "only some fix commits are in this release",
};

const short = (commits) => commits.map((c) => c.slice(0, 8)).join(", ");

export function closingComment(tag, commits) {
  return `Fixed in ${short(commits)}, released in ${tag}.`;
}

export function prereleaseComment(tag, commits, hint = "") {
  const install = hint ? ` Install it with \`${hint}\`.` : "";
  return `Available in ${tag} (fix: ${short(commits)}).${install} This issue closes when a stable release ships the fix.`;
}

export function mergedComment(pr, sha) {
  return `Fixed by #${pr}${sha ? ` (${sha.slice(0, 8)})` : ""}.`;
}

/** Hex runs in comment text that may be commit SHAs; callers keep only real commits on the default branch. */
export function citedShas(text) {
  return [...String(text ?? "").matchAll(/(?<![0-9a-zA-Z/#])([0-9a-f]{7,40})(?![0-9a-zA-Z])/g)]
    .map((m) => m[1])
    .filter((s) => /[a-f]/.test(s) && /[0-9]/.test(s));
}

const REFERENCE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|references?)\b\s*:?\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gi;

/**
 * Issue numbers in this repository that text references with a closing
 * keyword (Fixes #N, Closes owner/repo#N) or a plain reference (Refs #N).
 * A bare #N is a mention, not a reference, and is ignored.
 */
export function referencedIssues(text, repo) {
  const out = new Set();
  for (const m of String(text ?? "").matchAll(REFERENCE)) {
    if (m[1] && repo && m[1].toLowerCase() !== repo.toLowerCase()) continue;
    out.add(Number(m[2]));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * closeout.merged. pr: { number, mergeCommit }. issues: the referenced
 * issues as read from GitHub ({ number, title, state, labels, isPullRequest }).
 */
export function planMerged({ pr, issues, settings }) {
  const L = settings.labels;
  const onMerge = settings.closeout.close_on === "merge";
  const items = [];
  const lines = [];
  for (const i of issues) {
    if (!i || i.isPullRequest || i.number === pr.number) continue;
    if (i.state !== "open") {
      lines.push(`- #${i.number} already closed. ${i.title}`);
      continue;
    }
    if (onMerge) {
      items.push({
        number: i.number,
        remove: (i.labels ?? []).includes(L.fixed_pending) ? [L.fixed_pending] : [],
        comment: mergedComment(pr.number, pr.mergeCommit),
        marker: CLOSE_MARKER,
        close: "completed",
        fixedIn: `#${pr.number}`,
      });
      lines.push(`- #${i.number} closed. ${i.title}`);
    } else if ((i.labels ?? []).includes(L.fixed_pending)) {
      lines.push(`- #${i.number} already labeled ${L.fixed_pending}. ${i.title}`);
    } else {
      items.push({ number: i.number, add: [L.fixed_pending] });
      lines.push(`- #${i.number} labeled ${L.fixed_pending}. ${i.title}`);
    }
  }
  if (!issues.length) lines.push("- no referenced issues");
  return { items, lines };
}

/**
 * closeout.released. release: { isPrerelease }. issues: open fixed_pending
 * issues with { number, title, commits, state (from classify), announced }.
 */
export function planReleased({ tag, release, issues, settings }) {
  const c = settings.closeout;
  const L = settings.labels;
  const items = [];
  const lines = [];
  for (const i of issues) {
    if (i.state !== "released") {
      lines.push(`- #${i.number} ${i.state}: ${NOT_RELEASED[i.state]}. ${i.title}`);
      continue;
    }
    if (!release.isPrerelease) {
      items.push({
        number: i.number,
        remove: [L.fixed_pending],
        comment: closingComment(tag, i.commits),
        marker: CLOSE_MARKER,
        close: "completed",
        releasedIn: tag,
      });
      lines.push(`- #${i.number} closed. ${i.title}`);
    } else if (!c.announce_prereleases) {
      lines.push(`- #${i.number} in this prerelease, not announced (closeout.announce_prereleases is off). ${i.title}`);
    } else if (i.announced) {
      lines.push(`- #${i.number} already announced in an earlier prerelease. ${i.title}`);
    } else {
      items.push({ number: i.number, comment: prereleaseComment(tag, i.commits, c.prerelease_install_hint), marker: PRERELEASE_MARKER });
      lines.push(`- #${i.number} announced. ${i.title}`);
    }
  }
  if (!issues.length) lines.push(`- no open issues labeled ${L.fixed_pending}`);
  return { items, lines };
}
