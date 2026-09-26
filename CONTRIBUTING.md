# Contributing to OpenCode Teamwork

Thanks for your interest in improving `@sandlada/opencode-teamwork`. This guide explains how to set up the project, make changes, and get them merged.

## Prerequisites

- [Bun](https://bun.sh) (the project is built, tested, and bundled with Bun)
- An [OpenCode](https://opencode.ai) install if you want to try the plugin end to end

## Getting started

```bash
git clone https://github.com/kai-orion/opencode-teamwork.git
cd opencode-teamwork
bun install
```

Useful scripts:

| Script | What it does |
| --- | --- |
| `bun run test` | Run the unit test suite |
| `bun run test:coverage` | Run the test suite with a coverage report |
| `bun run typecheck` | TypeScript `--noEmit` check |
| `bun run build` | Bundle `src/server.ts` into `dist/` |
| `bun run pack:dry-run` | Inspect the npm package contents |

## Project layout

- `src/server.ts` — OpenCode V2 plugin: role-agent registration, `/teamwork*` commands, `teamwork_*` tools, usage accounting.
- `src/engine.ts` — the Sentinel state machine that drives role sessions through milestones and verification gates.
- `src/state.ts` — persistent per-session project state, budgets, milestones, tracks, and history.
- `src/artifacts.ts` — request / plan / progress markdown rendering under `.opencode/teamwork/<slug>/`.
- `src/prompts.ts` — role system prompts, the Phase 1 interview template, and Sentinel notification prompts.
- `src/i18n.ts` — en / zh-TW / zh-CN messages (all three locales must stay structurally identical).
- `src/tui.ts` — terminal UI project sidebar and command palette entry.
- `test/` — Bun test suites mirroring the source modules.
- `CONTEXT.md` — shared domain vocabulary for teamwork behavior.

## Making changes

1. Create a topic branch from `main`.
2. Make your change, keeping the existing code style (no semicolons, 130-column lines, strict TypeScript).
3. Add or update tests — behavior changes need regression coverage.
4. Run the local gates: `bun run test && bun run typecheck && bun run build`.
5. Commit the rebuilt `dist/server.js` when `src/server.ts` (or its imports) changed — the built file is tracked on purpose.
6. Open a pull request against `main` describing the problem, the approach, and how you verified it. Link the related issue (`Closes #NN`) when one exists. The pull request description must also name the AI model and agent harness used (for example, OpenCode or Claude Code), or explicitly state that the change was made manually.

## Checks and releases

- Run typecheck, tests with coverage, and a build locally before proposing a change. All checks must pass.
- Publishing is manual: the maintainer runs the local gates, bumps the version, and runs `npm publish`. Nothing ships to npm on push or merge.

## Reporting bugs and requesting features

Use the [issue templates](https://github.com/kai-orion/opencode-teamwork/issues/new/choose). Include your OpenCode version, plugin version, install method, and reproduction steps for bugs.

For security issues, do not open a public issue — see [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating you agree to uphold it.
