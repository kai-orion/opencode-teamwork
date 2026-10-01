import {
  assignTrackSession,
  completeProject,
  failTrackSession,
  getProject,
  pauseProject,
  recordAdhocSession,
  recordVerificationAttempt,
  setMilestonePlan,
  setMilestoneStatus,
  setSentinelUpdate,
  submitTrackReport,
  suspendTimerForPermission,
} from "./state"
import type { ExecutionPath, Milestone, Project, TeamRole, Track } from "./state"
import {
  agentNameForRole,
  findOwnershipConflicts,
  permissionApprovalPrompt,
  roleTaskPrompt,
  sentinelDecisionPrompt,
  trackSummaryPrompt,
  ROLE_AGENT_SYSTEM_PROMPTS,
} from "./prompts"
import type { RoleAgentName } from "./prompts"
import { artifactDirPath, refreshPlanAndProgress, writeArtifacts } from "./artifacts"
import { setProjectArtifacts } from "./state"
import { join } from "node:path"

/**
 * The Teamwork state machine ("Sentinel"). The engine drives role sessions
 * through a deterministic per-path sequence — orchestrator plan, then
 * per-milestone explore / build / verify gates, then a fresh Success Auditor
 * — enforcing the verification gates that pure prompting cannot.
 *
 * Gates follow skill-teamwork/roles/orchestrator.md per execution path.
 * There is no fixed retry ceiling: a failed gate sends the work back to the
 * builders with the failing verdict as context and re-runs the gate. The run
 * stops only on pass or on user pause/cancel.
 *
 * All OpenCode session operations go through `SessionOps` so the engine is
 * testable against fakes with a temporary state file.
 */

export type PlanTrackInput = {
  title: string
  role: TeamRole
  assignedFiles: string[]
}

export type PlanMilestoneInput = {
  title: string
  description: string
  tracks: PlanTrackInput[]
}

export type ReportPayload = {
  role: TeamRole
  verdict: "pass" | "fail" | "blocked"
  findings: string[]
  evidence: string[]
  blockers: string[]
  artifactsWritten: string[]
}

export type SessionOps = {
  /**
   * Creates a subagent session. Returns the session ID plus whether the
   * requested role agent was actually applied; when it was not, the engine
   * embeds the role's system prompt into the task text instead.
   */
  createSession(input: { agent: string; title: string }): Promise<{ sessionID: string; agentApplied: boolean }>
  /**
   * Best-effort deletion of a role session once it is no longer needed, so
   * teamwork sessions do not pile up in the user's session list. Returns
   * whether the session was actually removed; when the host does not expose
   * removal, the caller falls back to marking the title as finished.
   */
  removeSession(sessionID: string): Promise<boolean>
  /** Best-effort title rename (fallback when removal is unavailable). */
  renameSession(sessionID: string, title: string): Promise<void>
  /** Delivers a user prompt to a session. */
  promptSession(sessionID: string, text: string): Promise<void>
  /** Resolves when the session finishes its current turn (or errors). */
  waitForSession(sessionID: string): Promise<void>
  /** Posts a zero-cost synthetic message into the main session. */
  sendSynthetic(sessionID: string, text: string): Promise<void>
  /** Prompts the main session LLM (used for decision-point notifications). */
  promptMain(sessionID: string, text: string): Promise<void>
  /** Interrupts a running role session (pause/cancel). */
  interruptSession(sessionID: string): Promise<void>
}

export type EngineOptions = {
  directory: string
}

/** Prefix for role session titles so users can spot teamwork sessions at a glance. */
export const TEAMWORK_TITLE_PREFIX = "[teamwork]"
/** Title prefix for finished role sessions the host could not delete. */
export const TEAMWORK_DONE_PREFIX = "[teamwork done]"

class AbortedError extends Error {
  constructor() {
    super("teamwork engine aborted")
    this.name = "AbortedError"
  }
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type ProjectRuntime = {
  sessionID: string
  directory: string
  aborted: boolean
  activeRoleSessions: Set<string>
  reportWaiters: Map<string, Deferred<ReportPayload>>
  planWaiter: Deferred<PlanMilestoneInput[]> | null
  planWaiterOwner: string | null
  stallTimers: Map<string, ReturnType<typeof setTimeout>>
  stallNotified: Set<string>
  runner: Promise<void>
  /** Per-session: was the role agent applied (else the identity rode the prompt)? */
  roleAgentApplied: Map<string, boolean>
}

/** When the host could not register role agents, the identity rides the prompt. */
function withRoleIdentity(role: TeamRole | RoleAgentName, agentApplied: boolean, taskText: string) {
  if (agentApplied) return taskText
  return `${ROLE_AGENT_SYSTEM_PROMPTS[role as RoleAgentName]}\n\n---\n\n${taskText}`
}

/** Builder roles produce candidate changes per execution path. */
function builderRolesFor(path: ExecutionPath): TeamRole[] {
  switch (path) {
    case "general":
    case "iterative":
      return ["worker"]
    case "review":
      return ["reviewer", "synthesizer"]
    case "math":
    case "math-large":
      return ["prover"]
  }
}

/** Roles allowed to edit files/scratch per path (everything else is read-only). */
export function isEditingRole(role: TeamRole): boolean {
  return role === "worker" || role === "challenger" || role === "prover" || role === "falsifier" || role === "synthesizer"
}

export class TeamEngine {
  private readonly ops: SessionOps
  private readonly options: EngineOptions
  private readonly runtimes = new Map<string, ProjectRuntime>()
  /** role session ID -> owning project session ID, for usage attribution. */
  private readonly roleOwners = new Map<string, string>()

