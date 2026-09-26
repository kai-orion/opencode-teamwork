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
  submitTrackReportByID,
  suspendTimerForPermission,
} from "./state"
import type { ExecutorMode, Milestone, Project, TeamRole, Track } from "./state"
import {
  agentNameForRole,
  nativeBatchPrompt,
  permissionApprovalPrompt,
  roleTaskPrompt,
  sentinelDecisionPrompt,
  trackSummaryPrompt,
  ROLE_AGENT_SYSTEM_PROMPTS,
} from "./prompts"
import type { RoleAgentName } from "./prompts"
import { refreshPlanAndProgress, writeArtifacts } from "./artifacts"
import { setProjectArtifacts } from "./state"
import type { TeamworkLocale } from "./i18n"

/**
 * The Teamwork state machine ("Sentinel"). The engine drives role sessions
 * through a deterministic sequence — orchestrator plan, then per-milestone
 * explore / implement / verify gates, then a fresh Success Auditor — enforcing
 * the verification gates that pure prompting cannot.
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
  locale: TeamworkLocale
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
  locale: TeamworkLocale
  aborted: boolean
  activeRoleSessions: Set<string>
  reportWaiters: Map<string, Deferred<ReportPayload>>
  planWaiter: Deferred<PlanMilestoneInput[]> | null
  planWaiterOwner: string | null
  successWaiter: Deferred<ReportPayload> | null
  nativeBatch: {
    expected: Array<{ milestoneIndex: number; trackID: string; role: TeamRole }>
    received: number
    resolve: () => void
    reject: (error: unknown) => void
  } | null
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
  startExecution(sessionID: string, locale: TeamworkLocale = this.options.locale) {
    if (this.runtimes.has(sessionID)) return
    const runtime: ProjectRuntime = {
      sessionID,
      directory: this.options.directory,
      locale,
      aborted: false,
      activeRoleSessions: new Set(),
      reportWaiters: new Map(),
      planWaiter: null,
      planWaiterOwner: null,
      successWaiter: null,
      nativeBatch: null,
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
        for (const key of [...this.nativeDoneKeys]) {
          if (key.startsWith(`${sessionID}:`)) this.nativeDoneKeys.delete(key)
        }
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
      // Native success audit reports through the main session.
      if (runtime.successWaiter && roleSessionID === runtime.sessionID && report.role === "successAuditor") {
        runtime.successWaiter.resolve(report)
        return
      }
      // Native batches report through the main session: match by role in order.
      if (runtime.nativeBatch && roleSessionID === runtime.sessionID) {
        const batch = runtime.nativeBatch
        if (batch.expected.length === 1 && batch.expected[0]!.milestoneIndex === -1) {
          // Success-audit bridge is handled via successWaiter; ignore here.
        } else {
          const next = batch.expected.find(
            (entry) => entry.role === report.role && !this.nativeTrackDone(runtime, entry),
          )
          const target = next ?? batch.expected[batch.received]
          if (target) {
            this.markNativeTrackDone(runtime, target)
            void this.handleNativeReport(runtime, target, report)
            batch.received += 1
            if (batch.received >= batch.expected.length) {
              const resolve = batch.resolve
              runtime.nativeBatch = null
              resolve()
            }
            return
          }
        }
      }
      const waiter = runtime.reportWaiters.get(roleSessionID)
      if (waiter) waiter.resolve(report)
    }
  }

  private readonly nativeDoneKeys = new Set<string>()
  private nativeKey(runtime: ProjectRuntime, entry: { milestoneIndex: number; trackID: string }) {
    return `${runtime.sessionID}:${entry.milestoneIndex}:${entry.trackID}`
  }
  private nativeTrackDone(runtime: ProjectRuntime, entry: { milestoneIndex: number; trackID: string }) {
    return this.nativeDoneKeys.has(this.nativeKey(runtime, entry))
  }
  private markNativeTrackDone(runtime: ProjectRuntime, entry: { milestoneIndex: number; trackID: string }) {
    this.nativeDoneKeys.add(this.nativeKey(runtime, entry))
    // Bound the set: runtimes are short-lived; cleanup happens on runner finally.
  }

  private async handleNativeReport(
    runtime: ProjectRuntime,
    target: { milestoneIndex: number; trackID: string; role: TeamRole },
    report: ReportPayload,
  ) {
    try {
      await submitTrackReportByID(runtime.sessionID, target.milestoneIndex, target.trackID, report)
      this.clearStallTimer(runtime, `native:${target.milestoneIndex}:${target.trackID}`)
      await this.broadcastTrackReport(runtime, target.milestoneIndex, target.trackID, report)
    } catch {
      // Submission failures surface through the batch waiter rejection path.
    }
  }

  /** Resolves the pending plan waiter for a role session (tool hook). */
  onPlan(roleSessionID: string, plan: PlanMilestoneInput[]) {
    // Native orchestrator plans report through the main session.
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
              permissionApprovalPrompt({
                locale: runtime.locale,
                projectSlug: project.slug,
                trackID,
                role,
                detail,
              }),
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
          if (!track.sessionID || track.sessionID.startsWith("native-")) continue
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
    if (runtime.successWaiter) {
      runtime.successWaiter.reject(new AbortedError())
      runtime.successWaiter = null
    }
    if (runtime.nativeBatch) {
      runtime.nativeBatch.reject(new AbortedError())
      runtime.nativeBatch = null
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
          locale: runtime.locale,
          projectSlug: project?.slug ?? runtime.sessionID,
          message: `The team stopped unexpectedly: ${detail}. The project is paused; resume it with /teamwork-resume after checking the environment.`,
        }),
      )
    } catch {
      // Nothing more can be done if even the failure path fails.
    }
  }

  // -------------------------------------------------------------------------

  private executorOf(project: Project): ExecutorMode {
    const value = (project as { executor?: unknown }).executor
    return value === "isolated" ? "isolated" : "native"
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
        locale: runtime.locale,
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

    // Write the request artifact (from the approved brief) and persist the
    // artifact pointers so sessions and the TUI can reference the files.
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
    artifacts: { request: string; plan: string; progress: string },
  ) {
    const { sessionID } = runtime
    if (this.executorOf(project) === "native") {
      const syntheticID = `native-${sessionID.slice(0, 8)}-orchestrator`
      await recordAdhocSession(sessionID, "orchestrator", syntheticID)
      const planWaiter = createDeferred<PlanMilestoneInput[]>()
      runtime.planWaiter = planWaiter
      runtime.planWaiterOwner = sessionID
      try {
        const taskText = roleTaskPrompt({
          role: "orchestrator",
          projectSlug: project.slug,
          workingDirectory: project.workingDirectory ?? runtime.directory,
          artifactPaths: artifacts,
          integrityMode: project.brief.integrityMode,
          taskTitle: "Produce the milestone plan (native: fan out with subagents if it helps)",
          taskDetail:
            "Read the request artifact, then break the approved brief into structured milestones. " +
            "For each milestone: give a short title, a description of the outcome, and the work tracks. " +
            "Track roles must be one of: explorer, worker, critic, challenger, auditor. " +
            "The final milestone must make the project's acceptance criteria verifiable end to end. " +
            "Every milestone must include at least one critic track and one auditor track as its verification " +
            "gates. Assign each worker track an exclusive file list so tracks never edit the same file. " +
            "Isolation is prompt-level in native mode; still keep file ownership exclusive. " +
            "Submit the plan through the teamwork_submit_plan tool.",
          assignedFiles: [],
          scratchDirectory: null,
          attemptContext: null,
          executorMode: "native",
        })
        await this.ops.promptMain(sessionID, taskText)
        const plan = await planWaiter.promise
        const persisted = await setMilestonePlan(sessionID, plan)
        await refreshPlanAndProgress(runtime.directory, persisted)
        await this.ops.sendSynthetic(
          sessionID,
          `[Teamwork Sentinel] Plan ready for "${persisted.slug}": ${persisted.milestones.length} milestones.`,
        )
      } finally {
        runtime.planWaiter = null
        runtime.planWaiterOwner = null
      }
      return
    }
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
        artifactPaths: artifacts,
        integrityMode: project.brief.integrityMode,
        taskTitle: "Produce the milestone plan",
        taskDetail:
          "Read the request artifact, then break the approved brief into structured milestones. " +
          "For each milestone: give a short title, a description of the outcome, and the work tracks. " +
          "Track roles must be one of: explorer, worker, critic, challenger, auditor. " +
          "The final milestone must make the project's acceptance criteria verifiable end to end. " +
          "Every milestone must include at least one critic track and one auditor track as its verification " +
          "gates. Assign each worker track an exclusive file list so tracks never edit the same file. " +
          "Submit the plan through the teamwork_submit_plan tool.",
        assignedFiles: [],
        scratchDirectory: null,
        attemptContext: null,
        executorMode: "isolated",
      })
      await this.ops.promptSession(orchestratorSession, withRoleIdentity("orchestrator", agentApplied, taskText))
      const plan = await planWaiter.promise
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

  private async runMilestone(runtime: ProjectRuntime, milestoneIndex: number) {
    const { sessionID } = runtime
    const project = (await getProject(sessionID))!
    const milestone = project.milestones[milestoneIndex]!
    if (!milestone) throw new Error(`milestone ${milestoneIndex} not found`)

    await setMilestoneStatus(sessionID, milestoneIndex, "inProgress")
    await setSentinelUpdate(sessionID, `Milestone ${milestone.id} started: ${milestone.title}`)

    const research = milestone.tracks.filter((track) => track.role === "explorer")
    const implementation = milestone.tracks.filter((track) => track.role === "worker")

    if (research.length > 0) {
      await this.runTracksParallel(runtime, milestoneIndex, research)
      this.assertActive(runtime, (await getProject(sessionID))!)
    }
    if (implementation.length > 0) {
      await this.runTracksParallel(runtime, milestoneIndex, implementation)
      this.assertActive(runtime, (await getProject(sessionID))!)
    }

    // Research-only milestones (no worker tracks) produce no candidate changes,
    // so there is nothing to verify adversarially; they pass once their
    // exploration reports land. Implementation milestones go through the gates.
    if (implementation.length === 0) {
      await this.finishMilestone(runtime, milestoneIndex, milestone)
      return
    }

    // Adversarial verification gates: Critic and Challenger in parallel, then
    // the Auditor. A failed gate sends the work back to the workers, reusing
    // their sessions within this milestone (context continuity), until the
    // retry ceiling is reached and the project pauses for the user.
    for (;;) {
      this.assertActive(runtime, (await getProject(sessionID))!)
      const gateResult = await this.runVerificationGates(runtime, milestoneIndex)
      if (gateResult === "passed") break
      const current = (await getProject(sessionID))!
      const milestoneNow = current.milestones[milestoneIndex]!
      const attempts = milestoneNow.verificationAttempts
      const maxAttempts = current.maxVerificationRetries + 1
      if (attempts >= maxAttempts) {
        const blockers = milestoneNow.tracks
          .map((track) => track.lastReport?.blockers ?? [])
          .flat()
          .slice(0, 6)
        await pauseProject(
          sessionID,
          `Milestone ${milestoneNow.id} failed verification ${attempts} time(s): ${milestoneNow.title}`,
          {
            stopReason: "verification failed",
            blocker: blockers.length > 0 ? blockers.join("; ") : `Milestone ${milestoneNow.id} failed verification.`,
            historyType: "verification",
          },
        )
        const paused = (await getProject(sessionID))!
        await this.ops.promptMain(
          sessionID,
          sentinelDecisionPrompt({
            locale: runtime.locale,
            projectSlug: paused.slug,
            message: `Milestone ${milestoneNow.id} failed verification ${attempts} time(s) and the retry ceiling was reached. The project is paused.`,
            details: blockers.length > 0 ? blockers : [`Milestone: ${milestoneNow.title}`],
          }),
        )
        throw new AbortedError()
      }
      // Send the work back to the workers of this milestone (same sessions).
      await this.sendWorkersBackToWork(runtime, milestoneIndex)
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
    const critics = milestone.tracks.filter((track) => track.role === "critic")
    const challengers = milestone.tracks.filter((track) => track.role === "challenger")
    const auditors = milestone.tracks.filter((track) => track.role === "auditor")

    // The Orchestrator plan should define verification tracks; if it did not,
    // the milestone cannot pass: treat the missing gates as a failure.
    if (critics.length === 0 || auditors.length === 0) {
      await setSentinelUpdate(
        sessionID,
        `Milestone ${milestone.id} has no verification tracks (critic/auditor); the gate fails until the plan includes them.`,
      )
      return "failed"
    }

    const gateTracks = [...critics, ...challengers]
    await this.runTracksParallel(runtime, milestoneIndex, gateTracks)
    // Re-read the project: the gate tracks' reports landed in state during
    // runTracksParallel, so the snapshot captured above is stale.
    const afterGates = (await getProject(runtime.sessionID))!
    if (!this.gatesPassed(afterGates.milestones[milestoneIndex]!, gateTracks.map((track) => track.id))) {
      return "failed"
    }

    await this.runTracksParallel(runtime, milestoneIndex, auditors)
    const afterAudit = (await getProject(runtime.sessionID))!
    if (!this.gatesPassed(afterAudit.milestones[milestoneIndex]!, auditors.map((track) => track.id))) {
      return "failed"
    }
    return "passed"
  }

  /** A gate passes only when every gate track has a "pass" verdict. */
  private gatesPassed(milestone: Milestone, trackIDs: string[]) {
    const tracks = milestone.tracks.filter((track) => trackIDs.includes(track.id))
    if (tracks.length === 0) return false
    return tracks.every((track) => track.lastReport?.verdict === "pass")
  }

  private async sendWorkersBackToWork(runtime: ProjectRuntime, milestoneIndex: number) {
    const project = (await getProject(runtime.sessionID))!
    const milestone = project.milestones[milestoneIndex]!
    const workers = milestone.tracks.filter((track) => track.role === "worker" && track.sessionID)
    if (this.executorOf(project) === "native") {
      await this.runNativeBatch(
        runtime,
        milestoneIndex,
        workers.map((track) => ({
          ...track,
          title: `Fix and complete: ${track.title}`,
        })),
        "Independent verification rejected the previous attempt for these tracks. Address every finding, re-run the relevant tests and builds, and resubmit one report per track.",
      )
      return
    }
    await Promise.all(
      workers.map(async (track) => {
        const feedback = track.lastReport
          ? [
              `Prior attempt verdict: ${track.lastReport.verdict}.`,
              ...track.lastReport.findings.slice(0, 8).map((finding) => `- ${finding}`),
              ...track.lastReport.blockers.slice(0, 4).map((blocker) => `- blocker: ${blocker}`),
            ].join("\n")
          : "Prior attempt had no report."
        runtime.reportWaiters.delete(track.sessionID!)
        await this.ops.promptSession(
          track.sessionID!,
          roleTaskPrompt({
            role: "worker",
            projectSlug: project.slug,
            workingDirectory: project.workingDirectory ?? runtime.directory,
            artifactPaths: project.artifacts,
            integrityMode: project.brief.integrityMode,
            taskTitle: `Fix and complete: ${track.title}`,
            taskDetail:
              "Independent verification rejected the previous attempt for this track. Address every finding, " +
              "re-run the relevant tests and builds yourself, and resubmit the report.",
            assignedFiles: track.assignedFiles,
            scratchDirectory: null,
            attemptContext: feedback,
            executorMode: "isolated",
          }),
        )
        const report = await this.awaitReport(runtime, track.sessionID!, track.id, "worker", track.title)
        await submitTrackReport(track.sessionID!, report)
        await this.broadcastTrackReport(runtime, milestoneIndex, track.id, report)
      }),
    )
  }

  /** Runs the given tracks with bounded parallelism; waits for all reports. */
  private async runTracksParallel(runtime: ProjectRuntime, milestoneIndex: number, tracks: Track[]) {
    const project = (await getProject(runtime.sessionID))!
    if (this.executorOf(project) === "native") {
      const milestone = project.milestones[milestoneIndex]!
      await this.runNativeBatch(runtime, milestoneIndex, tracks, milestone.description)
      return
    }
    const limit = Math.min(8, Math.max(1, project.maxParallelWorkers))
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

  /**
   * Native executor: one main-session batch prompt, parallel fan-out by the
   * model's own subagents, one teamwork_report per track relayed by the main
   * LLM. Reports arrive through onReport keyed by the main session ID.
   */
  private async runNativeBatch(
    runtime: ProjectRuntime,
    milestoneIndex: number,
    tracks: Track[],
    milestoneDescription: string,
  ) {
    const project = (await getProject(runtime.sessionID))!
    const milestone = project.milestones[milestoneIndex]!
    // Assign synthetic session IDs so state tracks running/attempt counts and
    // maxAutoTurns without creating real sessions.
    for (const track of tracks) {
      const syntheticID = `native-${runtime.sessionID.slice(0, 8)}-${track.id}-${Date.now().toString(36)}`
      await assignTrackSession(runtime.sessionID, milestoneIndex, track.id, syntheticID)
    }
    const refreshed = (await getProject(runtime.sessionID))!
    const batchTracks = tracks.map((track) => ({
      id: track.id,
      title: track.title,
      role: track.role,
      assignedFiles: track.assignedFiles,
      scratch:
        track.role === "challenger"
          ? `${runtime.directory}/.opencode/teamwork/${refreshed.slug}/scratch`
          : null,
    }))
    const batchText = nativeBatchPrompt({
      projectSlug: refreshed.slug,
      workingDirectory: refreshed.workingDirectory ?? runtime.directory,
      artifactPaths: refreshed.artifacts,
      integrityMode: refreshed.brief.integrityMode,
      milestoneID: milestone.id,
      milestoneTitle: milestone.title,
      milestoneDescription,
      tracks: batchTracks,
    })
    const deferred = createDeferred<void>()
    runtime.nativeBatch = {
      expected: tracks.map((track) => ({ milestoneIndex, trackID: track.id, role: track.role })),
      received: 0,
      resolve: () => deferred.resolve(),
      reject: (error: unknown) => deferred.reject(error as Error),
    }
    for (const track of tracks) {
      this.scheduleStallReminder(
        runtime,
        `native:${milestoneIndex}:${track.id}`,
        track.id,
        track.role,
        track.title,
        refreshed.trackStallReminderSeconds,
      )
    }
    try {
      await this.ops.promptMain(runtime.sessionID, batchText)
      await deferred.promise
      this.assertActive(runtime, (await getProject(runtime.sessionID))!)
    } finally {
      for (const track of tracks) this.clearStallTimer(runtime, `native:${milestoneIndex}:${track.id}`)
      if (runtime.nativeBatch) runtime.nativeBatch = null
    }
  }

  private async runTrack(runtime: ProjectRuntime, milestoneIndex: number, track: Track) {
    const project = (await getProject(runtime.sessionID))!
    const milestone = project.milestones[milestoneIndex]!
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
      const taskText = roleTaskPrompt({
        role: track.role,
        projectSlug: project.slug,
        workingDirectory: project.workingDirectory ?? runtime.directory,
        artifactPaths: project.artifacts,
        integrityMode: project.brief.integrityMode,
        taskTitle: track.title,
        taskDetail: milestone.description,
        assignedFiles: track.assignedFiles,
        scratchDirectory:
          track.role === "challenger" ? `${runtime.directory}/.opencode/teamwork/${project.slug}/scratch` : null,
        attemptContext: null,
        executorMode: "isolated",
      })
      await this.ops.promptSession(roleSessionID, withRoleIdentity(track.role, agentApplied, taskText))
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
    if (this.executorOf(project) === "native") {
      const syntheticID = `native-${runtime.sessionID.slice(0, 8)}-successAuditor`
      await recordAdhocSession(runtime.sessionID, "successAuditor", syntheticID)
      const waiter = createDeferred<ReportPayload>()
      runtime.successWaiter = waiter
      this.scheduleStallReminder(
        runtime,
        syntheticID,
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
          artifactPaths: project.artifacts,
          integrityMode: project.brief.integrityMode,
          taskTitle: "End-to-end success audit (native: fan out verification with subagents)",
          taskDetail:
            "All milestones passed their gates. Run a full end-to-end verification pass against the request " +
            "artifact's acceptance criteria: build, test, and run the project for real. Every criterion must be " +
            "verified with verbatim command output. Isolation is prompt-level; still rerun every claimed command yourself. " +
            "Submit the result through the teamwork_report tool with role successAuditor.",
          assignedFiles: [],
          scratchDirectory: null,
          attemptContext: null,
          executorMode: "native",
        })
        await this.ops.promptMain(runtime.sessionID, taskText)
        const report = await waiter.promise
        await this.finishSuccessAuditWithReport(runtime, project, report)
      } finally {
        this.clearStallTimer(runtime, syntheticID)
        runtime.successWaiter = null
      }
      return
    }
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
        artifactPaths: project.artifacts,
        integrityMode: project.brief.integrityMode,
        taskTitle: "End-to-end success audit",
        taskDetail:
          "All milestones passed their gates. Run a full end-to-end verification pass against the request " +
          "artifact's acceptance criteria: build, test, and run the project for real. Every criterion must be " +
          "verified with command output.",
        assignedFiles: [],
        scratchDirectory: null,
        attemptContext: null,
        executorMode: "isolated",
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
          locale: runtime.locale,
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
   * Native synthetic IDs (native-*) are not real sessions and are skipped.
   */
  private async roleSessionIDsFor(runtime: ProjectRuntime): Promise<string[]> {
    const sessionIDs = new Set<string>()
    for (const [roleSessionID, owner] of this.roleOwners) {
      if (owner === runtime.sessionID && !roleSessionID.startsWith("native-")) sessionIDs.add(roleSessionID)
    }
    for (const sessionID of runtime.activeRoleSessions) {
      if (!sessionID.startsWith("native-")) sessionIDs.add(sessionID)
    }
    try {
      const project = await getProject(runtime.sessionID)
      if (project) {
        for (const milestone of project.milestones) {
          for (const track of milestone.tracks) {
            if (track.sessionID && !track.sessionID.startsWith("native-")) sessionIDs.add(track.sessionID)
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
