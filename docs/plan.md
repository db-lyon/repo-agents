# repo-agents: plan

Status: draft for review, 2026-10-16. Nothing in `C:\Users\david\Projects\repo-agents` is committed or pushed. No code changes until this plan is agreed.

## 1. Goal

One repository, `db-lyon/repo-agents`, that gives any GitHub project an autonomous issue-to-release lifecycle run by Claude agents, configured per project in one file. ue-mcp is the first consumer and the acceptance test. Any other project the user picks must be able to adopt it with one install command and a config file.

"Done" means every stage below has run for real on ue-mcp, end to end, and has been adopted by a second repository, with no manual steps left except the ones listed as blockers in section 9.

## 2. The lifecycle

```
issue opened
  -> triage      label, dedupe, route, close or keep open
  -> resolve     agent writes the fix on a branch, opens a PR (Refs #N)
  -> review      agent reviews the PR, approves or requests changes
  -> merge       when policy allows and every required check is green
  -> closeout    issue gets fixed-pending-release (or closes, per policy)
  -> release     agent writes notes, version bump, draft or published release
  -> closeout    issues whose fix shipped in a stable release close, citing the version
```

Each arrow is a GitHub event or a dispatch. Every stage can also be started by hand (`workflow_dispatch`) or run locally with the CLI.

| Stage | Trigger | Agent can | Writes (after guards) |
|---|---|---|---|
| triage | issue opened, dispatch | read repo, read issues | labels, comment, close, transfer, dispatch resolve |
| resolve | resolve label, dispatch, triage auto-resolve | read, edit a throwaway checkout, run allow-listed commands | branch, commit, PR, issue labels and comment |
| review | PR opened or updated, dispatch | read base and PR head, never execute PR code | review, inline comments, dismiss own stale reviews |
| merge | review approve, checks green | none | merge (auto-merge or direct) |
| closeout (merge) | PR merged | none | label referenced issues fixed-pending-release, or close per policy |
| release | schedule, dispatch | read history, write notes | version bump commit, tag, draft or published release |
| closeout (release) | release published | none | close issues whose fix commits are all in the stable tag; one comment on prereleases |

## 3. Trust model

The issues and PRs are public input. Every stage assumes the text it reads is hostile.

1. **An agent never holds a token that can write.** Each stage is two Actions jobs. `decide` runs the agent with a read-only `GITHUB_TOKEN`. `apply` has write permissions and runs no model. The only thing crossing between them is a JSON decision (and for resolve, a patch file) passed as an artifact.
2. **The agent's reach is a fixed allow list.** Claude Code runs with `--setting-sources ""` (the project's own `.claude/settings.json` is ignored; ue-mcp's allows every command), `--strict-mcp-config`, `--permission-mode dontAsk`, an explicit `--tools` list and a Bash allow list of read-only commands plus the project's declared verify commands. Compound commands are denied as a whole. Verified: a write outside the list is denied.
3. **Review never executes PR code.** The PR head is checked out into `pr/` read-only. Config, prompts and house rules come from the base checkout in `project/`. Agent instruction files in the PR (`CLAUDE.md`, `AGENTS.md`, `.claude/`, `.mcp.json`) are deleted from `pr/` before the agent runs.
4. **Resolve runs project commands, but only in the throwaway checkout, with tokens scrubbed from the environment.** The apply job re-runs verification itself and does not trust the agent's claim. Commits use `--no-verify` and `core.hooksPath=/dev/null` so agent-written hooks never run beside a write token. The push token is set on the remote right before the push and removed after.
5. **Every claim is verified before a write.** A duplicate must be a real other issue. A fixing commit must be on the default branch. "Released" is computed from git tags and published releases, never from the model.
6. **Every write passes through one guarded seam** (section 4.3). A guard that crashes denies the write.

Residual risks, accepted with mitigations:

- The decide job holds `ANTHROPIC_API_KEY`. An injected agent has no network tool and no write token, so exfiltration needs a command on the allow list that reaches the network. The allow list contains `gh` read commands only. Mitigation: spend limit in the Anthropic Console; per-run `--max-budget-usd`.
- `pull_request_target` runs with secrets on fork PRs. Mitigated by rules 3 and 1: the decide job reads, the apply job never touches PR code.

## 4. Engine: flowkit

repo-agents is a flowkit host. Each part of flowkit carries a defined job.

### 4.1 Flows and tasks

