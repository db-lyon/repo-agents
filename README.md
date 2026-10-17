# repo-agents core

The engine of the repo-agents action suite. It runs Claude agents at fixed points in an issue's life (triage, resolve, review, release notes) and the model-free closeout, as [flowkit](https://www.npmjs.com/package/@db-lyon/flowkit) flows configured per repository. The GitHub Actions in the suite install this package and call its CLI; a project never calls it directly unless it writes its own workflows.

It knows nothing about any language or stack. A project describes itself, its commands and its rules in `.github/repo-agents.yml`.

## Install

```bash
npm install --prefix "$RUNNER_TEMP/repo-agents" github:repo-agents/core#v1
echo "$RUNNER_TEMP/repo-agents/node_modules/.bin" >> "$GITHUB_PATH"
```

`setup-repo-agents` does this for you. npm 12 refuses git dependencies unless `--allow-git=all` is passed; the npm that ships with Node 22 does not need it. The package is `@db-lyon/repo-agents` and will install from the npm registry once published.

`bin/repo-agents.mjs` is deprecated. It is kept for checkouts that still call it by path and is not shipped in the package. Use the `repo-agents` bin.

## Set up a repository

```bash
npx github:repo-agents/core install --repo owner/name --dry-run   # see what it would do
npx github:repo-agents/core install --repo owner/name
```

It creates the labels the stages use, lets GitHub Actions approve pull requests, turns on auto-merge where the plan allows it, and opens a pull request adding `.github/workflows/repo-agents.yml` (the caller) and `.github/repo-agents.yml` (a starter config). It lists the secrets still missing: `ANTHROPIC_API_KEY`, and optionally `REPO_AGENTS_TOKEN`. Running it again changes only what is still missing.

## CLI

Run from the project root.

```
repo-agents run <flow> [--param key=value]* [--plan]
repo-agents preflight <flow> [--param key=value]*
repo-agents flows
repo-agents settings
repo-agents install --repo owner/name [--dry-run]
repo-agents help
```

- `run` runs a flow. `--param` repeats, one per parameter. `--plan` lists the steps the merged config would run, without running them.
- `preflight` evaluates a flow's checks (a disabled stage, for one) without running anything. Exit 0 when the flow would run or skip cleanly.
- `flows` lists every flow with its description.
- `settings` prints the merged settings as JSON.

Exit codes: 0 success, 1 a flow or the config failed, 2 a usage error (unknown command or flow).

| Flow | Params | Job |
|---|---|---|
| `triage.decide`, `triage.apply` | `number`, `outdir`, `mode` (apply, optional) | read-only, then write |
| `resolve.decide`, `resolve.apply` | `number`, `outdir` | read-only, then write |
| `review.decide`, `review.apply` | `number`, `outdir`, `pr_dir` (decide, default `../pr`) | read-only, then write |
| `closeout.merged` | `number` (the merged PR) | write, no model |
| `closeout.released` | `tag` | write, no model |
| `release.plan`, `release.gate`, `release.notes`, `release.publish` | `outdir`, `force`, `version`, `prev_tag`, `default_branch` | plan and notes read-only, publish writes |

Environment:

| Variable | Meaning |
|---|---|
| `REPO_AGENTS_CONFIG` | the project config, default `.github/repo-agents.yml` |
| `REPO_AGENTS_ENV` | also load `.github/repo-agents.<env>.yml` |
| `REPO_AGENTS_WORK` | where work files go between jobs, default `$RUNNER_TEMP/repo-agents-work` (an `outdir` param wins) |
| `REPO_AGENTS_FIXTURE` | a JSON decision file that replaces the model, for tests |
| `REPO_AGENTS_REPOSITORY` | `owner/name` to act on. Wins over `GITHUB_REPOSITORY`, which a workflow cannot reassign |
| `GH_TOKEN` | GitHub token: read-only in decide jobs, write in apply jobs when `AGENTS_TOKEN` is unset |
| `AGENTS_TOKEN` | optional write token (a PAT or app token): transfers, and pushes and merges that must start other workflows |
| `ANTHROPIC_API_KEY` | the model key, decide flows only |
| `GITHUB_EVENT_NAME` | `workflow_dispatch` makes triage and review consider items they would otherwise skip |

The review action checks the PR head out at `pr/` inside the project root and passes `pr_dir=pr`. A relative `pr_dir` resolves against the project root. That directory is added to the root's `.git/info/exclude`, never staged, and never read for house rules.

## Configuration

Layers, lowest first:

1. this package's `flows/*.yml`, including `flows/settings.yml`, which holds every setting's default
2. the project's `.github/repo-agents.yml` (or `REPO_AGENTS_CONFIG`)
3. `.github/repo-agents.<REPO_AGENTS_ENV>.yml`
4. `.github/repo-agents.local.yml`

