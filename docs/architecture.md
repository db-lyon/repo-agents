# Architecture

repo-agents is an action suite in the shape of nimba-actions, over one engine. This repository is the engine, `core`: the npm package `@db-lyon/repo-agents`, a flowkit host with the stages' flows, tasks, guards, prompts and schemas, and the `repo-agents` CLI. The design is in [proposal-toolkit.md](proposal-toolkit.md).

| Layer | Where | Role |
|---|---|---|
| Engine | this repository | flows, tasks, guards, the CLI. Per-project control is the project's `.github/repo-agents.yml` |
| Primitives | `repo-agents/default-versions`, `setup-repo-agents`, `run-flow` | one composite action per repository: pinned versions, install, run a flow |
| Composites | `repo-agents/triage`, `resolve`, `review`, `release-notes`, `closeout` | `setup-repo-agents` plus `run-flow` for one stage, with a `phase` input |
| Workflows | `repo-agents/standard-workflows` | reusable workflows wiring the composites to GitHub events |

A project either calls a standard workflow or composes the actions in its own jobs, beside its own setup steps.

## The lifecycle

| Stage | Trigger (in the standard workflows) | Agent | Result |
|---|---|---|---|
| triage | issue opened, dispatch | read-only | labels, comment, close duplicate, fixed or invalid, transfer, optional resolve label |
| resolve | resolve label added, dispatch | edits a checkout, runs verify commands | branch, commit, PR with `Refs #N`, issue labeled in-progress |
| review | PR opened or updated, dispatch | read-only | PR review with inline comments; merge when allowed |
| closeout | PR merged, release published, dispatch | none | `close_on: merge` closes the PR's issues; `close_on: release` labels them, then closes them when a stable release contains the fix |
| release | schedule, dispatch | read-only, writes notes | version bump, draft or published GitHub release with notes |

## Decide and apply

An agent never holds a token that can write. Each agent stage is two flows, which the composites run as `phase: decide` and `phase: apply` and the caller puts in separate jobs:

1. **decide** (`<stage>.decide`): runs the agent with a read-only `GH_TOKEN` and a fixed tool list (`lib/agent.mjs`). The agent returns one JSON object matching the stage's schema, written to the work directory (`REPO_AGENTS_WORK`), with the diff (`fix.patch`) for resolve. The composite uploads the work directory as the artifact `repo-agents-<stage>-<n>`.
2. **apply** (`<stage>.apply`): no model. The composite downloads the artifact into the work directory. The flow verifies every claim against GitHub and git, re-runs any verification itself, and only then writes.