  constructor(ops: SessionOps, options: EngineOptions) {
    this.ops = ops
    this.options = options
  }

  isRunning(sessionID: string) {
    return this.runtimes.has(sessionID)
  }

  /** The project session a role session belongs to, if still tracked. */
  projectSessionFor(roleSessionID: string): string | null {
    return this.roleOwners.get(roleSessionID) ?? null
  }

  /** Starts (or restarts) the autonomous runner for an executing project. */
  startExecution(sessionID: string) {
    if (this.runtimes.has(sessionID)) return
    const runtime: ProjectRuntime = {
      sessionID,
      directory: this.options.directory,
      aborted: false,
      activeRoleSessions: new Set(),
      reportWaiters: new Map(),
      planWaiter: null,
      planWaiterOwner: null,
      stallTimers: new Map(),
      stallNotified: new Set(),
      runner: Promise.resolve(),
      roleAgentApplied: new Map(),
    }
    runtime.runner = this.runProject(runtime)
      .catch(async (error) => {
        if (error instanceof AbortedError) {
          await this.finalizeAbort(runtime)
          return
        }
        await this.handleEngineFailure(runtime, error)
      })
      .finally(() => {
        for (const timer of runtime.stallTimers.values()) clearTimeout(timer)
        runtime.stallTimers.clear()
        this.runtimes.delete(sessionID)
        for (const [roleSessionID, owner] of this.roleOwners) {
          if (owner === sessionID) this.roleOwners.delete(roleSessionID)
        }
      })
    this.runtimes.set(sessionID, runtime)
  }

  /** Resolves the pending report waiter for a role session (tool hook). */
  onReport(roleSessionID: string, report: ReportPayload) {
    for (const runtime of this.runtimes.values()) {
      const waiter = runtime.reportWaiters.get(roleSessionID)
      if (waiter) waiter.resolve(report)
    }
  }

  /** Resolves the pending plan waiter for a role session (tool hook). */
  onPlan(roleSessionID: string, plan: PlanMilestoneInput[]) {
    for (const runtime of this.runtimes.values()) {
      if (runtime.planWaiter && runtime.planWaiterOwner != null && roleSessionID === runtime.planWaiterOwner) {
        runtime.planWaiter.resolve(plan)
        return
      }
    }
    const owner = this.roleOwners.get(roleSessionID) ?? roleSessionID
    const runtime = this.runtimes.get(owner)
    if (runtime?.planWaiter) runtime.planWaiter.resolve(plan)
  }

  /** Best-effort permission alarm: surfaces the block and suspends the timer. */
  notifyPermissionPending(roleSessionID: string, detail: string) {
    for (const runtime of this.runtimes.values()) {
      const owned = this.roleOwners.get(roleSessionID)
      const isMain = roleSessionID === runtime.sessionID
      if (owned !== runtime.sessionID && !isMain && !runtime.reportWaiters.has(roleSessionID)) continue
      void (async () => {
        try {
          const project = await getProject(runtime.sessionID)
          if (!project) return
          let trackID = roleSessionID
          let role: string = "worker"
          for (let mi = 0; mi < project.milestones.length; mi += 1) {
            const milestone = project.milestones[mi]!
            for (const track of milestone.tracks) {
              if (track.sessionID === roleSessionID) {
                trackID = track.id
                role = track.role
              }
            }
          }
          this.clearStallTimer(runtime, roleSessionID)
          await suspendTimerForPermission(runtime.sessionID).catch(() => null)
          await setSentinelUpdate(runtime.sessionID, `Permission wait: ${trackID} (${role}) needs approval.`).catch(
            () => null,
          )
          await this.ops
            .promptMain(
              runtime.sessionID,
              permissionApprovalPrompt({ projectSlug: project.slug, trackID, role, detail }),
            )
            .catch(() => undefined)
        } catch {
          // Notification is best-effort.
        }
      })()
    }
  }

  async pause(sessionID: string) {
    const runtime = this.runtimes.get(sessionID)
    if (!runtime) return
    runtime.aborted = true
    await this.abortRoleSessions(runtime)
    // The runner unwinds through AbortedError; the project row is already
    // paused by the caller (pauseProject).
  }

  async cancel(sessionID: string) {
    const runtime = this.runtimes.get(sessionID)
    // Cancel is terminal (unlike pause): remove the role sessions so the user
    // is not left with a pile of dead teamwork sessions.
    if (runtime) {
      await this.pause(sessionID)
      await this.cleanupRoleSessions(runtime)
      return
    }
    // No live runtime (e.g. cancel after a server restart): still clean up
    // recorded sessions from state, followed by aborts being unnecessary.
    await this.cleanupRoleSessionsStatic(sessionID)
  }

  /** After an abort, tell the user why the team stopped if not already told. */
  private async finalizeAbort(runtime: ProjectRuntime) {
    try {
      const project = await getProject(runtime.sessionID)
      if (!project || project.phase !== "budgetLimited") return
      await this.ops.sendSynthetic(
        runtime.sessionID,
        `[Teamwork Sentinel] Project "${project.slug}" hit its budget limit (${project.stopReason ?? "limit reached"}). Ask the team to wrap up or adjust the budgets, then resume with /teamwork-resume.`,
      )
    } catch {
      // Notification is best-effort.
    }
  }