- Each stage half is a flow: `triage.decide`, `triage.apply`, `resolve.decide`, `resolve.apply`, `review.decide`, `review.apply`, `closeout.merged`, `closeout.released`, `release.plan`, `release.gate`, `release.notes`, `release.publish`.
- Steps are numbered with gaps (10, 20, 30) so a project overlay can insert a step (15) or switch one off (`task: None`).
- Tasks are flowkit `BaseTask` classes with `static optionsSchema` (validated before they run) and `static outputs`. Pure logic stays in `stages/<stage>/*.mjs` under unit test; tasks only gather facts and call the write seam.
- `claude_code` is one task that runs Claude Code headless. flowkit's own `agent` and `agent_prompt` tasks are not used: they call a model API directly, and the stages need Claude Code's file tools and permission sandbox.

### 4.2 Config layering

Lowest first:

1. toolkit `flows/*.yml` and `settings` defaults
2. the project's `.github/repo-agents.yml`
3. `.github/repo-agents.<REPO_AGENTS_ENV>.yml`
4. `.github/repo-agents.local.yml` (gitignored, for local runs)

Loaded with flowkit `loadConfig`, `strict: true` so a typo fails with a did-you-mean instead of silently doing nothing. Arrays append with `__merge: append`.

### 4.3 Guards: one seam for every write

Every GitHub write (label, unlabel, comment, close, reopen, transfer, push, create PR, edit PR, review, dismiss review, merge, create release, edit release, tag, dispatch) goes through one function, `write(op)`, wrapped by flowkit `runGuarded`. The operation carries `{ stage, kind, target, payload, decision }`.

Toolkit guards, in order:

| Guard | Denies |
|---|---|
| `mode` | everything in `dry-run`; closes, transfers and merges in `propose` (turned into a proposal comment instead) |
| `rate` | more than `limits.writes_per_run` writes, or more than `limits.closes_per_day` closes |
| `confidence` | close, transfer, approve or merge when the decision's confidence is below `policy.<stage>.min_confidence` |
| `close_policy` | a close that is not a duplicate, an invalid or a transfer, unless it cites a commit contained in a published stable release (the "shipped means released" rule) |
| `push_targets` | a push to the default branch from any stage except release; a push to a branch outside `resolve.branch_prefix` from resolve |
| `paths` | a push whose diff touches `resolve.protected_paths` |
| `merge_policy` | a merge of a PR touching `review.human_paths` or `resolve.unverifiable_paths`, a PR outside the `review.auto_merge` policy, or one whose required checks are not all green |
| `prose` | public text (comment, PR body, commit message, release notes) containing banned characters or `project.banned_phrases` |
| `audit` (after) | nothing; records every write to the job summary and an audit artifact |

A project adds its own guards as tasks named `guard.<name>.<phase>` in its overlay, discovered with `discoverTaskGuards`. Scopes: `close`, `push`, `merge`, `release`, `public_text`. Example: ue-mcp adds `guard.native_proof.beforeMerge`, which denies merging a PR that touches `plugin/**` without a live editor verification record.

This replaces the per-stage safety branches the current code has. The planning functions still decide what to do; the guards decide whether it may be done.

### 4.4 Preflight checks

Gates are declared as flowkit `checks` on the release and merge flows (CI green on the release commit, no pending draft release, required workflows green, gate runner available). `repo-agents preflight release.publish` reports what would refuse and why, without running anything.

### 4.5 Rollback

Multi-write steps return rollback records, and the apply flows set `rollback_on_failure: true`. Examples: release creates a draft, then the push fails, so the draft is deleted. Resolve pushes a branch, then PR creation fails, so the branch is deleted.

### 4.6 Hooks

`afterStep` and `afterRun` hooks write the job summary, cost (from the agent result), and the audit trail. Stages stop writing their own summaries.

### 4.7 Plan mode

`repo-agents run <flow> --plan` lists the steps the project's merged config would run, nested flows expanded. Used in the toolkit's own tests for every flow and every example config.

## 5. Per-project surface

What a project controls, all in `.github/repo-agents.yml`:

- `settings.project`: name, what it owns (plain sentences), context files the agents read (`CLAUDE.md`, style docs), voice, banned phrases.
- `settings.routing`: other trackers, each with what it owns and either a repo (transfer) or a label (stays here).
- `settings.labels`: names of every label the toolkit uses.
- `settings.policy`: per stage mode, model, budget, confidence floors, auto-merge policy, close policy.
- `settings.resolve`: setup and verify commands, extra allowed commands, protected paths, unverifiable paths.
- `settings.release`: bump rule, version file or command, notes style doc, headline frontmatter, publish mode, gates and gate runner.
- `tasks` and `flows`: extra tasks (a `shell` step, a project script by class path), extra guards, inserted or skipped steps.