Closeout has no model and one write job. Release splits into `release.plan`, `release.gate` (on the project's gate runner), `release.notes` and `release.publish`.

Text an agent wrote passes through `lib/text.mjs` `sanitize` before it is posted.

### Review's PR checkout

The review action checks the PR head out at `pr/` inside the project root and passes `pr_dir=pr`. `review.prepare` resolves `pr_dir` against the root, refuses the root itself or a parent of it, removes agent instruction files from the checkout, adds it to the root's `.git/info/exclude`, and hands its path to the agent step as the working directory. House rules (`project.context_files`) are read from the root and never from inside the agent's working directory. Untracked-file listing skips nested repositories, so no `git add` in the root stages the PR.

## Engine: flowkit

Every job step runs one flow: `repo-agents run <flow> --param number=N`, from the project root. `repo-agents preflight <flow>` evaluates a flow's checks without running anything; `run <flow> --plan` lists its steps.

- **Config.** `flows/*.yml` are the base layer, including `flows/settings.yml`, which holds every settings default. The project's `.github/repo-agents.yml` (or `REPO_AGENTS_CONFIG`) overlays it, then `.github/repo-agents.<REPO_AGENTS_ENV>.yml` and `.github/repo-agents.local.yml`. Loading is strict: an unknown key anywhere fails with a did-you-mean. `lib/config.mjs` `validate` checks the values.
- **Defaults are neutral.** Issues close on merge, release is off, bumps are patch. Project rules (release-gated closing, prerelease ids, headline frontmatter) live in the project's config; `examples/` shows two.
- **Flows.** Steps are numbered with gaps (10, 20, 30), so an overlay can insert a step (15) or switch one off (`task: None`). Steps hand data on through `${steps.N.key}`; `strictStepReferences` rejects a reference to an unknown or later step.
- **Tasks.** Fact gathering, planning and writing are separate steps: `<stage>.facts` (or `resolve.check`, `closeout.pr_facts`, `closeout.release_facts`) reads the decision and the live state, the plan task is pure apart from the summary, and the write steps perform the writes. Pure rules stay in `stages/<stage>/*.mjs` under unit test.
- **Checks.** A disabled stage (`settings.<stage>.enabled: false`) is a flow-level `skip` check. `!` or `not` negates a `when:` or check reference.
- **Agent failure.** `claude_code` fails when the agent returns no decision. Decide flows mark it `ignore_failure: true`, so the decision file still records the error and the apply flow turns it into a needs-human outcome. `release.notes` does not, so a release without notes stops.
- **Rollback.** `resolve.apply` and `release.publish` set `rollback_on_failure`. A branch `resolve.push` created is deleted again when a later step fails, unless a PR is open on it. A draft from `release.draft` is deleted again when the push after it fails.
- **Hooks.** Tasks return `data.summary` (job summary markdown) and `data.outputs` (step outputs); `lib/hooks.mjs` writes both, reports failed steps and fired checks, and writes the audit trail.

## The write seam

Every GitHub write goes through `ctx.writer.write(op, invoke)` (`lib/write.mjs`), which runs flowkit's guard pipeline around `invoke`. The op describes the write: `{ stage, kind, target, text, branch, files, reason, event, confidence, releasedIn, fixedIn, pr, mode }`. The planners decide what to do; the guards decide whether it may be done, so a planner bug cannot become an unsafe write. A denied write throws `WriteDenied` and never runs.

| Guard | Denies |
|---|---|
| `mode` | everything in `dry-run`; close, transfer and merge in `propose` |
| `rate` | more than `limits.writes_per_run` writes in one run (`limits.closeout_writes_per_run` for closeout) |
| `confidence` | a triage or review close, transfer, merge or approval below high confidence |
| `close_policy` | a close as completed without evidence: `fixedIn` (a merged PR or a commit on the default branch) when `closeout.close_on` is `merge`, `releasedIn` (a published stable release) when it is `release` |
| `push_targets` | a push to the default branch from any stage but release; a resolve push or branch delete outside `resolve.branch_prefix` |
| `paths` | a resolve push touching `resolve.protected_paths` |
| `merge_policy` | a merge of a draft, of a PR outside `review.auto_merge`, or of one touching `review.human_paths` or unverifiable paths |
| `prose` | public text with a banned character or `project.banned_phrases`, and closing keywords (`Fixes #N`) in commits and PRs when `closeout.close_on` is `release`. Fenced code is not checked |

A project adds a guard as a task named `guard.<name>.<phase>` in its config, `phase` being `before` or `after`, optionally scoped: `beforeClose`, `beforePush`, `beforeMerge`, `beforeRelease`, `beforePublicText`. The guard file is a plain function `(op, { settings, root })` returning a reason to deny, or a flowkit `BaseTask` class; core is installed outside the project, so the plain function is the form that needs no imports.

Every write, allowed, denied or failed, is recorded in the job summary and in `audit.json` in the work directory.

## Code conventions

- ESM `.mjs`. Repository: `repoSlug()` from `lib/github.mjs` (`REPO_AGENTS_REPOSITORY`, else `GITHUB_REPOSITORY`). `lib/github.mjs` holds raw `gh` and `git` calls; a write function from it is called only inside `writer.write`.
- Agent: `runAgent({ prompt, model, schema, tools, commands, maxTurns, maxBudgetUsd, cwd, transcript })`. `REPO_AGENTS_FIXTURE` swaps the model for a JSON file, which is how the actions' tests run without an API key.
- Every pure decision (validation, planning, version math, text) is an exported function with a vitest test in `tests/`. `tests/flows.test.mjs` and `tests/closeout.test.mjs` run the real flows with fact tasks stubbed and `createRunner({ perform })` recording writes, guards included. `tests/cli.test.mjs` runs the bin as a process. `tests/examples.test.mjs` plans every flow under every example config.
- Prompts live in `stages/<stage>/prompt.md` with `{{placeholders}}` filled by `fill()`. Schemas in `stages/<stage>/schema.json`, or built in code when they depend on config.

## Tokens

- Decide flows run with a read-only `GH_TOKEN`.
- Apply flows write with `AGENTS_TOKEN` where it matters and `GH_TOKEN` otherwise. Events caused by `github.token` do not start other workflows, so without `AGENTS_TOKEN` a stage that pushes (resolve, release) dispatches the project's CI itself; `workflow_dispatch` is the one event `github.token` can start. The config names that workflow in `ci.workflow`.
- `AGENTS_TOKEN` is required for transfers to another repository.