  /**
   * Cleanup path for projects without a live runtime: the sessions are read
   * from persisted state (milestone tracks), not from the runtime cache.
   */
  private async cleanupRoleSessionsStatic(sessionID: string) {
    try {
      const project = await getProject(sessionID)
      if (!project) return
      for (const milestone of project.milestones) {
        for (const track of milestone.tracks) {
          if (!track.sessionID) continue
          const removed = await this.ops.removeSession(track.sessionID).catch(() => false)
          if (!removed) {
            await this.ops
              .renameSession(track.sessionID, `${TEAMWORK_DONE_PREFIX} ${project.slug}`)
              .catch(() => undefined)
          }
          this.roleOwners.delete(track.sessionID)
        }
      }
    } catch {
      // Cleanup is best-effort; cancel must succeed regardless.
    }
  }

  private async abortRoleSessions(runtime: ProjectRuntime) {
    const interruptions = [...runtime.activeRoleSessions].map((roleSessionID) =>
      this.ops.interruptSession(roleSessionID).catch(() => undefined),
    )
    for (const waiter of runtime.reportWaiters.values()) waiter.reject(new AbortedError())
    runtime.reportWaiters.clear()
    if (runtime.planWaiter) {
      runtime.planWaiter.reject(new AbortedError())
      runtime.planWaiter = null
      runtime.planWaiterOwner = null
    }
    for (const timer of runtime.stallTimers.values()) clearTimeout(timer)
    runtime.stallTimers.clear()
    await Promise.allSettled(interruptions)
  }

  private assertActive(runtime: ProjectRuntime, project: Project) {
    if (runtime.aborted) throw new AbortedError()
    if (project.phase !== "executing" || project.planPaused) throw new AbortedError()
  }

  private async handleEngineFailure(runtime: ProjectRuntime, error: unknown) {
    try {
      const detail = error instanceof Error ? error.message : String(error)
      await pauseProject(
        runtime.sessionID,
        `The team stopped unexpectedly: ${detail}`,
        { stopReason: "engine error", blocker: detail, historyType: "error" },
      )
      const project = await getProject(runtime.sessionID)
      await this.ops.promptMain(
        runtime.sessionID,
        sentinelDecisionPrompt({
          projectSlug: project?.slug ?? runtime.sessionID,
          message: `The team stopped unexpectedly: ${detail}. The project is paused; resume it with /teamwork-resume after checking the environment.`,
        }),
      )
    } catch {
      // Nothing more can be done if even the failure path fails.
    }
  }

  private clearStallTimer(runtime: ProjectRuntime, key: string) {
    const timer = runtime.stallTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      runtime.stallTimers.delete(key)
    }
  }

  private scheduleStallReminder(
    runtime: ProjectRuntime,
    key: string,
    trackID: string,
    role: string,
    title: string,
    thresholdSeconds: number | null | undefined,
  ) {
    if (thresholdSeconds == null) return
    if (runtime.stallNotified.has(key)) return
    this.clearStallTimer(runtime, key)
    const timer = setTimeout(() => {
      if (runtime.aborted || runtime.stallNotified.has(key)) return
      runtime.stallNotified.add(key)
      void (async () => {
        try {
          const project = await getProject(runtime.sessionID)
          if (!project) return
          await this.ops
            .promptMain(
              runtime.sessionID,
              `[Teamwork stall reminder] ${project.slug} ${trackID} (${role}) has produced no report for ${thresholdSeconds}s: ${title}. The team is still alive; no action needed unless this persists.`,
            )
            .catch(() => undefined)
        } catch {
          // Reminder is best-effort.
        }
      })()
    }, thresholdSeconds * 1000)
    // Do not keep the process alive for reminders alone.
    const maybeUnref = (timer as unknown as { unref?: () => void }).unref
    if (typeof maybeUnref === "function") maybeUnref.call(timer)
    runtime.stallTimers.set(key, timer)
  }

  private async queueCounts(sessionID: string): Promise<{ running: number; queued: number }> {
    try {
      const project = await getProject(sessionID)
      if (!project) return { running: 0, queued: 0 }
      let running = 0
      let queued = 0
      for (const milestone of project.milestones) {
        for (const track of milestone.tracks) {
          if (track.status === "running") running += 1
          if (track.status === "queued") queued += 1
        }
      }
      return { running, queued }
    } catch {
      return { running: 0, queued: 0 }
    }
  }

  private async broadcastTrackReport(
    runtime: ProjectRuntime,
    milestoneIndex: number,
    trackID: string,
    report: ReportPayload,
  ) {
    try {
      const project = await getProject(runtime.sessionID)
      if (!project) return
      const milestone = project.milestones[milestoneIndex]
      const track = milestone?.tracks.find((candidate) => candidate.id === trackID)
      await refreshPlanAndProgress(runtime.directory, project).catch(() => undefined)
      const counts = await this.queueCounts(runtime.sessionID)
      const summary = trackSummaryPrompt({
        projectSlug: project.slug,
        trackID,
        role: report.role,
        title: track?.title ?? trackID,
        verdict: report.verdict,
        findings: report.findings,
        evidence: report.evidence,
        running: counts.running,
        queued: counts.queued,
      })
      await this.ops.promptMain(runtime.sessionID, summary).catch(() => undefined)
      await this.ops.sendSynthetic(runtime.sessionID, summary).catch(() => undefined)
      await setSentinelUpdate(
        runtime.sessionID,
        `${trackID} (${report.role}) reported ${report.verdict}; running ${counts.running}, queued ${counts.queued}.`,
      ).catch(() => null)
    } catch {
      // Broadcast is best-effort and must never fail the track.
    }
  }

