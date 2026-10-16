// Every task class the toolkit registers, by class_path. Each tasks/<name>.mjs
// exports TASKS, a map of class_path to class; this file merges them.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ShellTask } from "@db-lyon/flowkit";

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = fs.readdirSync(here).filter((f) => f.endsWith(".mjs") && f !== "index.mjs").sort();

export const TASKS = { shell: ShellTask };
for (const f of modules) {
  const mod = await import(pathToFileURL(path.join(here, f)).href);
  for (const [name, cls] of Object.entries(mod.TASKS ?? {})) {
    if (TASKS[name]) throw new Error(`task ${name} is registered twice (${f})`);
    TASKS[name] = cls;
  }
}