The caller workflow (`.github/workflows/repo-agents.yml`) is generated by the installer and is identical across projects except for secrets mapping.

## 6. Distribution

- `db-lyon/repo-agents`, public, so public and private repositories can call its reusable workflows.
- Major tag `v1`, moved on each compatible release. Consumers pin `@v1`. The toolkit checks itself out at the same ref inside each job.
- Installer: `npx github:db-lyon/repo-agents install --repo owner/name` writes the caller workflow and a starter config through a PR, creates the labels, enables auto-merge and "Actions can approve PRs" on the repo, and lists the secrets still missing.
- Secrets per consumer: `ANTHROPIC_API_KEY` (required), `REPO_AGENTS_TOKEN` (fine-grained PAT or GitHub App token; required for transfers, for pushes that must start the project's CI, and for merges that must start push workflows).

## 7. Cost controls

- Per-run `--max-budget-usd` per stage (defaults: triage 2, review 3, notes 2, resolve 8).
- `limits.monthly_usd` in settings, enforced by a `budget` guard that reads the month's spend from the audit artifacts of earlier runs (via the Actions API) and denies new agent runs past the cap. Until that guard exists, the Anthropic Console spend limit is the only hard cap.
- Measured so far: triage $0.03 to $0.13 per issue.

## 8. ue-mcp configuration

The rules from ue-mcp's `CLAUDE.md` and the maintainer's standing feedback, and where each one lives:

| Rule | Where |
|---|---|
| Issues close only when the fix is in a published release; merged means fixed-pending-release | `closeout.close_on: release`, `close_policy` guard |
| PRs and commits use `Refs #N`, never `Closes #N` | `resolve.issue_ref: Refs`, `prose` guard denies `Closes #`/`Fixes #` in agent text |
| Patch bumps only; prereleases `X.Y.Z-beta.N`; never a stable unless explicitly told | `release.bump: prerelease`, `preid: beta`; stable only by dispatch input `stable: true` |
| Draft release with `headline:` frontmatter before the bump; CI publishes | `release.publish: draft-and-bump`, `notes.headline: true`, `headline_validate: node scripts/release-headline.mjs` |
| Release notes copy the last stable's shape, style doc rules | prompt gets `docs/release-notes-style.md` and the last stable body |
| No em dashes, no competitor names, no attribution trailers | `prose` guard with `banned_phrases`; commit message builder never adds trailers |
| Never ship without green tests; smoke and live tests need an editor on `tests/ue_mcp` | release gate runs on a self-hosted runner (blocker 9.1) |
| Every action needs a live, effect-verified editor call before merge | `guard.native_proof.beforeMerge` for PRs touching `plugin/**` or handler code (blocker 9.1) |
| C++ edits only under `plugin/ue_mcp_bridge/`; never in `tests/ue_mcp/` | `resolve.protected_paths: [tests/ue_mcp/Plugins/**, .github/workflows/**]` |
| Atomic commits; squash single-change PRs | resolve makes one commit per PR; `review.merge_method: squash` |
| Routing: Studio, Studio plugin, PIE Studio, Voxel by transfer; Perforce, Meshy, Fab Editor by label | `settings.routing` |
| Feedback-bot issues are triaged; maintainer-filed issues are skipped | `triage.skip_maintainers: true` |

ue-mcp resolve verify commands: `npx tsc --noEmit`, `npm run test:unit`, `npm run lint:prose`. Unverifiable paths: `plugin/**`.

### Migration from the in-repo workflows

ue-mcp already runs `issue-triage.yml` (act mode, live since today) and `release-closeout.yml`. Order:

1. Ship repo-agents triage and closeout, run them on ue-mcp in `dry-run` beside the old workflows for the same issues, compare decisions.
2. Switch ue-mcp's caller on, delete the two in-repo workflows and their scripts in the same PR.
3. Turn on resolve with `review.auto_merge: none` (agent PRs, human merge).
4. Turn on review. Then auto-merge for TS-only agent PRs.
5. Turn on release once blocker 9.1 is resolved.

## 9. Blockers and decisions for the user

### 9.1 Live editor gate (blocks autonomous merge of native changes and autonomous release for ue-mcp)

ue-mcp's release rule and its per-action proof rule need Unreal Editor running `tests/ue_mcp`. GitHub-hosted runners cannot do that. Options:

- **A. Self-hosted runner on the user's machine**, label `ue`, used only by the release gate and the native-proof job. Risk: ue-mcp is public; a fork PR's workflow can target a self-hosted runner. Mitigation: the runner is registered to accept only jobs from `workflow_dispatch` and `schedule` on the default branch (runner group restricted to selected workflows), and fork PR workflows require approval. It also runs editors beside the user's own (the one-test-editor rule applies).
- **B. No autonomous native merge or release.** Agents open PRs and draft releases; the user runs `npm run test:smoke` / `test:live` and merges.

Recommendation: A, after B for the first week.

### 9.2 Write token

Pushes and merges made with `GITHUB_TOKEN` do not start other workflows. ue-mcp's CI runs on push and has no `workflow_dispatch`, so a bump pushed with `GITHUB_TOKEN` never publishes. Options: a GitHub App (cleanest; installable on every repo; needs the user to create it once in the browser), or a fine-grained PAT per repo. ue-mcp already has `ISSUE_ADMIN_TOKEN` (classic PAT), usable now.

Recommendation: GitHub App `repo-agents[bot]`, with `ISSUE_ADMIN_TOKEN` until it exists.

### 9.3 Model API key

Every consumer needs `ANTHROPIC_API_KEY`. ue-mcp has one (set 2026-03-22). The user confirms it belongs to the Console organization the monthly credits go to, and sets a spend limit there.

### 9.4 Auto-merge scope

Default: agent PRs only (`auto_merge: agents`), TS-only, every required check green, high-confidence approve, no human paths. Outside PRs are reviewed, never auto-merged.

## 10. Current code: keep or rework

Everything is on disk at `C:\Users\david\Projects\repo-agents`, uncommitted.

| Part | State | Action |
|---|---|---|
| `lib/agent.mjs`, `tasks/claude-code.mjs` | works, verified locally against ue-mcp | keep |
| `lib/engine.mjs`, `bin/repo-agents.mjs` | works; logger prefix bug fixed | add `strict: true`, guards registry, hooks, preflight command |
| `lib/config.mjs` | hand-written defaults and merge | defaults move into `flows/settings.yml`; validation stays |
| `lib/github.mjs` | direct gh writes | split: reads stay; writes move behind `write(op)` |
| `lib/text.mjs` | sanitize | keep; prose guard calls it |
| `stages/*/` pure logic + tests | triage, resolve, review, release done; 104 tests pass | keep; strip safety branches that become guards |
| `tasks/*.mjs` | triage, resolve, review, release | rework writes onto `write(op)`, add rollback records |
| `flows/*.yml` | four stages | keep; add `checks`, `rollback_on_failure` |
| `.github/workflows/*.yml` | four reusable workflows, actionlint clean | keep; add closeout |
| closeout stage | exists only in ue-mcp | port into repo-agents |
| caller template, installer | not written | write |
| toolkit CI | not written | write: unit tests, actionlint, plan of every flow against example configs |

Known defects to fix during the rework:

- Triage skipped duplicate search on one run. Fixed by pre-searching candidates in `triage.prepare` (written, not yet re-verified because the edit was interrupted).
- Agents chained shell commands and lost the call. Fixed with a tool-rules section in every prompt and a wider read-only command list (verified: zero denials on rerun).
- The query extractor turns `editor(play_in_editor)` into `editor`; it should keep `play_in_editor` (edit was interrupted).

## 11. Verification

Each stage is done only when all of these hold:

1. Unit tests for its pure logic and its guards.
2. `--plan` of its flows under the default config and under ue-mcp's config, in toolkit CI.
3. A fixture run in a scratch repository (`db-lyon/repo-agents-sandbox`, private): the real workflow runs on GitHub with the agent replaced by a fixture decision (`REPO_AGENTS_FIXTURE`), and every write it makes is checked with `gh`.
4. A real run on ue-mcp, in `dry-run` first and then live, with the result checked by hand against what the maintainer would have done.

## 12. Order of work

1. Guards and the write seam; strict config; hooks; preflight command. Rework the four existing stages onto them.
2. Port closeout. Caller template. Installer.
3. Toolkit CI. Sandbox repository and fixture runs of every stage.
4. Publish `db-lyon/repo-agents` and tag `v1`.
5. ue-mcp migration steps 1 to 4 (section 8).
6. Second consumer repository, chosen by the user, installed with the installer only.
7. Release stage on ue-mcp once 9.1 and 9.2 are settled.