  private async runProject(runtime: ProjectRuntime) {
    const { sessionID } = runtime
    let project = await getProject(sessionID)
    if (!project) throw new Error("project not found")
    this.assertActive(runtime, project)

    // Write the brief + request artifacts (from the approved brief) and persist
    // the artifact pointers so sessions and the TUI can reference the files.
    const artifacts = await writeArtifacts(runtime.directory, project)
    await setProjectArtifacts(sessionID, artifacts)

    // Resume awareness: milestones already planned mean the orchestrator has
    // finished its job; continue from the first milestone that is not passed.
    const firstUnfinished = project.milestones.findIndex((milestone) => milestone.status !== "passed")
    if (project.milestones.length === 0) {
      await setSentinelUpdate(sessionID, `Project "${project.slug}" approved; the team is starting.`)
      await this.runOrchestratorPlan(runtime, project, artifacts)
      project = await getProject(sessionID)
      if (!project) throw new Error("project not found")
    }

    // Persisted milestones come from state; iterate in order.
    const startIndex = firstUnfinished >= 0 ? firstUnfinished : 0
    const total = project.milestones.length
    for (let index = startIndex; index < total; index += 1) {
      await this.runMilestone(runtime, index)
      project = await getProject(sessionID)
      if (!project) throw new Error("project not found")
      this.assertActive(runtime, project)
      await refreshPlanAndProgress(runtime.directory, project)
    }

    // Final gate: a fresh Success Auditor session.
    await this.runSuccessAudit(runtime)
  }

  private async runOrchestratorPlan(
    runtime: ProjectRuntime,
    project: Project,
    artifacts: { brief: string; request: string; plan: string; progress: string },
  ) {
    const { sessionID } = runtime
    const { sessionID: orchestratorSession, agentApplied } = await this.spawnRoleSession(runtime, "orchestrator", project)
    await recordAdhocSession(sessionID, "orchestrator", orchestratorSession)
    runtime.roleAgentApplied.set(orchestratorSession, agentApplied)

    const planWaiter = createDeferred<PlanMilestoneInput[]>()
    runtime.planWaiter = planWaiter
    runtime.planWaiterOwner = orchestratorSession

    try {
      const taskText = roleTaskPrompt({
        role: "orchestrator",
        projectSlug: project.slug,
        workingDirectory: project.workingDirectory ?? runtime.directory,
        integrityMode: project.brief.integrityMode,
        executionPath: project.brief.executionPath,
        workers: project.maxParallelWorkers,
        teamScale: project.brief.teamScale,
        deep: project.brief.deep,
        artifactPaths: artifacts,
        taskTitle: "Produce the milestone plan",
        taskDetail:
          "Read the brief artifact, then break the approved brief into structured milestones. " +
          "For each milestone: give a short title, a description of the outcome, and the work tracks. " +
          trackRolesForPath(project.brief.executionPath) +
          " The final milestone must make the project's acceptance criteria verifiable end to end. " +
          "Every builder milestone must include its path's verification gate tracks. " +
          "Assign each builder track an exclusive file list so tracks never edit the same file. " +
          "Submit the plan through the teamwork_submit_plan tool.",
        assignedFiles: [],
        contextPacket: null,
        acceptanceCriteria: [project.brief.acceptanceCriteria],
        scratchDirectory: null,
        attemptContext: null,
      })
      await this.ops.promptSession(orchestratorSession, withRoleIdentity("orchestrator", agentApplied, taskText))
      const plan = await planWaiter.promise
      this.validateRawPlanOrThrow(project, plan)
      const persisted = await setMilestonePlan(sessionID, plan)
      await refreshPlanAndProgress(runtime.directory, persisted)
      await this.ops.sendSynthetic(
        sessionID,
        `[Teamwork Sentinel] Plan ready for "${persisted.slug}": ${persisted.milestones.length} milestones.`,
      )
    } finally {
      runtime.planWaiter = null
      runtime.planWaiterOwner = null
      runtime.activeRoleSessions.delete(orchestratorSession)
    }
  }

  /** Enforces path rules + exclusive ownership before the plan is persisted. */
  private validateRawPlanOrThrow(project: Project, plan: PlanMilestoneInput[]) {
    const path = project.brief.executionPath
    project.milestones = plan.map((milestone, milestoneIndex) => ({
      id: `m${milestoneIndex + 1}`,
      title: milestone.title,
      description: milestone.description,
      status: "pending" as const,
      verificationAttempts: 0,
      tracks: (milestone.tracks ?? []).map((track, trackIndex) => ({
        id: `m${milestoneIndex + 1}t${trackIndex + 1}`,
        title: track.title,
        role: track.role,
        assignedFiles: track.assignedFiles,
        status: "queued" as const,
        sessionID: null,
        attempt: 0,
        lastReport: null,
      })),
    }))
    this.validatePlanOrThrow(project)
  }

  /** Enforces path rules + exclusive ownership on the orchestrator's plan. */
  private validatePlanOrThrow(project: Project) {
    const path = project.brief.executionPath
    for (const milestone of project.milestones) {
      const builders = milestone.tracks.filter((track) => builderRolesFor(path).includes(track.role))
      if (path === "iterative" && builders.length > 1) {
        throw new Error(
          `Milestone ${milestone.id} violates the Iterative path: it never decomposes into parallel tracks ` +
            `(${builders.length} builder tracks).`,
        )
      }
      const conflicts = findOwnershipConflicts(
        milestone.tracks
          .filter((track) => builderRolesFor(path).includes(track.role))
          .map((track) => ({ title: track.title, assignedFiles: track.assignedFiles })),
      )
      if (conflicts.length > 0) {
        throw new Error(`Milestone ${milestone.id} violates exclusive file ownership: ${conflicts.join("; ")}`)
      }
    }
  }

