// Runner hooks: the one place step results reach GitHub Actions. A task
// returns data.summary (markdown for the job summary) and data.outputs (step
// outputs for later jobs); it never writes either itself. afterRun reports
// fired checks and the write audit trail.

import fs from "node:fs";
import path from "node:path";
import { workDir } from "./config.mjs";
import { setOutput, summary } from "./github.mjs";

export function auditTable(entries) {
  if (!entries.length) return "";
  const rows = entries.map((e) => `| ${e.stage} | ${e.kind} | ${e.target ?? ""} | ${e.outcome}${e.error ? `: ${e.error.replace(/\|/g, "/").split("\n")[0]}` : ""} |`);
  return ["#### Writes", "", "| stage | kind | target | outcome |", "|---|---|---|---|", ...rows].join("\n");
}

export function createHooks({ writer = null, outdir = "", out = { summary, setOutput } } = {}) {
  return {
    async afterStep(step, res) {
      const r = res.result;
      if (!r) return;
      if (r.data?.summary) out.summary(r.data.summary);
      for (const [k, v] of Object.entries(r.data?.outputs ?? {})) out.setOutput(k, v);
      if (r.success === false) out.summary(`**${step.name}** failed${res.ignoredFailure ? " (ignored)" : ""}: ${r.error?.message ?? "no reason given"}`);
    },
    async afterRun(result) {
      for (const c of (result.checks ?? []).filter((x) => x.triggered && x.message)) out.summary(`> ${c.flowName}: ${c.message}`);
      if (!writer?.audit.length) return;
      out.summary(auditTable(writer.audit));
      const dir = workDir(outdir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "audit.json"), JSON.stringify(writer.audit, null, 2));
    },
  };
}
