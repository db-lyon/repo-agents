# Architecture

repo-agents is a set of reusable GitHub workflows (`.github/workflows/*.yml`, `on: workflow_call`) and the Node scripts they run (`stages/<stage>/*.mjs`, shared code in `lib/`). A project opts in with two files:

- `.github/repo-agents.yml`: its configuration, merged over `lib/config.mjs` `DEFAULTS`.
- `.github/workflows/repo-agents.yml`: a caller that routes GitHub events to the reusable workflows (`templates/caller.yml`).

## The lifecycle

| Stage | Trigger | Agent | Result |
|---|---|---|---|
| triage | issue opened, dispatch | read-only | labels, comment, close duplicate/fixed/invalid, transfer, optional resolve label |
| resolve | resolve label added, dispatch | edits a checkout, runs verify commands | branch, commit, PR with `Refs #N`, issue labeled in-progress |
| review | PR opened/updated (pull_request_target), dispatch | read-only | PR review (approve / request changes / comment) with inline comments; auto-merge when allowed |
| closeout | PR merged, CI completed on default branch, dispatch | none | merge: label fixed_pending or close; release: close issues whose fix is in a stable release |
| release | schedule, dispatch | read-only, writes notes | version bump, draft or published GitHub release with notes |

## The rule every stage follows

An agent never holds a token that can write. Each stage has two jobs:

1. **decide**: checks out the project into `project/` and the toolkit into `toolkit/`, runs the agent with `cwd: project`, a read-only `GH_TOKEN`, and a fixed tool list (`lib/agent.mjs`). The agent returns one JSON object matching the stage's schema. The decide job uploads it, plus for resolve the diff (`git diff --binary`), as an artifact.
2. **apply**: no model. Downloads the artifact, verifies every claim the agent made against GitHub and git, re-runs any verification itself, and only then writes (labels, comments, pushes, PRs, merges, releases).

Text an agent wrote is passed through `lib/text.mjs` `sanitize` before it is posted.

## Script conventions

- Scripts are ESM `.mjs`, run as `node toolkit/stages/<stage>/<script>.mjs <subcommand> [args]` with the working directory set to `project/`.
- Config: `loadConfig()` from `lib/config.mjs` (reads `REPO_AGENTS_CONFIG` or `.github/repo-agents.yml` in cwd).
- Repo: `repoSlug()` from `lib/github.mjs` (`GITHUB_REPOSITORY`).
- Agent: `runAgent({ prompt, model, schema, tools, commands, maxTurns, maxBudgetUsd, cwd, transcript })`. `REPO_AGENTS_FIXTURE` swaps the model for a JSON file, which is how wiring tests run without an API key.
- Every pure decision (validation, planning, version math, text) is an exported function with a vitest test in `tests/`. The `main()` at the bottom only gathers facts and performs writes. Guard it with `if (import.meta.url === pathToFileURL(process.argv[1]).href) main()`.
- Outputs: `setOutput`, and a human summary through `summary()` (the job summary).
- Prompts live in `stages/<stage>/prompt.md` with `{{placeholders}}` filled by `fill()`. Schemas in `stages/<stage>/schema.json` (or built in code when they depend on config).

## Reusable workflow conventions

Inputs on every reusable workflow:

```yaml
inputs:
  config: { type: string, default: .github/repo-agents.yml }
  toolkit_ref: { type: string, default: v1 }
  number: { type: string, default: "" }   # issue or PR number, when the stage takes one
secrets:
  anthropic_api_key: { required: false }
  agents_token: { required: false }        # PAT or app token; see Tokens
```

Toolkit checkout step (identical in every job):

```yaml
- uses: actions/checkout@v4
  with: { repository: db-lyon/repo-agents, ref: "${{ inputs.toolkit_ref }}", path: toolkit }
- run: npm ci --omit=dev --prefix toolkit
```

Agent install: `npm install -g @anthropic-ai/claude-code@2.1.301`. Node 22.

## Tokens

- The decide job uses `github.token` with read permissions only.
- The apply job uses `agents_token` when it is set, else `github.token`. Events caused by `github.token` do not start other workflows, so when `agents_token` is absent a stage that pushes (resolve, release) dispatches the project's CI itself with `lib/github.mjs` `dispatch()`; `workflow_dispatch` is the one event `github.token` can start. The config names that workflow in `ci.workflow`.
- `agents_token` is required for transfers to another repository.