Loading is strict: an unknown key anywhere, settings included, fails with a did-you-mean. A project writes only what differs from the defaults. [`examples/minimal.yml`](examples/minimal.yml) is a generic project; [`examples/ue-mcp.yml`](examples/ue-mcp.yml) is a project with release-gated closing, beta prereleases and draft releases.

The defaults are neutral: issues close when the fixing PR merges (`closeout.close_on: merge`), release is off (`release.enabled: false`), and releases bump the patch version. A project that wants issues to stay open until a release ships the fix sets `closeout.close_on: release`; merged fixes then get `labels.fixed_pending`, and `closeout.released` closes them when a stable release contains every fix commit.

### Overlays

Flow steps are numbered with gaps, so an overlay can insert a step or switch one off.

Insert step 15 into `triage.apply`:

```yaml
tasks:
  notify:
    class_path: shell
    options: { command: "node scripts/notify.mjs" }
flows:
  triage.apply:
    steps:
      15: { task: notify }
```

Switch a step off (here, triage plans but never writes):

```yaml
flows:
  triage.apply:
    steps:
      30: { task: None }
```

### Project guards

Every GitHub write passes one guarded seam. A project adds a guard as a task named `guard.<name>.<phase>`, `phase` being `before` or `after`, optionally scoped: `beforeClose`, `beforePush`, `beforeMerge`, `beforeRelease`, `beforePublicText`. Since core is installed outside the project, a guard file is a plain function with no imports: it gets the write and returns a reason to deny it, or nothing.

```yaml
tasks:
  guard.native_proof.beforeMerge: { class_path: ./scripts/native-proof-guard.mjs }
```

```js
// scripts/native-proof-guard.mjs
export default function (op, { settings, root }) {
  const native = (op.pr?.files ?? []).some((f) => f.startsWith("plugin/"));
  return native ? "native changes need a live editor run before merge" : null;
}
```

A class extending flowkit's `BaseTask` works too, where the project can resolve `@db-lyon/flowkit` itself.

## Guards

| Guard | Denies |
|---|---|
| `mode` | everything in `dry-run`; close, transfer and merge in `propose` |
| `rate` | more than `limits.writes_per_run` writes in one run (`limits.closeout_writes_per_run` for closeout) |
| `confidence` | a triage or review close, transfer, merge or approval below high confidence |
| `close_policy` | a close as completed without evidence: a merged fix when `close_on` is `merge`, a fix in a published stable release when it is `release`. Duplicates and not-planned are allowed |
| `push_targets` | a push to the default branch from any stage but release; a resolve push or branch delete outside `resolve.branch_prefix` |
| `paths` | a resolve push touching `resolve.protected_paths` |
| `merge_policy` | a merge of a draft, of a PR outside `review.auto_merge`, or of one touching `review.human_paths` or `resolve.unverifiable_paths` |
| `prose` | public text with an em dash, an ellipsis or a `project.banned_phrases` entry, and closing keywords in commits and PRs when `close_on` is `release`. Fenced code is not checked |

Every write, allowed, denied or failed, goes to the job summary and to `audit.json` in the work directory.

## Trust model

- An agent never holds a token that can write. Each stage has a decide flow, run with a read-only token, and an apply flow that runs no model, verifies every claim the decision makes against GitHub and git, and only then writes.
- Agents run Claude Code with the project's own Claude settings ignored, a fixed tool list and a read-only command list. Review never executes PR code, and agent instruction files in the PR checkout are removed before the agent runs.
- Resolve runs the project's commands only in a throwaway checkout with tokens scrubbed from the environment; the apply job runs verification again itself.
- Text from issues and PRs is treated as hostile. Text an agent writes is sanitized before it is posted.

[docs/architecture.md](docs/architecture.md) has the detail.

## The action suite

| Action | Purpose |
|---|---|
| [default-versions](https://github.com/repo-agents/default-versions) | pinned versions of core, Claude Code and Node |
| [setup-repo-agents](https://github.com/repo-agents/setup-repo-agents) | install Node, Claude Code and core |
| [run-flow](https://github.com/repo-agents/run-flow) | run any flow |
| [triage](https://github.com/repo-agents/triage) | triage an issue |
| [resolve](https://github.com/repo-agents/resolve) | implement a fix and open a PR |
| [review](https://github.com/repo-agents/review) | review a PR, merge when policy allows |
| [release-notes](https://github.com/repo-agents/release-notes) | plan, write and publish a release |
| [closeout](https://github.com/repo-agents/closeout) | close or label issues on merge and on release |
| [standard-workflows](https://github.com/repo-agents/standard-workflows) | reusable workflows wiring the actions |

## Development

```bash
npm ci
npx vitest run
REPO_AGENTS_CONFIG=examples/ue-mcp.yml node cli.mjs run release.publish --plan
```

CI runs the tests, plans every flow under every config in `examples/`, and runs actionlint.

## License

MIT
