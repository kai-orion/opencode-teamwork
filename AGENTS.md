# Agent Notes

## Project Identity

This package is `@sandlada/opencode-teamwork`: an OpenCode plugin that brings **Antigravity-style multi-agent teamwork** (`/teamwork`) to OpenCode. It is adapted (forked) from [`@prevalentware/opencode-goal-plugin`](https://github.com/prevalentWare/opencode-goal-plugin).

- The upstream package keeps goal mode (`/goal`); this fork no longer contains goal-mode behavior. The two plugins are designed to be installed side by side, so this plugin must never register `/goal`, touch the goal state file, or share its env vars.
- References for the target behavior:
  - Teamwork agent teams (`/teamwork-preview`): https://antigravity.google/docs/teamwork/
  - Boost deep reasoning (`/boost`): https://antigravity.google/docs/boost/
- The plugin targets **OpenCode V2 only** (`setupV2`). Do not add V1 goal-engine-style compatibility paths.

## Architecture (who owns what)

- **The plugin state machine is Sentinel** (`src/engine.ts`). It — not an LLM — owns sequencing: orchestrator plan, per-milestone explore/implement, Critic -> Challenger -> Auditor gates, retry ceilings, and the final Success Auditor. All session operations go through the `SessionOps` interface so the engine is testable with fakes.
- **Roles are real hidden subagents where the host allows it.** `src/server.ts` registers seven agents (`teamwork-orchestrator`, `-explorer`, `-worker`, `-critic`, `-challenger`, `-auditor`, `-successAuditor`) through the V1 `config` hook plus a best-effort V2 `agent.transform` mutation. Explorers and every verification role have edit denied. On hosts where neither channel sticks (observed on 2.0.16 with lazily loaded plugins), the engine detects this at setup, creates role sessions without a named agent, and embeds the role's system prompt into the task text — permission isolation then degrades to prompt-level; `sessionOps.createSession` reports `agentApplied` so the engine knows. Sentinel itself is not an LLM agent.
- **Reports, not vibes.** Role sessions must submit structured results through the `teamwork_report` tool (and the orchestrator through `teamwork_submit_plan`); the engine fails a track whose session ends without a report. Completion claims must cite concrete evidence (test output, build results), never assertions alone.
- **Research-only milestones skip the gates** (no candidate changes to verify); implementation milestones always gate.

## Project Shape

- `src/server.ts` — V2 plugin: agent registration, the seven `/teamwork*` commands, the nine `teamwork_*` tools, usage accounting and plan-mode pause via events. The V1 `server` export exists only for the `config` hook (agent registration).
- `src/engine.ts` — the Sentinel state machine (`TeamEngine`), isolated from OpenCode by `SessionOps`.
- `src/state.ts` — persisted project state (Effect + Schema), one project per session at `OPENCODE_TEAMWORK_STATE_PATH` (default `<data>/opencode-teamwork/projects.json`), version `{version: 1, projects}`. All schema changes must stay additive.
- `src/artifacts.ts` — renders request.md / plan.md / progress.md under `<repo>/.opencode/teamwork/<slug>/`. The plugin owns artifact writing; never move artifacts into the state JSON or vice versa.
- `src/prompts.ts` — role agent system prompts, the Phase 1 interview template, role task prompts, command templates, and Sentinel notification prompts.
- `src/i18n.ts` — en / zh-TW / zh-CN messages; all three locales must stay structurally identical (a test enforces it). Artifacts follow the interview's artifact locale.
- `src/tui.ts` — Solid/OpenTUI sidebar + palette command. Reads the shared state file via `getProjectSync` (atomic writes make this safe); do not reintroduce message scanning. Exported as source — avoid heavy runtime dependencies.
- `test/` — Bun tests; `scripts/smoke-v2-lifecycle.ts` — end-to-end V2 smoke against a fixture model.

## Change Guidelines

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

`bun run build` writes `dist/server.js`. The package publishes `dist`, `src/tui.ts`, `src/i18n.ts`, `LICENSE`, and `README.md`; confirm `npm pack --dry-run` includes what runtime installation needs.

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

The smoke asserts, against a real `opencode2 serve` process: the plugin activates (`local.teamwork.server`), all seven commands are registered, `/teamwork` produces an `awaitingApproval` project plus a request artifact on disk, `/teamwork-approve` drives the state machine through plan -> milestones -> success audit, and the project reaches `complete` with evidence. Inspect the state file (`OPENCODE_TEAMWORK_STATE_PATH`) and the artifacts directory afterward if you need to confirm persistence.
