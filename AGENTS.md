# Agent Notes

## Project Identity

This package is `@sandlada/opencode-teamwork`: an OpenCode plugin that brings **Antigravity-style multi-agent teamwork** (`/teamwork`) to OpenCode. It is adapted (forked) from [`@prevalentware/opencode-goal-plugin`](https://github.com/prevalentWare/opencode-goal-plugin).

- The upstream package keeps goal mode (`/goal`); this fork no longer contains goal-mode behavior. The two plugins are designed to be installed side by side, so this plugin must never register `/goal`, touch the goal state file, or share its env vars.
- References for the target behavior:
  - Teamwork agent teams (`/teamwork-preview`): https://antigravity.google/docs/teamwork/
  - Boost deep reasoning (`/boost`): https://antigravity.google/docs/boost/
- The plugin targets **OpenCode V2 only** (`setupV2`). Do not add V1 goal-engine-style compatibility paths.
- **English only.** All prompts, artifacts, commands, and TUI copy are English. The model answers in the user's language on its own; translating prompts is out of scope.
- **Breaking v2.** Project state schema is version 2; v1 state files are dropped (not migrated) with a one-time warning. Old `.opencode/teamwork/<slug>/` artifacts are not read or written.

## Architecture (who owns what)

- **The plugin state machine is Sentinel** (`src/engine.ts`). It — not an LLM — owns sequencing: orchestrator plan, per-milestone explore/build, per-path verification gates, and the final Success Auditor. There is **no fixed retry ceiling**: a failed gate sends the work back to the builders with the failing verdict as context and re-runs the gate; the loop ends on pass or on user pause/cancel. All session operations go through the `SessionOps` interface so the engine is testable with fakes.
- **Five execution paths** (`general` default, `iterative`, `review`, `math`, `math-large`), selected by the Sentinel in Phase 1 and recorded in the brief. The orchestrator may not change the path. Gates per path follow `skill-teamwork/roles/orchestrator.md`: General (`explorer → workers → critic → challenger[deep=on] → auditor`), Iterative (single worker, never parallel, challenger only when planned + deep), Review (`reviewers → synthesizer → critic → auditor`, no source edits), Math (`provers → falsifier[deep=on] → verifier`), Large Team (parallel prover+falsifier pairs + verifier, `.teamwork/knowledge/`).
- **Roles are real hidden subagents where the host allows it.** `src/server.ts` registers twelve agents (`teamwork-orchestrator`, `-explorer`, `-worker`, `-critic`, `-challenger`, `-auditor`, `-prover`, `-falsifier`, `-verifier`, `-reviewer`, `-synthesizer`, `-successAuditor`) through the V1 `config` hook plus a best-effort V2 `agent.transform` mutation. Builders/probers may edit (assigned files + `scratch/`); every verification role is read-only. On hosts where neither channel sticks, the engine creates role sessions without a named agent and embeds the role's system prompt into the task text — permission isolation then degrades to prompt-level; `sessionOps.createSession` reports `agentApplied` so the engine knows. Sentinel itself is not an LLM agent.
- **Skill is the prompt source of truth.** `skill-teamwork/SKILL.md` + `skill-teamwork/roles/` own all role behavior. `scripts/sync-prompts.ts` embeds them verbatim into `src/prompts.generated.ts` at build time (`bun run build` runs it first; `bun run check:prompts` asserts freshness in CI/prepublish). Never hand-edit the generated file, and never duplicate role behavior in `src/prompts.ts` — that file only builds the `base + role + task block` assembly and thin command wrappers over `roles/sentinel.md`.
- **Reports, not vibes.** Role sessions must submit structured results through the `teamwork_report` tool (and the orchestrator through `teamwork_submit_plan`); the engine fails a track whose session ends without a report. Every subagent prompt ends with the report-block contract from `roles/shared/base.md`. Completion claims must cite concrete evidence (test output, build results), never assertions alone.
- **Research-only milestones skip the gates** (no builder tracks means no candidate changes to verify). Every builder milestone must carry its path's gate tracks, and builder file ownership must be exclusive within a milestone — the engine validates both and pauses the project on violation.

## Project Shape

- `skill-teamwork/` — the skill: `SKILL.md` (5 paths, phases, gates, rules), `roles/` (sentinel/orchestrator/shared base/coding/math/review/success-auditor), `scripts/` (python helpers mirrored by `hasValidReportBlock`/`findOwnershipConflicts` in `src/prompts.ts`), `examples/`.
- `scripts/sync-prompts.ts` — build-time codegen: skill markdown → `src/prompts.generated.ts` (`--check` mode for CI).
- `src/server.ts` — V2 plugin: 12 agent registrations, the seven `/teamwork*` commands, the nine `teamwork_*` tools, usage accounting and plan-mode pause via events. The V1 `server` export exists only for the `config` hook (agent registration).
- `src/engine.ts` — the Sentinel state machine (`TeamEngine`), isolated from OpenCode by `SessionOps`.
- `src/state.ts` — persisted project state (Effect + Schema), one project per session at `OPENCODE_TEAMWORK_STATE_PATH` (default `<data>/opencode-teamwork/projects.json`), version `{version: 2, projects}`. Brief carries `executionPath`, `teamScale`, `deep`; there is no locale, no executor, no retry ceiling.
- `src/artifacts.ts` — renders brief.md / request.md / plan.md / progress.md under `<repo>/.teamwork/` plus `scratch/` and `knowledge/` (math paths). The plugin owns artifact writing; never move artifacts into the state JSON or vice versa.
- `src/prompts.ts` — task-block assembly (`base + verbatim role + task`), thin English command templates, notification prompts, and the TS mirrors of the skill's validation scripts.
- `src/tui.ts` — Solid/OpenTUI sidebar + palette command (English only). Reads the shared state file via `getProjectSync` (atomic writes make this safe); do not reintroduce message scanning. Exported as source — avoid heavy runtime dependencies.
- `test/` — Bun tests; `scripts/smoke-v2-lifecycle.ts` — end-to-end V2 smoke against a fixture model.

## Change Guidelines

- **Change the skill first.** Role behavior lives in `skill-teamwork/roles/`; `src/` only consumes it via codegen. After editing any role markdown or `SKILL.md`, run `bun run sync:prompts`.
- Keep the public Promise-based state API (`getProject`, `createProject`, `approveProject`, `pauseProject`, `resumeProject`, `cancelProject`, `completeProject`, `setMilestonePlan`, `submitTrackReport`, ...) stable; hooks, the engine, and tests call it directly.
- Keep `zod` in dependencies for OpenCode tool schemas; V2 tools currently use raw JSON Schema helpers (`v2ObjectSchema`).
- Effect is intentionally used in the state/persistence boundary. Do not spread Effect into the TUI.
- If server code imports a runtime dependency that should be resolved from `dependencies`, externalize it in the Bun build script so the package does not silently bundle it.
- State writes remain atomic: temp file -> fsync -> rename (`src/atomic-write.ts`, shared with the quarantine/recovery path).
- Use `OPENCODE_TEAMWORK_STATE_PATH` for tests and smoke runs so you do not touch real user state.
- Verification honesty is user-facing behavior: any prompt change must keep the rule that role sessions report real command output and that fabricated evidence is a failure.

## Local Validation

Before treating a code change as complete, run the relevant checks. For release-level changes, run the full local gate:

```bash
bun run typecheck
bun run test
bun run build
bun run pack:dry-run
```

`bun run build` runs `sync:prompts` first, then writes `dist/server.js`. The package publishes `dist`, `src/tui.ts`, `src/state.ts`, `src/atomic-write.ts`, `skill-teamwork/`, `LICENSE`, and `README.md`; confirm `npm pack --dry-run` includes what runtime installation needs.

For a full end-to-end check with a local OpenCode V2 binary and a scripted fixture model:

```bash
bun scripts/smoke-v2-lifecycle.ts          # or: bun run smoke:v2
OPENCODE_V2_BIN=... bun scripts/smoke-v2-lifecycle.ts /abs/path/to/@scope/pkg
```

## Publishing Flow

Publishing is manual via `npm publish` from a maintainer machine. There is no
CI and nothing ships on push or merge.

1. Run the full local gate: `bun run typecheck && bun run test && bun run build && bun run pack:dry-run`.
2. Decide the next version (semver; `bun run ci:version` prints what the next patch would be against npm).
3. Bump `version` in `package.json`, commit, then `npm publish`.
4. Tag the release: `git tag v<version> && git push origin v<version>`, and verify:

```bash
npm view @sandlada/opencode-teamwork version dependencies
```

## End-To-End Plugin Test

To test this plugin end to end, do not stop at unit tests. Run the local gates first, then the V2 smoke:

```bash
bun scripts/smoke-v2-lifecycle.ts
```

The smoke asserts, against a real `opencode2 serve` process: the plugin activates (`local.teamwork.server`), all seven commands are registered, `/teamwork` produces an `awaitingApproval` project plus brief/request artifacts under `.teamwork/` on disk, `/teamwork-approve` drives the state machine through plan -> milestones -> success audit, and the project reaches `complete` with evidence. Inspect the state file (`OPENCODE_TEAMWORK_STATE_PATH`) and the artifacts directory afterward if you need to confirm persistence.
