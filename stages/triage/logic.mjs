// Triage rules. Pure, so every rule is under unit test; tasks/triage.mjs
// gathers the facts and performs the writes.

import { quote, sanitize, sentence } from "../../lib/text.mjs";

export const MARKER = "<!-- repo-agents:triage -->";
export const MAINTAINERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const OUTCOMES = ["accept", "duplicate", "fixed", "move", "limitation", "needs-info", "invalid", "needs-human"];

/** The decision schema. moveTo exists only when the project routes anywhere. */
export function decisionSchema(settings) {
  const keys = settings.routing.map((r) => r.key);
  const props = {
    outcome: { type: "string", enum: keys.length ? OUTCOMES : OUTCOMES.filter((o) => o !== "move") },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    kind: { type: "string", enum: ["bug", "enhancement", "documentation", "question"] },
    areas: { type: "array", items: { type: "string" }, maxItems: 5 },
    duplicateOf: { type: "integer", minimum: 1 },
    fixCommit: { type: "string", pattern: "^[0-9a-f]{7,40}$" },
    questions: { type: "array", items: { type: "string", maxLength: 300 }, maxItems: 4 },
    summary: { type: "string", maxLength: 700 },
    evidence: { type: "string", maxLength: 2000 },
  };
  if (keys.length) props.moveTo = { type: "string", enum: keys };
  return {
    type: "object",
    additionalProperties: false,
    required: ["outcome", "confidence", "kind", "areas", "summary", "evidence"],
    properties: props,
  };
}

const STOP = new Set("a an the and or not no of to in on for with from by is are was be it this that when after before into via does do cannot can't cant fails fail error issue bug add support use using".split(" "));

/**
 * Search queries for duplicate candidates: identifiers (snake_case, dotted,
 * call-like), quoted error text, and the title's content words.
 */
