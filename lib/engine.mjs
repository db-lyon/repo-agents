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
import { z } from "zod";
import { EngineConfigSchema, FlowRunner, TaskRegistry, deepMerge, loadConfig } from "@db-lyon/flowkit";
import { DEFAULTS, merge, validate } from "./config.mjs";
import { TASKS } from "../tasks/index.mjs";

export const TOOLKIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ConfigSchema = EngineConfigSchema.extend({ settings: z.record(z.unknown()).default({}) });

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

export function createRunner({ root = process.cwd(), file, hooks } = {}) {
  const { config, settings } = loadProject({ root, file });
  const registry = new TaskRegistry();
  registry.registerAll(TASKS);
  const logger = consoleLogger();
  const runner = new FlowRunner({
    tasks: config.tasks,
    flows: config.flows,
    registry,
    context: { settings, root, toolkitRoot: TOOLKIT_ROOT, logger },
    references: { settings },
    logger,
    hooks,
  });
  return { runner, config, settings };
}