  private async runMilestone(runtime: ProjectRuntime, milestoneIndex: number) {
    const { sessionID } = runtime
    const project = (await getProject(sessionID))!
    const milestone = project.milestones[milestoneIndex]!
    if (!milestone) throw new Error(`milestone ${milestoneIndex} not found`)
    const path = project.brief.executionPath

    await setMilestoneStatus(sessionID, milestoneIndex, "inProgress")
    await setSentinelUpdate(sessionID, `Milestone ${milestone.id} started: ${milestone.title}`)

    const explorers = milestone.tracks.filter((track) => track.role === "explorer")
    const builders = milestone.tracks.filter((track) => builderRolesFor(path).includes(track.role))

    if (explorers.length > 0) {
      await this.runTracksParallel(runtime, milestoneIndex, explorers)
      this.assertActive(runtime, (await getProject(sessionID))!)
    }
    if (builders.length > 0) {
      if (path === "review") {
        // Reviewers first (parallel angles), then the synthesizer adjudicates.
        const reviewers = builders.filter((track) => track.role === "reviewer")
        const synthesizers = builders.filter((track) => track.role === "synthesizer")
        if (reviewers.length > 0) {
          await this.runTracksParallel(runtime, milestoneIndex, reviewers)
          this.assertActive(runtime, (await getProject(sessionID))!)
        }
        if (synthesizers.length > 0) {
          await this.runTracksParallel(runtime, milestoneIndex, synthesizers)
          this.assertActive(runtime, (await getProject(sessionID))!)
        }
      } else {
        await this.runTracksParallel(runtime, milestoneIndex, builders)
        this.assertActive(runtime, (await getProject(sessionID))!)
      }
    }

    // Research-only milestones (no builder tracks) produce no candidate changes,
    // so there is nothing to verify adversarially; they pass once their
    // exploration reports land.
    if (builders.length === 0) {
      await this.finishMilestone(runtime, milestoneIndex, milestone)
      return
    }

    // Adversarial verification gates per path. A failed gate sends the work
    // back to the builders with the failing verdict as context, then re-runs
    // the failed gate. There is no fixed retry ceiling: the loop ends on pass
    // or on user pause/cancel.
    for (;;) {
      this.assertActive(runtime, (await getProject(sessionID))!)
      const gateResult = await this.runVerificationGates(runtime, milestoneIndex)
      if (gateResult === "passed") break
      await this.sendBuildersBackToWork(runtime, milestoneIndex)
    }

    await this.finishMilestone(runtime, milestoneIndex, milestone)
  }

  private async finishMilestone(runtime: ProjectRuntime, milestoneIndex: number, milestone: Milestone) {
    const { sessionID } = runtime
    await setMilestoneStatus(sessionID, milestoneIndex, "passed")
    const passed = (await getProject(sessionID))!
    await refreshPlanAndProgress(runtime.directory, passed)
    await this.ops.sendSynthetic(
      sessionID,
      `[Teamwork Sentinel] Milestone ${milestone.id} passed: ${milestone.title} (${Math.min(milestoneIndex + 2, passed.milestones.length)}/${passed.milestones.length}).`,
    )
  }

  private async runVerificationGates(runtime: ProjectRuntime, milestoneIndex: number): Promise<"passed" | "failed"> {
    const { sessionID } = runtime
    await recordVerificationAttempt(sessionID, milestoneIndex)
    const project = (await getProject(sessionID))!
    const milestone = project.milestones[milestoneIndex]!
    const path = project.brief.executionPath
    const deep = project.brief.deep

    const byRole = (role: TeamRole) => milestone.tracks.filter((track) => track.role === role)

    switch (path) {
      case "general": {
        // explorer -> workers -> critic -> challenger (skip when deep=off) -> auditor
        const critics = byRole("critic")
        const challengers = deep ? byRole("challenger") : []
        const auditors = byRole("auditor")
        if (critics.length === 0 || auditors.length === 0) {
          return await this.failGateForMissingTracks(runtime, milestone, "critic/auditor")
        }
        await this.runTracksParallel(runtime, milestoneIndex, critics)
        if (!this.gatesPassed((await getProject(runtime.sessionID))!.milestones[milestoneIndex]!, critics)) return "failed"
        if (challengers.length > 0) {
          await this.runTracksParallel(runtime, milestoneIndex, challengers)
          if (!this.gatesPassed((await getProject(runtime.sessionID))!.milestones[milestoneIndex]!, challengers)) {
            return "failed"
          }
        }
        await this.runTracksParallel(runtime, milestoneIndex, auditors)
        return this.gatesPassed((await getProject(runtime.sessionID))!.milestones[milestoneIndex]!, auditors)
          ? "passed"
          : "failed"
      }
      case "iterative": {
        // single worker -> critic -> auditor; challenger only when deep=on and explicitly planned.
        const critics = byRole("critic")
        const challengers = deep ? byRole("challenger") : []
        const auditors = byRole("auditor")
        if (critics.length === 0 || auditors.length === 0) {
          return await this.failGateForMissingTracks(runtime, milestone, "critic/auditor")
        }
        await this.runTracksParallel(runtime, milestoneIndex, critics)
        if (!this.gatesPassed((await getProject(runtime.sessionID))!.milestones[milestoneIndex]!, critics)) return "failed"
        if (challengers.length > 0) {
          await this.runTracksParallel(runtime, milestoneIndex, challengers)
          if (!this.gatesPassed((await getProject(runtime.sessionID))!.milestones[milestoneIndex]!, challengers)) {
            return "failed"
          }
        }
        await this.runTracksParallel(runtime, milestoneIndex, auditors)
        return this.gatesPassed((await getProject(runtime.sessionID))!.milestones[milestoneIndex]!, auditors)
          ? "passed"
          : "failed"
      }
      case "review": {
        // reviewers -> synthesizer (build phase) -> critic -> auditor. No source edits.
        const critics = byRole("critic")
        const auditors = byRole("auditor")
        if (critics.length === 0 || auditors.length === 0) {
          return await this.failGateForMissingTracks(runtime, milestone, "critic/auditor")
        }
        await this.runTracksParallel(runtime, milestoneIndex, critics)
        if (!this.gatesPassed((await getProject(runtime.sessionID))!.milestones[milestoneIndex]!, critics)) return "failed"
        await this.runTracksParallel(runtime, milestoneIndex, auditors)
        return this.gatesPassed((await getProject(runtime.sessionID))!.milestones[milestoneIndex]!, auditors)
          ? "passed"
          : "failed"
      }
      case "math":
      case "math-large": {
        // prover candidates -> falsifier (skip when deep=off; large team always pairs) -> verifier.
        const falsifiers = path === "math-large" || deep ? byRole("falsifier") : []
        const verifiers = byRole("verifier")
        if (verifiers.length === 0) {
          return await this.failGateForMissingTracks(runtime, milestone, "verifier")
        }
        if (falsifiers.length > 0) {
          await this.runTracksParallel(runtime, milestoneIndex, falsifiers)
          if (!this.gatesPassed((await getProject(runtime.sessionID))!.milestones[milestoneIndex]!, falsifiers)) {
            return "failed"
          }
        }
        await this.runTracksParallel(runtime, milestoneIndex, verifiers)
        return this.gatesPassed((await getProject(runtime.sessionID))!.milestones[milestoneIndex]!, verifiers)
          ? "passed"
          : "failed"
      }
    }
  }

