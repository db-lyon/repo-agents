// The write seam. Every GitHub write the toolkit makes goes through
// writer.write(op, invoke), which runs flowkit's guard pipeline around it.
// The stage planners decide what to do; the guards decide whether it may be
// done, so a planner bug cannot turn into an unsafe write.
//
// An op describes the write, never performs it:
//   { stage, kind, target, text?, branch?, defaultBranch?, files?, reason?,
//     event?, confidence?, releasedIn?, pr?, mode? }
//
// A project adds guards as tasks named guard.<name>.<phase> in its config,
// with phase before or after, optionally scoped: beforeClose, beforePush,
// beforeMerge, beforeRelease, beforePublicText. The task receives { op }.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { GuardRegistry, discoverTaskGuards, guardContextBase, runGuarded } from "@db-lyon/flowkit";
import { policyAllows } from "../stages/review/review.mjs";
import { matchesAny } from "./text.mjs";

export const KINDS = [
  "label", "unlabel", "comment", "close", "transfer", "dispatch",
  "push", "delete_branch", "pr_create", "pr_edit", "pr_label",
  "review", "dismiss", "merge", "release_create", "release_delete",
];
export const PUBLIC_TEXT_KINDS = new Set(["comment", "push", "pr_create", "pr_edit", "review", "release_create"]);
const CONFIDENCE_KINDS = new Set(["close", "transfer", "merge"]);
const AGENT_STAGES = new Set(["triage", "review"]);
const CLOSING = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s*:?\s+(?:[\w.-]+\/[\w.-]+)?#\d+/i;
const BANNED_CHARS = [String.fromCharCode(0x2014), String.fromCharCode(0x2026)];

export class WriteDenied extends Error {
  constructor(guard, op, reason) {
    super(`${op.stage} ${op.kind} ${op.target ?? ""}: denied by ${guard}: ${reason}`.replace(/\s+:/, ":"));
    this.name = "WriteDenied";
    this.guard = guard;
    this.reason = reason;
  }
}

/** One toolkit guard: a pure check over the op. Returns a reason to deny, or null. */
function guard(name, order, check) {
  return {
    name,
    order,
    async before(ctx) {
      const reason = check(ctx.op, ctx.settings, ctx.state);
      if (reason) throw new WriteDenied(name, ctx.op, reason);
    },
  };
}

function stageMode(op, settings) {
  return op.mode ?? settings[op.stage]?.mode ?? "act";
}

