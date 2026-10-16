// Runs one Claude Code agent headless and returns its structured decision.
//
// The project's own .claude settings are never loaded (--setting-sources ""),
// so a permissive local config cannot widen what a CI agent may execute. The
// tool list and Bash allow list passed here are the agent's whole reach.

import { spawnSync } from "node:child_process";
import fs from "node:fs";

export const READ_TOOLS = ["Read", "Grep", "Glob"];
export const WRITE_TOOLS = ["Edit", "Write"];

// Read-only commands every agent may use to look around.
export const READ_COMMANDS = [
  "gh issue view:*", "gh issue list:*", "gh search issues:*", "gh pr view:*", "gh pr list:*",
  "gh pr diff:*", "gh pr checks:*", "gh release list:*", "gh release view:*",
  "git log:*", "git show:*", "git tag:*", "git merge-base:*", "git grep:*", "git diff:*",
  "git status:*", "git blame:*", "git branch:*", "git rev-parse:*", "git ls-files:*", "git cat-file:*",
  "ls:*", "grep:*", "head:*", "tail:*", "wc:*", "cat:*", "find:*", "sort:*", "uniq:*",
];

// Appended to every prompt. Compound commands are denied as a whole, so an
// agent that chains them loses the call instead of getting a partial answer.
export const TOOL_RULES = `

## Tool rules

Run one simple command per Bash call. No pipes, no ;, &&, ||, no $( ) or backticks, no redirection. If a call is denied, run its parts as separate calls. Prefer the Grep, Glob and Read tools for searching and reading files.`;

export function buildArgs({ prompt, model, schema, tools, commands, maxTurns, maxBudgetUsd }) {
  const allowed = [...commands.map((c) => `Bash(${c})`), ...tools.filter((t) => t !== "Bash")];
  return [
    "-p", prompt + TOOL_RULES,
    "--model", model,
    "--setting-sources", "",
    "--strict-mcp-config",
    "--permission-mode", "dontAsk",
    "--tools", ["Bash", ...tools.filter((t) => t !== "Bash")].join(","),
    "--allowedTools", allowed.join(","),
    "--json-schema", JSON.stringify(schema),
    "--max-turns", String(maxTurns),
    "--max-budget-usd", String(maxBudgetUsd),
    "--output-format", "json",
  ];
}

/** Last element of the CLI's JSON output: the result with structured_output and cost. */
export function parseResult(text) {
  try {
    const raw = JSON.parse(text);
    const r = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    return {
      output: r?.structured_output ?? null,
      cost: r?.total_cost_usd ?? null,
      turns: r?.num_turns ?? null,
      error: r?.is_error ? (r.result ?? r.subtype ?? "error") : null,
      denials: r?.permission_denials?.length ?? 0,
    };
  } catch (e) {
    return { output: null, cost: null, turns: null, error: `unparseable agent output: ${e.message}`, denials: 0 };
  }
}

/**
 * Run an agent. REPO_AGENTS_FIXTURE replaces the model with a JSON file, so
 * the workflow wiring can be tested end to end without an API key.
 */
export function runAgent(opts) {
  if (process.env.REPO_AGENTS_FIXTURE) {
    const output = JSON.parse(fs.readFileSync(process.env.REPO_AGENTS_FIXTURE, "utf8"));
    return { output, cost: 0, turns: 0, error: null, denials: 0, fixture: true };
  }
  const bin = process.env.CLAUDE_BIN || "claude";
  const res = spawnSync(bin, buildArgs(opts), {
    cwd: opts.cwd ?? process.cwd(),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: process.env,
    shell: false,
  });
  if (opts.transcript) fs.writeFileSync(opts.transcript, res.stdout ?? "");
  const parsed = parseResult(res.stdout ?? "");
  if (!parsed.output && !parsed.error) parsed.error = (res.stderr || `exit ${res.status}`).slice(0, 2000);
  return parsed;
}