  /** A gate passes only when every gate track has a "pass" verdict. */
  private gatesPassed(milestone: Milestone, tracks: Track[]) {
    const ids = new Set(tracks.map((track) => track.id))
    const current = milestone.tracks.filter((track) => ids.has(track.id))
    if (current.length === 0) return false
    return current.every((track) => track.lastReport?.verdict === "pass")
  }

  private async failGateForMissingTracks(
    runtime: ProjectRuntime,
    milestone: Milestone,
    expected: string,
  ): Promise<"failed"> {
    // A plan without its path's gate tracks can never pass; pausing (rather
    // than looping forever) hands the broken plan back to the user.
    const project = (await getProject(runtime.sessionID))!
    await pauseProject(
      runtime.sessionID,
      `Milestone ${milestone.id} has no verification tracks (${expected}); the plan must include them.`,
      { stopReason: "plan invalid", blocker: `Milestone ${milestone.id} is missing ${expected} tracks.` },
    )
    await this.ops.promptMain(
      runtime.sessionID,
      sentinelDecisionPrompt({
        projectSlug: project.slug,
        message: `Milestone ${milestone.id} is missing its ${expected} verification tracks. The project is paused; fix the milestone plan and resume.`,
      }),
    )
    throw new AbortedError()
  }

  private async sendBuildersBackToWork(runtime: ProjectRuntime, milestoneIndex: number) {
    const project = (await getProject(runtime.sessionID))!
    const milestone = project.milestones[milestoneIndex]!
    const path = project.brief.executionPath
    const builders = milestone.tracks.filter(
      (track) => builderRolesFor(path).includes(track.role) && track.sessionID,
    )
    await Promise.all(
      builders.map(async (track) => {
        const feedback = track.lastReport
          ? [
              `Prior attempt verdict: ${track.lastReport.verdict}.`,
              ...track.lastReport.findings.slice(0, 8).map((finding) => `- ${finding}`),
              ...track.lastReport.blockers.slice(0, 4).map((blocker) => `- blocker: ${blocker}`),
            ].join("\n")
          : "Prior attempt had no report."
        const gateFindings = milestone.tracks
          .filter((candidate) => candidate.lastReport?.verdict === "fail")
          .flatMap((candidate) => candidate.lastReport!.findings.slice(0, 4))
        runtime.reportWaiters.delete(track.sessionID!)
        await this.ops.promptSession(
          track.sessionID!,
          this.taskPromptFor(project, runtime, milestoneIndex, track.title, track, gateFindings.join("\n") || feedback),
        )
        const report = await this.awaitReport(runtime, track.sessionID!, track.id, track.role, track.title)
        await submitTrackReport(track.sessionID!, report)
        await this.broadcastTrackReport(runtime, milestoneIndex, track.id, report)
      }),
    )
  }

  /** Runs the given tracks with bounded parallelism; waits for all reports. */
  private async runTracksParallel(runtime: ProjectRuntime, milestoneIndex: number, tracks: Track[]) {
    const project = (await getProject(runtime.sessionID))!
    // The Iterative path never parallelizes.
    const limit =
      project.brief.executionPath === "iterative" ? 1 : Math.min(8, Math.max(1, project.maxParallelWorkers))
    const queue = [...tracks]
    const workers: Array<Promise<void>> = []
    for (let slot = 0; slot < Math.min(limit, queue.length); slot += 1) {
      workers.push(
        (async () => {
          for (;;) {
            const track = queue.shift()
            if (!track) return
            await this.runTrack(runtime, milestoneIndex, track)
            this.assertActive(runtime, (await getProject(runtime.sessionID))!)
          }
        })(),
      )
    }
    await Promise.all(workers)
  }

