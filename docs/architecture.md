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

## Engine: flowkit

Every job runs one flowkit flow: `node toolkit/bin/repo-agents.mjs run <stage>.<half> --param number=N --param outdir=$RUNNER_TEMP/work`, working directory `project/`. `repo-agents preflight <flow>` evaluates a flow's checks without running anything; `run <flow> --plan` lists its steps.

- **Config.** `flows/*.yml` are the base layer, including `flows/settings.yml`, which holds every settings default. The project's `.github/repo-agents.yml` overlays it, then `.github/repo-agents.<REPO_AGENTS_ENV>.yml` and `.github/repo-agents.local.yml`. Loading is strict: an unknown key anywhere, settings included, fails with a did-you-mean. `lib/config.mjs` `validate` checks the values.
- **Flows.** Each stage half is a flow. Steps are numbered with gaps (10, 20, 30), so an overlay can insert a step (15) or switch one off (`task: None`). Steps hand data on through `${steps.N.key}`; `strictStepReferences` rejects a reference to an unknown or later step.
- **Tasks.** Fact gathering, planning and writing are separate steps: `<stage>.facts` (or `resolve.check`) reads the decision and the live state, `<stage>.plan` is pure apart from the summary, and the write steps perform the writes. A project can replace or wrap any one of them. Pure rules stay in `stages/<stage>/*.mjs` under unit test.
- **Checks.** A disabled stage (`settings.<stage>.enabled: false`) is a flow-level `skip` check, so both halves skip with the reason in the summary. `!` or `not` negates a `when:` or check reference.
- **Agent failure.** `claude_code` fails when the agent returns no decision. Decide flows mark it `ignore_failure: true`, so the decision file still records the error and the apply job turns it into a needs-human outcome. `release.notes` does not, so a release without notes stops.
- **Rollback.** `resolve.apply` and `release.publish` set `rollback_on_failure`. A branch `resolve.push` created is deleted again when a later step fails, unless a PR is open on it. A draft from `release.draft` is deleted again when the push after it fails.
- **Hooks.** Tasks return `data.summary` (job summary markdown) and `data.outputs` (step outputs); `lib/hooks.mjs` writes both, reports failed steps and fired checks, and writes the audit trail. No task writes the summary or outputs itself.

## The write seam

Every GitHub write goes through `ctx.writer.write(op, invoke)` (`lib/write.mjs`), which runs flowkit's guard pipeline around `invoke`. The op describes the write: `{ stage, kind, target, text, branch, files, reason, event, confidence, releasedIn, pr, mode }`. The planners decide what to do; the guards decide whether it may be done, so a planner bug cannot become an unsafe write. A denied write throws `WriteDenied` and never runs.

| Guard | Denies |
|---|---|
| `mode` | everything in `dry-run`; close, transfer and merge in `propose` |
| `rate` | more than `limits.writes_per_run` writes in one run |
| `confidence` | a triage or review close, transfer, merge or approval below high confidence |
| `close_policy` | a close that is not a duplicate or not-planned, unless it cites a fix in a published stable release |
| `push_targets` | a push to the default branch from any stage but release; a resolve push or branch delete outside `resolve.branch_prefix` |
| `paths` | a resolve push touching `resolve.protected_paths` |
| `merge_policy` | a merge of a draft, of a PR outside `review.auto_merge`, or of one touching `review.human_paths` or unverifiable paths |
| `prose` | public text with a banned character or `project.banned_phrases`, and closing keywords (`Fixes #N`) in commits and PRs when `closeout.close_on` is `release`. Fenced code is not checked. |

A project adds a guard as a task named `guard.<name>.<phase>` in its config, `phase` being `before` or `after`, optionally scoped: `beforeClose`, `beforePush`, `beforeMerge`, `beforeRelease`, `beforePublicText`. The task receives `{ op }`; returning `success: false` or throwing denies the write.

```yaml
tasks:
  guard.native_proof.beforeMerge: { class_path: ./scripts/native-proof-guard.mjs }
```

Every write, allowed, denied or failed, is recorded. The apply job writes the record to the job summary and uploads `audit.json` as `<stage>-<n>-audit`.

## Code conventions

- ESM `.mjs`. Repo: `repoSlug()` from `lib/github.mjs` (`GITHUB_REPOSITORY`). `lib/github.mjs` holds raw `gh` and `git` calls; a write function from it is called only inside `writer.write`.
- Agent: `runAgent({ prompt, model, schema, tools, commands, maxTurns, maxBudgetUsd, cwd, transcript })`. `REPO_AGENTS_FIXTURE` swaps the model for a JSON file, which is how wiring tests run without an API key.
- Every pure decision (validation, planning, version math, text) is an exported function with a vitest test in `tests/`. `tests/flows.test.mjs` runs the real flows with fact tasks stubbed and `createRunner({ perform })` recording writes, guards included.
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