export function duplicateQueries(title, body = "") {
  const text = `${title}\n${body.slice(0, 4000)}`;
  const idents = [...new Set(text.match(/\b[a-z][a-z0-9]*(?:[_.][a-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b\w+(?=\()/g) ?? [])].slice(0, 4);
  const quoted = [...new Set((text.match(/["'`]([^"'`\n]{12,80})["'`]/g) ?? []).map((q) => q.slice(1, -1)))].slice(0, 2);
  const words = title.toLowerCase().replace(/[^a-z0-9_ ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 6);
  const queries = [];
  if (words.length) queries.push(words.join(" "));
  for (const i of idents) queries.push(i);
  for (const q of quoted) queries.push(`"${q}"`);
  return [...new Set(queries)].slice(0, 6);
}

export function candidateTable(candidates, self) {
  // Only older issues: a duplicate points at the earlier report, never a later one.
  const rows = candidates.filter((c) => c.number < self).sort((a, b) => b.number - a.number).slice(0, 25);
  if (!rows.length) return "No candidates found by the pre-search. Run your own searches.";
  return ["| # | state | title |", "|---|---|---|", ...rows.map((c) => `| #${c.number} | ${c.state.toLowerCase()} | ${c.title.replace(/\|/g, "/")} |`)].join("\n");
}

export function routingTable(settings) {
  if (!settings.routing.length) return "This project routes nowhere else; `move` is not available.";
  return ["| moveTo | Owns |", "|---|---|", ...settings.routing.map((r) => `| \`${r.key}\` | ${r.owns} |`)].join("\n");
}

export function areaLabels(settings, repoLabels) {
  const reserved = new Set([...settings.labels.reserved, ...Object.values(settings.labels).filter((v) => typeof v === "string")]);
  const routed = new Set(settings.routing.map((r) => r.label).filter(Boolean));
  return [...repoLabels].filter((l) => !reserved.has(l) && !routed.has(l) && !l.startsWith("plugin:")).sort();
}

export function shouldTriage(eventName, issue, settings) {
  if (eventName === "workflow_dispatch") return true;
  if (!issue || issue.isPullRequest || issue.state !== "open") return false;
  return !(settings.triage.skip_maintainers && MAINTAINERS.has(issue.association));
}

/**
 * The outcome that will actually be applied. Unbacked claims and closures
 * below high confidence become needs-human, with the reason.
 */
export function resolveDecision(decision, facts, settings, mode) {
  if (!decision) return { outcome: "needs-human", reason: "the agent returned no decision", silent: true };
  const proposed = decision.outcome;
  const downgrade = (reason) => ({ outcome: "needs-human", reason, proposed });
  const extra = {};

  if (proposed === "duplicate") {
    const dup = facts.duplicate;
    if (!dup || dup.number === facts.issue.number || dup.isPullRequest) {
      return downgrade(`#${decision.duplicateOf ?? "?"} is not another issue in this repository`);
    }
    extra.duplicate = dup;
  }
  if (proposed === "fixed") {
    if (!facts.fix?.onDefault) return downgrade(`commit ${decision.fixCommit ?? "(none)"} is not on the default branch`);
    extra.fix = facts.fix;
  }
  if (proposed === "move") {
    const dest = settings.routing.find((r) => r.key === decision.moveTo);
    if (!dest) return downgrade(`unknown destination ${decision.moveTo ?? "(none)"}`);
    if (dest.repo && !facts.canTransfer) return downgrade(`moving to ${dest.repo} needs the agents token`);
    extra.dest = dest;
  }
  if (proposed === "limitation" && !sanitize(decision.summary)) return downgrade("a limitation needs a named blocker");
  if (proposed === "needs-info" && !(decision.questions ?? []).some((q) => sanitize(q))) return downgrade("needs-info without questions");

  const closes =
    proposed === "duplicate" ||
    proposed === "invalid" ||
    (proposed === "move" && Boolean(extra.dest.repo)) ||
    (proposed === "fixed" && Boolean(fixClosesNow(extra.fix, settings)));
  if (closes && decision.confidence !== "high") return downgrade(`${decision.confidence} confidence; closing needs high`);
  if (closes && mode === "propose") return { outcome: "proposed", proposed, closes, ...extra };
  return { outcome: proposed, closes, ...extra };
}

/** A verified fix closes the issue now: released in a stable tag, or merged when issues close on merge. */
export function fixClosesNow(fix, settings) {
  if (!fix) return false;
  return Boolean(fix.releasedIn) || (settings.closeout.close_on === "merge" && Boolean(fix.onDefault));
}

export function outcomeText(outcome, r, decision, ctx) {
  const s = sanitize(decision?.summary);
  const L = ctx.settings.labels;
  switch (outcome) {
    case "duplicate": {
      const dup = r.duplicate;
      const shipping = dup.state === "open" && dup.labels.includes(L.fixed_pending) ? "The fix is on the default branch and ships in the next release." : "";
      return sentence(`Duplicate of #${dup.number}.`, shipping, s);
    }
    case "fixed": {
      const { short, releasedIn, prerelease } = r.fix;
      if (releasedIn) {
        return sentence(`Fixed in ${short}, released in ${releasedIn}.`, s, `Comment here if it still reproduces on ${ctx.latestRelease ?? releasedIn} or later.`);
      }
      if (ctx.settings.closeout.close_on === "merge") {
        return sentence(`Fixed in ${short} on the default branch.`, s, "Comment here if it still reproduces on that commit or later.");
      }
      const hint = ctx.settings.closeout.prerelease_install_hint;
      const beta = prerelease ? `, available in ${prerelease}${hint ? ` (\`${hint}\`)` : ""}` : "";
      return sentence(`Fixed in ${short}${beta}.`, s, "This issue closes when the next stable release ships.");
    }
    case "move":
      return r.dest.repo
        ? sentence(`This belongs in ${r.dest.repo}, so it is moving there.`, s)
        : sentence(`This belongs to ${r.dest.key}; it stays here under the \`${r.dest.label}\` label.`, s);
    case "limitation":
      return s;
    case "needs-info": {
      const qs = (decision.questions ?? []).map((q) => sanitize(q)).filter(Boolean).map((q) => `- ${q}`);
      return [s, qs.join("\n")].filter(Boolean).join("\n\n");
    }
    case "invalid":
      return s || "Closed: this is not about this project.";
    default:
      return null;
  }
}

/** Labels, comment, close, transfer and follow-up dispatch for a resolved outcome. */
export function planActions(r, decision, ctx) {
  const { settings, repoLabels } = ctx;
  const L = settings.labels;
  const allowedAreas = new Set(areaLabels(settings, repoLabels));
  const add = new Set();
  const remove = new Set([L.needs_human]);
  let comment = null;
  let close = null;
  let transfer = null;
  let dispatch = null;

  if (decision && repoLabels.has(decision.kind)) add.add(decision.kind);
  for (const a of (decision?.areas ?? []).filter((a) => allowedAreas.has(a)).slice(0, 3)) add.add(a);

  switch (r.outcome) {
    case "accept":
      add.add(L.triaged);
      if (settings.triage.auto_resolve && settings.resolve.enabled && settings.triage.auto_resolve_kinds.includes(decision.kind)) {
        add.add(L.resolve);
        dispatch = { stage: "resolve" };
      }
      break;
    case "duplicate":
      add.add(L.duplicate);
      comment = outcomeText("duplicate", r, decision, ctx);
      close = "duplicate";
      break;
    case "fixed":
      add.add(L.triaged);
      comment = outcomeText("fixed", r, decision, ctx);
      if (fixClosesNow(r.fix, settings)) close = "completed";
      else add.add(L.fixed_pending);
      break;
    case "move":
      add.add(L.triaged);
      comment = outcomeText("move", r, decision, ctx);
      if (r.dest.repo) transfer = r.dest.repo;
      else add.add(r.dest.label);
      break;
    case "limitation":
      add.add(L.limitation);
      add.add(L.triaged);
      comment = outcomeText("limitation", r, decision, ctx);
      break;
    case "needs-info":
      add.add(L.needs_info);
      comment = outcomeText("needs-info", r, decision, ctx);
      break;
    case "invalid":
      add.add(L.invalid);
      comment = outcomeText("invalid", r, decision, ctx);
      close = "not_planned";
      break;
    case "proposed": {
      add.add(L.needs_human);
      remove.delete(L.needs_human);
      comment = `**Triage proposal**, applied only when a maintainer confirms it:\n\n${quote(outcomeText(r.proposed, r, decision, ctx))}`;
      break;
    }
    case "needs-human": {
      add.add(L.needs_human);
      remove.delete(L.needs_human);
      if (!r.silent) {
        comment = sentence("Automated triage left this for a maintainer.", sanitize(decision?.summary)) +
          `\n\n<details><summary>Triage notes</summary>\n\nProposed: \`${r.proposed}\` (${decision?.confidence} confidence). Not applied: ${r.reason}.\n\n</details>`;
      }
      break;
    }
  }
  for (const l of add) remove.delete(l);
  return { add: [...add], remove: [...remove], comment, marker: MARKER, close, transfer, dispatch };
}