export const TOOLKIT_GUARDS = [
  guard("mode", 10, (op, settings) => {
    const mode = stageMode(op, settings);
    if (mode === "dry-run") return "dry-run mode makes no writes";
    if (mode === "propose" && ["close", "transfer", "merge"].includes(op.kind)) return `propose mode does not ${op.kind}`;
    return null;
  }),
  guard("rate", 20, (op, settings, state) => {
    if (state.writes >= settings.limits.writes_per_run) return `more than limits.writes_per_run (${settings.limits.writes_per_run}) writes in one run`;
    state.writes += 1;
    return null;
  }),
  guard("confidence", 30, (op) => {
    if (!AGENT_STAGES.has(op.stage)) return null;
    const gated = CONFIDENCE_KINDS.has(op.kind) || (op.kind === "review" && op.event === "APPROVE");
    if (gated && op.confidence !== "high") return `${op.event === "APPROVE" ? "approve" : op.kind} needs high confidence, got ${op.confidence ?? "none"}`;
    return null;
  }),
  guard("close_policy", 40, (op) => {
    if (op.kind !== "close") return null;
    if (["duplicate", "not_planned"].includes(op.reason)) return null;
    if (op.reason === "completed" && op.releasedIn) return null;
    return `closing as ${op.reason ?? "unknown"} needs a fix in a published stable release`;
  }),
  guard("push_targets", 50, (op, settings) => {
    if (op.kind !== "push" && op.kind !== "delete_branch") return null;
    if (!op.branch) return "no target branch";
    if (op.branch === op.defaultBranch && (op.stage !== "release" || op.kind === "delete_branch")) return `${op.stage} may not ${op.kind === "push" ? "push to" : "delete"} the default branch`;
    if (op.stage === "resolve" && !op.branch.startsWith(settings.resolve.branch_prefix)) return `branch ${op.branch} is outside ${settings.resolve.branch_prefix}`;
    return null;
  }),
  guard("paths", 60, (op, settings) => {
    if (op.kind !== "push" || op.stage !== "resolve") return null;
    const hits = (op.files ?? []).filter((f) => matchesAny(f, settings.resolve.protected_paths));
    return hits.length ? `touches protected paths: ${hits.join(", ")}` : null;
  }),
  guard("merge_policy", 70, (op, settings) => {
    if (op.kind !== "merge") return null;
    const pr = op.pr;
    if (!pr) return "no pull request facts";
    if (pr.isDraft) return "the pull request is a draft";
    if (!policyAllows(pr, settings)) return `review.auto_merge is ${settings.review.auto_merge}`;
    const files = pr.files ?? [];
    const human = files.filter((f) => matchesAny(f, settings.review.human_paths));
    if (human.length) return `touches paths that need a human: ${human.join(", ")}`;
    if ((pr.labels ?? []).includes(settings.resolve.unverifiable_label) || files.some((f) => matchesAny(f, settings.resolve.unverifiable_paths))) {
      return "needs native verification";
    }
    return null;
  }),
  guard("prose", 80, (op, settings) => {
    if (!PUBLIC_TEXT_KINDS.has(op.kind) || !op.text) return null;
    // Fenced code is quoted output (verify logs), not prose.
    const prose = op.text.replace(/(`{3,})[\s\S]*?\1/g, "");
    const lower = prose.toLowerCase();
    const banned = [...BANNED_CHARS, ...settings.project.banned_phrases].filter((p) => p && lower.includes(String(p).toLowerCase()));
    if (banned.length) return `contains banned text: ${banned.map((b) => JSON.stringify(b)).join(", ")}`;
    if (settings.closeout.close_on === "release" && ["push", "pr_create", "pr_edit"].includes(op.kind) && CLOSING.test(prose)) {
      return "uses a closing keyword; issues close only when a release ships the fix";
    }
    return null;
  }),
];

const SCOPES = {
  close: (ctx) => ctx.op.kind === "close",
  push: (ctx) => ctx.op.kind === "push",
  merge: (ctx) => ctx.op.kind === "merge",
  release: (ctx) => ctx.op.kind === "release_create",
  public_text: (ctx) => PUBLIC_TEXT_KINDS.has(ctx.op.kind) && Boolean(ctx.op.text),
};

/** Register the project's guard.* tasks, then turn them into guards. */
async function projectGuards({ registry, tasks, root, settings, logger }) {
  for (const [name, def] of Object.entries(tasks ?? {})) {
    if (!name.startsWith("guard.")) continue;
    const cp = def?.class_path;
    if (!cp) throw new Error(`task ${name} has no class_path`);
    const ctor = cp.startsWith(".") || path.isAbsolute(cp)
      ? (await import(pathToFileURL(path.resolve(root, cp)).href)).default
      : await registry.resolve(cp);
    if (typeof ctor !== "function") throw new Error(`task ${name}: ${cp} has no default export`);
    registry.register(name, ctor);
  }
  return discoverTaskGuards(registry, {
    scopes: SCOPES,
    contextFor: () => ({ settings, root, logger }),
    optionsFor: (ctx) => ({ op: ctx.op }),
    onDeny: (info) => new WriteDenied(info.guard, info.ctx.op, info.reason),
  });
}

/** Short, secret-free record of an op for the audit trail. */
function auditEntry(op, outcome, error) {
  const { pr, text, files, ...rest } = op;
  return {
    at: new Date().toISOString(),
    ...rest,
    ...(pr ? { pr: pr.number } : {}),
    ...(files ? { files: files.length } : {}),
    ...(text ? { text_chars: text.length } : {}),
    outcome,
    ...(error ? { error: String(error.message ?? error).slice(0, 300) } : {}),
  };
}

/**
 * The seam. registry and tasks are the runner's; project guards load on the
 * first write. perform runs an allowed write; tests replace it to record ops
 * instead of calling GitHub, with every guard still in place.
 */
export function createWriter({ settings, registry = null, tasks = {}, root = process.cwd(), logger = null, extraGuards = [], perform = (op, invoke) => invoke() }) {
  const state = { writes: 0 };
  const audit = [];
  let guards = null;

  async function load() {
    const reg = new GuardRegistry().registerAll([...TOOLKIT_GUARDS, ...extraGuards]);
    if (registry) reg.registerAll(await projectGuards({ registry, tasks, root, settings, logger }));
    return reg;
  }

  return {
    audit,
    /** Run invoke behind every guard. A denied write throws WriteDenied and never runs. */
    async write(op, invoke) {
      if (!KINDS.includes(op.kind)) throw new Error(`unknown write kind ${op.kind}`);
      guards ??= await load();
      const ctx = { ...guardContextBase(), op, settings, state };
      try {
        const result = await runGuarded(ctx, guards, async () => perform(op, invoke));
        audit.push(auditEntry(op, "done"));
        return result;
      } catch (e) {
        audit.push(auditEntry(op, e instanceof WriteDenied ? "denied" : "failed", e));
        throw e;
      }
    },
  };
}
