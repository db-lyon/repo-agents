// repo-agents CLI.
//
//   repo-agents run <flow> [--param key=value]* [--plan]
//   repo-agents preflight <flow> [--param key=value]*
//   repo-agents flows
//   repo-agents settings
//   repo-agents install --repo owner/name [--dry-run]
//   repo-agents help
//
// Run it from the project's root, through the package bin (cli.mjs at the
// package root): `repo-agents run triage.decide --param number=12`.

import { pathToFileURL } from "node:url";
import { createRunner } from "./engine.mjs";
import { DEFAULTS, validate } from "./config.mjs";
import { install } from "./install.mjs";

export function parseArgs(argv) {
  const out = { command: argv[0], flow: undefined, params: {}, plan: false, repo: undefined, dryRun: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plan") out.plan = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--repo") out.repo = argv[++i];
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

const USAGE = "usage: repo-agents run <flow> [--param key=value]* [--plan] | preflight <flow> [--param key=value]* | flows | settings | install --repo owner/name [--dry-run]";
const ENV_HELP = [
  "Run from the project root. Environment:",
  "  REPO_AGENTS_CONFIG   project config (default .github/repo-agents.yml)",
  "  REPO_AGENTS_ENV      also load .github/repo-agents.<env>.yml",
  "  REPO_AGENTS_WORK     work files between jobs (default $RUNNER_TEMP/repo-agents-work)",
  "  REPO_AGENTS_FIXTURE  a JSON decision that replaces the model (tests)",
  "  REPO_AGENTS_REPOSITORY  owner/name to act on; wins over GITHUB_REPOSITORY",
  "  GH_TOKEN             GitHub token for reads, and writes when AGENTS_TOKEN is unset",
  "  AGENTS_TOKEN         optional write token (transfers, pushes that start CI)",
  "  ANTHROPIC_API_KEY    the model key, decide flows only",
].join("\n");

/** One line per step: path, name, state, then any error and fired checks. */
export function stepLines(steps) {
  const lines = [];
  for (const s of steps ?? []) {
    const state = s.status
      ?? (s.skipped ? `skipped${s.skipReason ? ` (${s.skipReason})` : ""}` : !s.result ? "planned" : s.result.success === false ? "failed" : "ok");
    lines.push(`${String(s.path ?? s.stepNumber).padEnd(6)} ${String(s.name).padEnd(28)} ${state}`);
    if (s.result?.error) lines.push(`       ${s.result.error.message}`);
    for (const c of (s.checks ?? []).filter((x) => x.triggered || x.error)) lines.push(`       ${c.action}: ${c.message ?? c.when}${c.error ? ` (${c.error})` : ""}`);
  }
  return lines;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (["help", "--help", "-h"].includes(args.command)) {
    console.log(`${USAGE}\n\n${ENV_HELP}`);
    return 0;
  }
  if (args.command === "install") {
    if (!args.repo || !/^[\w.-]+\/[\w.-]+$/.test(args.repo)) {
      console.error("usage: repo-agents install --repo owner/name [--dry-run]");
      return 2;
    }
    for (const l of install({ repo: args.repo, dryRun: args.dryRun, settings: validate(DEFAULTS) })) console.log(l);
    return 0;
  }
  if (!["run", "preflight", "flows", "settings"].includes(args.command)) {
    console.error(USAGE);
    return 2;
  }
  const { runner, config, settings } = createRunner({ outdir: args.params.outdir ?? "" });

  if (args.command === "flows") {
    for (const [name, f] of Object.entries(config.flows)) console.log(`${name.padEnd(24)} ${f.description}`);
    return 0;
  }
  if (args.command === "settings") {
    console.log(JSON.stringify(settings, null, 2));
    return 0;
  }
  if (!args.flow) {
    console.error(USAGE);
    return 2;
  }
  if (!config.flows[args.flow]) {
    console.error(`unknown flow ${args.flow}; \`repo-agents flows\` lists them`);
    return 2;
  }

  if (args.command === "preflight") {
    const pf = await runner.preflight(args.flow, args.params);
    for (const c of (pf.checks ?? []).filter((x) => x.triggered || x.error)) console.log(`flow   ${c.action}: ${c.message ?? c.when}`);
    for (const l of stepLines(pf.steps)) console.log(l);
    return pf.ok ? 0 : 1;
  }

  const result = await runner.run({ flowName: args.flow, params: args.params, plan: args.plan, expandNestedFlows: args.plan });
  for (const l of stepLines(result.steps)) console.log(l);
  for (const e of result.rollback?.errors ?? []) console.error(`rollback failed: ${e.error?.message ?? e.message ?? JSON.stringify(e)}`);
  if (!result.success) {
    console.error(`flow ${args.flow} failed: ${result.error?.message ?? "a step failed"}`);
    return 1;
  }
  return 0;
}

export function cli() {
  main().then((code) => process.exit(code), (e) => {
    console.error(e?.stack ?? String(e));
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli();