  private taskPromptFor(
    project: Project,
    runtime: ProjectRuntime,
    milestoneIndex: number,
    title: string,
    track: Track,
    attemptContext: string | null,
  ): string {
    const milestone = project.milestones[milestoneIndex]!
    return roleTaskPrompt({
      role: track.role,
      projectSlug: project.slug,
      workingDirectory: project.workingDirectory ?? runtime.directory,
      integrityMode: project.brief.integrityMode,
      executionPath: project.brief.executionPath,
      workers: project.maxParallelWorkers,
      teamScale: project.brief.teamScale,
      deep: project.brief.deep,
      artifactPaths: project.artifacts,
      taskTitle: title,
      taskDetail: milestone.description,
      assignedFiles: track.assignedFiles,
      contextPacket: this.contextPacketFor(project, milestoneIndex),
      acceptanceCriteria: [project.brief.acceptanceCriteria],
      scratchDirectory: isEditingRole(track.role)
        ? join(artifactDirPath(project.workingDirectory ?? runtime.directory), "scratch", track.id)
        : null,
      attemptContext,
    })
  }

  /** Builds the Context Packet from the milestone's explorer reports. */
  private contextPacketFor(project: Project, milestoneIndex: number): string | null {
    const milestone = project.milestones[milestoneIndex]
    if (!milestone) return null
    const explorers = milestone.tracks.filter(
      (track) => track.role === "explorer" && track.lastReport?.verdict === "pass",
    )
    if (explorers.length === 0) return null
    const lines: string[] = []
    for (const track of explorers) {
      const report = track.lastReport!
      lines.push(`Explorer ${track.id} (${track.title}):`)
      for (const finding of report.findings.slice(0, 10)) lines.push(`- ${finding}`)
      for (const evidence of report.evidence.slice(0, 6)) lines.push(`- evidence: ${evidence}`)
    }
    return lines.join("\n")
  }

  private async runTrack(runtime: ProjectRuntime, milestoneIndex: number, track: Track) {
    const project = (await getProject(runtime.sessionID))!
    const { sessionID: roleSessionID, agentApplied } = await this.spawnRoleSession(runtime, track.role, project)
    await assignTrackSession(runtime.sessionID, milestoneIndex, track.id, roleSessionID)
    runtime.roleAgentApplied.set(roleSessionID, agentApplied)
    this.scheduleStallReminder(
      runtime,
      roleSessionID,
      track.id,
      track.role,
      track.title,
      project.trackStallReminderSeconds,
    )
    try {
      await this.ops.promptSession(
        roleSessionID,
        withRoleIdentity(track.role, agentApplied, this.taskPromptFor(project, runtime, milestoneIndex, track.title, track, null)),
      )
      const report = await this.awaitReport(runtime, roleSessionID, track.id, track.role, track.title)
      await submitTrackReport(roleSessionID, report)
      await this.broadcastTrackReport(runtime, milestoneIndex, track.id, report)
    } finally {
      this.clearStallTimer(runtime, roleSessionID)
      runtime.activeRoleSessions.delete(roleSessionID)
      runtime.reportWaiters.delete(roleSessionID)
    }
  }

  private async runSuccessAudit(runtime: ProjectRuntime) {
    const project = (await getProject(runtime.sessionID))!
    const { sessionID: successSession, agentApplied } = await this.spawnRoleSession(runtime, "successAuditor", project)
    await recordAdhocSession(runtime.sessionID, "successAuditor", successSession)
    this.scheduleStallReminder(
      runtime,
      successSession,
      "success-audit",
      "successAuditor",
      "End-to-end success audit",
      project.trackStallReminderSeconds,
    )
    try {
      const taskText = roleTaskPrompt({
        role: "successAuditor",
        projectSlug: project.slug,
        workingDirectory: project.workingDirectory ?? runtime.directory,
        integrityMode: project.brief.integrityMode,
        executionPath: project.brief.executionPath,
        workers: project.maxParallelWorkers,
        teamScale: project.brief.teamScale,
        deep: project.brief.deep,
        artifactPaths: project.artifacts,
        taskTitle: "End-to-end success audit",
        taskDetail:
          "All milestones passed their gates. Run a targeted end-to-end verification pass over the Context " +
          "Packet paths against the brief's acceptance criteria. Partial passes are failures.",
        assignedFiles: [],
        contextPacket: this.contextPacketFor(project, project.milestones.length - 1),
        acceptanceCriteria: [project.brief.acceptanceCriteria],
        scratchDirectory: null,
        attemptContext: null,
      })
      await this.ops.promptSession(successSession, withRoleIdentity("successAuditor", agentApplied, taskText))
      const report = await this.awaitReport(runtime, successSession, "success-audit", "successAuditor", "audit")
      await this.finishSuccessAuditWithReport(runtime, project, report)
    } finally {
      this.clearStallTimer(runtime, successSession)
      runtime.activeRoleSessions.delete(successSession)
      runtime.reportWaiters.delete(successSession)
    }
  }

