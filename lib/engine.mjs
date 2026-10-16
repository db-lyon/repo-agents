// Builds the flowkit runner for a project.
//
// Layers, lowest first: the toolkit's flows/*.yml, then the project's
// .github/repo-agents.yml, then .github/repo-agents.<REPO_AGENTS_ENV>.yml and
// .github/repo-agents.local.yml when present. A project overrides settings,
// task options and flow steps in the same file, flowkit's way: steps are keyed
// by number, so an overlay can insert a step (15) or switch one off (task: None).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { EngineConfigSchema, FlowRunner, TaskRegistry, deepMerge, loadConfig, resolveReferences } from "@db-lyon/flowkit";
import { DEFAULTS, SettingsSchema, merge, validate } from "./config.mjs";
import { createHooks } from "./hooks.mjs";
import { createWriter } from "./write.mjs";
import { TASKS } from "../tasks/index.mjs";

export const TOOLKIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ConfigSchema = EngineConfigSchema.extend({ settings: SettingsSchema.default({}) });

/** The toolkit's own flows and task definitions, merged from flows/*.yml. */
export function baseConfig() {
  const dir = path.join(TOOLKIT_ROOT, "flows");
  let base = { tasks: {}, flows: {}, settings: {} };
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".yml")).sort()) {
    base = deepMerge(base, YAML.parse(fs.readFileSync(path.join(dir, f), "utf8")) ?? {});
  }
  return base;
}

export function loadProject({ root = process.cwd(), file = process.env.REPO_AGENTS_CONFIG || ".github/repo-agents.yml" } = {}) {
  const full = path.resolve(root, file);
  const defaults = baseConfig();
  let config;
  if (fs.existsSync(full)) {
    ({ config } = loadConfig({
      filename: path.basename(full),
      configDir: path.dirname(full),
      schema: ConfigSchema,
      defaults,
      envVar: "REPO_AGENTS_ENV",
      strict: true,
    }));
  } else {
    config = ConfigSchema.parse(defaults);
  }
  const settings = validate(merge(DEFAULTS, config.settings ?? {}));
  return { config, settings, root };
}

const consoleLogger = (bindings = {}) => {
  const name = bindings.task ?? bindings.name ?? bindings.component;
  const prefix = typeof name === "string" ? `[${name}] ` : "";
  return {
    debug: () => {},
    info: (...a) => console.log(prefix + a.map(String).join(" ")),
    warn: (...a) => console.warn(prefix + a.map(String).join(" ")),
    error: (...a) => console.error(prefix + a.map(String).join(" ")),
    child: (b) => consoleLogger({ ...bindings, ...(b && typeof b === "object" ? b : { name: String(b) }) }),
  };
};

/**
 * when: and checks: expressions. A ${...} reference, optionally negated with
 * a leading ! or "not", tested for truthiness. An empty array is false.
 */
export function evaluateCondition(expr, ctx) {
  let s = String(expr).trim();
  let negate = false;
  const m = /^(!|not\s+)\s*/.exec(s);
  if (m) { negate = true; s = s.slice(m[0].length); }
  const v = resolveReferences(s, { steps: ctx.steps ?? [], error: ctx.error, namespaces: ctx.references ?? {} });
  return truthy(v) !== negate;
}

function truthy(v) {
  if (typeof v === "boolean") return v;
  if (v == null) return false;
  if (typeof v === "number") return v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  const s = String(v).trim().toLowerCase();
  return !["", "false", "0", "null", "undefined"].includes(s);
}

/**
 * The runner, its write seam and its hooks. outdir is where the audit trail
 * lands; hooks replaces the Actions hooks and perform the GitHub call behind
 * each allowed write (tests pass their own).
 */
export function createRunner({ root = process.cwd(), file, hooks, outdir = "", perform } = {}) {
  const { config, settings } = loadProject({ root, file });
  const registry = new TaskRegistry();
  registry.registerAll(TASKS);
  const logger = consoleLogger();
  const writer = createWriter({ settings, registry, tasks: config.tasks, root, logger, ...(perform ? { perform } : {}) });
  const runner = new FlowRunner({
    tasks: config.tasks,
    flows: config.flows,
    registry,
    context: { settings, root, toolkitRoot: TOOLKIT_ROOT, logger, writer },
    references: { settings },
    conditionEvaluator: evaluateCondition,
    strictStepReferences: true,
    logger,
    hooks: hooks ?? createHooks({ writer, outdir }),
  });
  return { runner, config, settings, writer, registry };
}
