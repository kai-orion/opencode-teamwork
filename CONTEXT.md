# OpenCode Teamwork Plugin

This context defines the language for teamwork behavior across OpenCode surfaces. It exists to keep the plugin's state machine, role sessions, artifacts, and user-facing surfaces distinct.

## Language

**Teamwork Project**:
A session-scoped unit of work that runs the two-phase workflow (scoping interview, then autonomous multi-agent execution) under one persisted state record.
_Avoid_: goal, task, job

**Prompt Artifact**:
The reviewable request file produced by the Phase 1 interview; approval of this artifact is the single gate between planning and execution.
_Avoid_: brief file, spec

**Sentinel**:
The plugin's own state machine. It records the request, routes role sessions, posts progress, enforces verification gates, and spawns the Success Auditor. Sentinel is NOT an LLM agent.
_Avoid_: coordinator agent, supervisor

**Role Session**:
A real OpenCode subagent session (orchestrator, explorer, worker, critic, challenger, auditor, successAuditor) spawned and waited on by the engine. Each submits exactly one structured `teamwork_report`.
_Avoid_: subagent task, prompt persona

**Verification Gate**:
The Critic -> Challenger -> Auditor sequence a milestone's candidate changes must pass before the milestone is approved; failures loop back to workers until the retry ceiling.
_Avoid_: review step, QA phase

**Integrity Mode**:
The verification strictness agreed during the interview (development, demo, benchmark) and enforced by the Auditor.
_Avoid_: strictness level, quality mode

**Artifact**:
A real markdown file under `.opencode/teamwork/<slug>/` (request, plan, progress) written by the plugin; the state JSON stores only pointers.
_Avoid_: state file, log

**Surface Indicator**:
The TUI sidebar/palette affordance showing live project state; it reads the shared state file and never owns it.
_Avoid_: dashboard, project panel

## Relationships

- A **Teamwork Project** is persisted per session and driven by **Sentinel**.
- **Role Sessions** are spawned by Sentinel and report through the `teamwork_report` tool.
- A **Verification Gate** blocks milestone approval; its strictness comes from the **Integrity Mode**.
- **Artifacts** are the human-reviewable projection of the project state; **Surface Indicators** read state, not artifacts.

## Example Dialogue

> **Dev:** "Can the Critic just be a prompt section in the worker?"
> **Domain expert:** "No. A **Verification Gate** requires an independent **Role Session**; same-session prompting defeats the isolation the gate exists for."

## Flagged Ambiguities

- "auto-approve the project" was rejected: approval of the **Prompt Artifact** is always a human action via `/teamwork-approve`.
- "run in a separate workspace" was rejected: projects execute in the session's current repo; the interview only confirms the directory.