  private async finishSuccessAuditWithReport(runtime: ProjectRuntime, project: Project, report: ReportPayload) {
    if (report.verdict !== "pass") {
      const blockers = report.blockers.length > 0 ? report.blockers : report.findings
      await pauseProject(
        runtime.sessionID,
        `The Success Auditor rejected the project: ${blockers.slice(0, 3).join("; ")}`,
        { stopReason: "success audit failed", blocker: blockers.join("; "), historyType: "verification" },
      )
      await this.ops.promptMain(
        runtime.sessionID,
        sentinelDecisionPrompt({
          projectSlug: project.slug,
          message: "The Success Auditor rejected the completed project. The project is paused for review.",
          details: blockers.slice(0, 6),
        }),
      )
      throw new AbortedError()
    }
    const evidence = [...report.evidence.slice(0, 10), ...report.findings.slice(0, 10)].join("; ")
    await completeProject(runtime.sessionID, evidence || "The Success Auditor passed the end-to-end verification.")
    // The project is done: remove the role sessions so the user's session
    // list does not accumulate teamwork leftovers.
    await this.cleanupRoleSessions(runtime)
    await setSentinelUpdate(runtime.sessionID, `Project "${project.slug}" completed and verified end to end.`)
    await refreshPlanAndProgress(runtime.directory, (await getProject(runtime.sessionID))!)
    await this.ops.sendSynthetic(
      runtime.sessionID,
      `[Teamwork Sentinel] Project "${project.slug}" is complete: all milestones passed and the Success Auditor verified it end to end.`,
    )
  }

  // -------------------------------------------------------------------------

  private async spawnRoleSession(
    runtime: ProjectRuntime,
    role: TeamRole | RoleAgentName,
    project: Project,
  ): Promise<{ sessionID: string; agentApplied: boolean }> {
    const result = await this.ops.createSession({
      agent: agentNameForRole(role as RoleAgentName),
      title: `${TEAMWORK_TITLE_PREFIX} ${project.slug} — ${role}`,
    })
    runtime.activeRoleSessions.add(result.sessionID)
    this.roleOwners.set(result.sessionID, runtime.sessionID)
    return result
  }

  /**
   * Collects every role session belonging to this project: milestone tracks
   * (via state) plus the engine's runtime cache. Returns unique IDs.
   */
  private async roleSessionIDsFor(runtime: ProjectRuntime): Promise<string[]> {
    const sessionIDs = new Set<string>()
    for (const [roleSessionID, owner] of this.roleOwners) {
      if (owner === runtime.sessionID) sessionIDs.add(roleSessionID)
    }
    for (const sessionID of runtime.activeRoleSessions) {
      sessionIDs.add(sessionID)
    }
    try {
      const project = await getProject(runtime.sessionID)
      if (project) {
        for (const milestone of project.milestones) {
          for (const track of milestone.tracks) {
            if (track.sessionID) sessionIDs.add(track.sessionID)
          }
        }
      }
    } catch {
      // Cleanup is best-effort; state problems must not block unwinding.
    }
    return [...sessionIDs]
  }

  /**
   * Removes every role session of the project, best-effort. Called when the
   * project completes or is cancelled; paused projects keep their sessions so
   * users can resume with full context.
   */
  private async cleanupRoleSessions(runtime: ProjectRuntime) {
    const sessionIDs = await this.roleSessionIDsFor(runtime)
    if (sessionIDs.length === 0) return
    let slug = "project"
    try {
      const project = await getProject(runtime.sessionID)
      if (project) slug = project.slug
    } catch {
      // Cleanup is best-effort; state problems must not block unwinding.
    }
    for (const roleSessionID of sessionIDs) {
      const removed = await this.ops.removeSession(roleSessionID).catch(() => false)
      if (!removed) {
        // Host does not expose removal: mark the title so lingering sessions
        // stay recognizable as finished teamwork sessions.
        await this.ops
          .renameSession(roleSessionID, `${TEAMWORK_DONE_PREFIX} ${slug}`)
          .catch(() => undefined)
      }
      this.roleOwners.delete(roleSessionID)
      runtime.activeRoleSessions.delete(roleSessionID)
    }
  }

  private async awaitReport(
    runtime: ProjectRuntime,
    roleSessionID: string,
    _trackID?: string,
    _role?: string,
    _title?: string,
  ) {
    const waiter = createDeferred<ReportPayload>()
    runtime.reportWaiters.set(roleSessionID, waiter)
    const sessionEnded = this.ops.waitForSession(roleSessionID).then(() => {
      waiter.reject(new Error("the role session ended without submitting teamwork_report"))
    })
    try {
      return await waiter.promise
    } catch (error) {
      if (runtime.aborted) throw new AbortedError()
      // No report: fail the track honestly and abort the run.
      const reason = error instanceof Error ? error.message : String(error ?? "no report")
      await failTrackSession(roleSessionID, reason)
      throw error
    } finally {
      void sessionEnded.catch(() => undefined)
      runtime.reportWaiters.delete(roleSessionID)
    }
  }
}

function trackRolesForPath(path: ExecutionPath): string {
  switch (path) {
    case "general":
      return (
        "Track roles for the General path must be: explorer (research), worker (implementation, parallel), " +
        "critic and challenger (verification gates), auditor (evidence audit)."
      )
    case "iterative":
      return (
        "Track roles for the Iterative path must be: explorer (quick, may be omitted when obvious), a single " +
        "worker (never parallelize), critic and auditor (verification gates)."
      )
    case "review":
      return (
        "Track roles for the Document Review path must be: reviewer (parallel angles), synthesizer " +
        "(adjudicated review), critic and auditor (verification gates). No workers, no source edits."
      )
    case "math":
      return (
        "Track roles for the Math path must be: prover candidates, falsifier, verifier (single tournament round). " +
        "Failed drafts stay attached with objections."
      )
    case "math-large":
      return (
        "Track roles for the Math Large Team path must be: parallel prover candidates each paired with a " +
        "falsifier, verifier synthesis per subproblem node. Maintain .teamwork/knowledge/."
      )
  }
}
