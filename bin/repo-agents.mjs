// repo-agents CLI.
//
//   repo-agents run <flow> [--param key=value]... [--plan]
//   repo-agents flows
//   repo-agents settings
//
// Run it from the project's root. Workflows call it as
// `node ../toolkit/bin/repo-agents.mjs run triage.decide --param number=12`.

import { createRunner } from "../lib/engine.mjs";

export function parseArgs(argv) {
  const out = { command: argv[0], flow: undefined, params: {}, plan: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plan") out.plan = true;
    else if (a === "--param" || a === "-p") {
      const [k, ...v] = String(argv[++i] ?? "").split("=");
      out.params[k] = coerce(v.join("="));
    } else if (!out.flow) out.flow = a;
  }
  return out;
}

function coerce(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { runner, config, settings } = createRunner();

  if (args.command === "flows") {
    for (const [name, f] of Object.entries(config.flows)) console.log(`${name.padEnd(24)} ${f.description}`);
    return;
  }
  if (args.command === "settings") {
    console.log(JSON.stringify(settings, null, 2));
    return;
  }
  if (args.command !== "run" || !args.flow) {
    console.error("usage: repo-agents run <flow> [--param key=value]... [--plan] | flows | settings");
    process.exit(2);
  }

  const result = await runner.run({ flowName: args.flow, params: args.params, plan: args.plan });
  for (const s of result.steps ?? []) {
    const state = s.skipped ? `skipped${s.skipReason ? ` (${s.skipReason})` : ""}` : s.result?.success === false ? "failed" : "ok";
    console.log(`${String(s.path ?? s.stepNumber).padEnd(6)} ${String(s.name).padEnd(28)} ${state}`);
    if (s.result?.error) console.log(`       ${s.result.error.message}`);
  }
  if (!result.success) {
    console.error(`flow ${args.flow} failed: ${result.error?.message ?? "a step failed"}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exit(1);
});
