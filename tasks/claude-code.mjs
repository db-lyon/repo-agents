// claude_code: run one headless Claude Code agent and save its decision.

import fs from "node:fs";
import path from "node:path";
import { BaseTask } from "@db-lyon/flowkit";
import { READ_COMMANDS, runAgent } from "../lib/agent.mjs";
import { contextText, workDir } from "../lib/config.mjs";
import { fill } from "../lib/text.mjs";

export default class ClaudeCodeTask extends BaseTask {
  static description = "Run a headless Claude Code agent with a fixed tool list and a JSON schema";
  static optionsSchema = {
    prompt_file: { type: "string", required: true, description: "Prompt template, relative to the toolkit root" },
    vars: { type: "object", default: {} },
    schema: { type: "object", required: true },
    tools: { type: "array", default: ["Read", "Grep", "Glob"] },
    commands: { type: "array", default: [], description: "Extra Bash permission patterns beyond the read set" },
    model: { type: "string", required: true },
    max_turns: { type: "integer", default: 40 },
    max_budget_usd: { type: "number", default: 2 },
    cwd: { type: "string", default: "", description: "Agent working directory, relative to the project root; default the root" },
    outdir: { type: "string", default: "" },
    out: { type: "string", default: "decision.json" },
  };

  get taskName() {
    return "claude_code";
  }

  async execute() {
    const o = this.options;
    const { settings, root, toolkitRoot } = this.ctx;
    const template = fs.readFileSync(path.join(toolkitRoot, o.prompt_file), "utf8");
    const prompt = fill(template, {
      REPO: process.env.GITHUB_REPOSITORY ?? "",
      PROJECT: settings.project.name,
      PROJECT_DESCRIPTION: settings.project.description,
      VOICE: settings.project.voice,
      CONTEXT: contextText(settings, root),
      ...o.vars,
    });
    const cwd = o.cwd ? path.resolve(root, o.cwd) : root;
    if (!fs.existsSync(cwd)) throw new Error(`agent working directory ${cwd} does not exist`);
    const dir = workDir(o.outdir);
    fs.mkdirSync(dir, { recursive: true });
    const outFile = path.join(dir, o.out);
    const result = runAgent({
      prompt,
      model: o.model,
      schema: o.schema,
      tools: o.tools,
      commands: [...READ_COMMANDS, ...o.commands],
      maxTurns: o.max_turns,
      maxBudgetUsd: o.max_budget_usd,
      cwd,
      transcript: path.join(dir, `${path.parse(o.out).name}.transcript.json`),
    });
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
    this.logger.info(`agent ${result.output ? "returned a decision" : `failed: ${result.error}`}; cost ${result.cost ?? "n/a"}, ${result.turns ?? "?"} turns`);
    // A missing decision is not a flow failure: the apply job turns it into a
    // needs-human outcome, which is the right public result.
    return { success: true, data: { ...result, file: outFile } };
  }
}

export const TASKS = { claude_code: ClaudeCodeTask };
