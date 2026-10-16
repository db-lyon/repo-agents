# Proposal: composable CI toolkits for agents and Unreal

Draft, 2026-10-16. Modeled on nimba-actions (the Cumulus suite). Supersedes the reusable-workflow design in `plan.md` where they conflict.

## 1. The model being copied

nimba-actions has three layers over one engine:

| Layer | nimba-actions | Role |
|---|---|---|
| Engine | CumulusCI (`cci`, project `cumulusci.yml`) | tasks and flows live in the project; actions only call them |
| Primitives | `default-package-versions`, `setup-cumulus`, `authorize-org`, `create-scratch-org`, `run-task`, `run-flow` | one repo each, composite `action.yml`, thin |
| Composites | `run-flow-scratch`, `feature-test`, `beta-test`, `release-beta-2gp` | built only from primitives |
| Standard workflows | `standard-workflows` | ready-made workflows wiring the actions; a project uses one or writes its own |

The proposal builds two suites in that shape. flowkit is the engine for both; it was designed after CumulusCI's tasks and flows.

## 2. Two suites, kept apart

**Agent suite: stack-neutral.** Agents at defined points in an issue lifecycle: triage, resolve, review, release notes, close-out. It knows nothing about any language or engine. A Salesforce repo, a Node repo and a UE plugin use it the same way.

**Unreal suite: UE-specific, agent-free.** Set up ue-mcp and an engine, build, test and package plugins and projects, run ue-mcp flows. It knows nothing about agents.

A project's workflow composes them: its own setup steps, Unreal suite steps, then an agent suite step where it wants one.

```yaml
# ue-mcp: .github/workflows/resolve.yml (illustrative)
jobs:
  decide:
    runs-on: [self-hosted, win64, ue-5.8]
    permissions: { contents: read, issues: read }
    steps:
      - uses: actions/checkout@v4
      - uses: ue-mcp-actions/setup-ue-mcp@v1
      - uses: ue-mcp-actions/setup-unreal@v1
        with: { engine-version: "5.8" }
      - uses: repo-agents/resolve@v1
        with: { phase: decide, issue: "${{ inputs.issue }}", anthropic-api-key: "${{ secrets.ANTHROPIC_API_KEY }}" }
  apply:
    needs: decide
    runs-on: [self-hosted, win64, ue-5.8]
    permissions: { contents: write, pull-requests: write, issues: write }
    steps:
      - uses: actions/checkout@v4
      - uses: ue-mcp-actions/setup-ue-mcp@v1
      - uses: ue-mcp-actions/build-plugin@v1
      - uses: repo-agents/resolve@v1
        with: { phase: apply, issue: "${{ inputs.issue }}", token: "${{ secrets.REPO_AGENTS_TOKEN }}" }
```

## 3. Layout

One action per repository, as in nimba-actions. Reasons: clean `uses: org/action@v1`, each action versioned and tagged on its own, and GitHub Marketplace lists only actions whose `action.yml` is at a repository root.

### Agent suite (org: `repo-agents`)

| Repo | Layer | What it does |
|---|---|---|
| `core` | engine | npm package `@db-lyon/repo-agents`: CLI, flowkit host, tasks, guards, prompts, schemas. The equivalent of the `cumulusci` package. Today's `db-lyon/repo-agents` code moves here. |
| `default-versions` | primitive | pinned versions of `core`, Claude Code and Node, overridable per input |
| `setup-repo-agents` | primitive | installs Node, Claude Code and `core` at the default versions |
| `run-flow` | primitive | runs any `repo-agents` flow with options, the way nimba's `run-flow` runs `cci flow run` |
| `triage`, `resolve`, `review`, `release-notes`, `closeout` | composite | `setup-repo-agents` + `run-flow` for that stage. Input `phase: decide | apply` keeps the read-only and write halves as separate steps the caller puts in separate jobs |
| `standard-workflows` | workflows | reusable workflows: issue triage, issue resolve, PR review, close-out on merge and release |

Per-project control stays in the project: `.github/repo-agents.yml` is a flowkit overlay (settings, guards, inserted or skipped steps), exactly as `cumulusci.yml` is for CumulusCI.

### Unreal suite (org: `ue-mcp-actions`)

| Repo | Layer | What it does |
|---|---|---|
| engine | engine | ue-mcp itself (CLI plus its flowkit flows). Nothing new. |
| `default-versions` | primitive | supported engine versions (5.4 to 5.8) and the ue-mcp version |
| `setup-ue-mcp` | primitive | installs Node and the ue-mcp CLI |
| `setup-unreal` | primitive | finds and validates an installed engine on the runner and exports its path. It does not install Unreal; runners provide it. |
| `run-flow`, `run-task` | primitive | run a ue-mcp flow or one action |
| `build-plugin`, `build-project` | primitive | RunUAT BuildPlugin / UBT for a target platform |
| `smoke-test`, `live-test`, `package-plugin`, `release-beta`, `release-production` | composite | built from the primitives |
| `standard-workflows` | workflows | plugin CI, plugin release |

Runners: self-hosted Windows and Linux machines with engines installed, labelled by OS and engine version (`win64`, `linux`, `ue-5.8`). Out of scope until the suite exists; `setup-unreal` is written against that contract.

## 4. Conventions, both suites

- Composite actions, kebab-case inputs and outputs, a README per action with every input listed.
- Versions resolved by `default-versions`, never hard-coded in a composite.
- Tags `v1`, `v1.x.y`; `v1` moves. Composites call primitives at `@v1`.
- Tokens are inputs, never read from ambient secrets. Read-only steps take no write token.
- Each action repo has CI that runs it against a fixture repository.

## 5. What changes from the current work

- `db-lyon/repo-agents` becomes `repo-agents/core` (repo transfer keeps history and redirects). Its reusable workflows move to `repo-agents/standard-workflows` as examples. Stages stay flowkit flows; guards, checks and rollback stay as written.
- ue-mcp's in-repo `issue-triage.yml` and `release-closeout.yml` are replaced by `repo-agents/triage` and `repo-agents/closeout` once those ship.
- ue-mcp-specific rules (Refs not Closes, close on release, beta prereleases) move out of toolkit defaults into ue-mcp's `.github/repo-agents.yml`.

## 6. Phases

1. Agent suite foundation: `core` published to npm, `default-versions`, `setup-repo-agents`, `run-flow`, `triage`, `closeout`, `standard-workflows/issue-triage`. ue-mcp switches its triage and close-out to them.
2. `resolve` and `review`.
3. Unreal suite foundation: `default-versions`, `setup-ue-mcp`, `setup-unreal`, `run-flow`, `build-plugin`, on one self-hosted runner.
4. `smoke-test`, `live-test`, `package-plugin`, and the release composites in both suites.

## 7. Decisions needed

1. **Org names.** `repo-agents` and `ue-mcp-actions` as proposed, or others. Organizations are created in the browser by the account owner.
2. **Marketplace listing** for the agent suite, now or after `v1`.
3. **Agent suite license and visibility.** Public is required for public repos like ue-mcp to call it.
4. **Runner hosting** for the Unreal suite (phase 3): which machines, which engine versions first.
