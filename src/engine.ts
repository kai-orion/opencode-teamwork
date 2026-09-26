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
} from "./state"
import type { Milestone, Project, TeamRole, Track } from "./state"
import { agentNameForRole, roleTaskPrompt, sentinelDecisionPrompt, ROLE_AGENT_SYSTEM_PROMPTS } from "./prompts"
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
    const owner = this.roleOwners.get(roleSessionID) ?? roleSessionID
    const runtime = this.runtimes.get(owner)
    if (runtime?.planWaiter) runtime.planWaiter.resolve(plan)
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
    await this.pause(sessionID)
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

  private async abortRoleSessions(runtime: ProjectRuntime) {
    const interruptions = [...runtime.activeRoleSessions].map((roleSessionID) =>
      this.ops.interruptSession(roleSessionID).catch(() => undefined),
    )
    for (const waiter of runtime.reportWaiters.values()) waiter.reject(new AbortedError())
    runtime.reportWaiters.clear()
    if (runtime.planWaiter) {
      runtime.planWaiter.reject(new AbortedError())
      runtime.planWaiter = null
    }
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
    const { sessionID: orchestratorSession, agentApplied } = await this.spawnRoleSession(runtime, "orchestrator", project)
    await recordAdhocSession(sessionID, "orchestrator", orchestratorSession)
    runtime.roleAgentApplied.set(orchestratorSession, agentApplied)

    const planWaiter = createDeferred<PlanMilestoneInput[]>()
    runtime.planWaiter = planWaiter

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
    for (const track of workers) {
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
        }),
      )
      const report = await this.awaitReport(runtime, track.sessionID!)
      await submitTrackReport(track.sessionID!, report)
    }
  }

  /** Runs the given tracks with bounded parallelism; waits for all reports. */
  private async runTracksParallel(runtime: ProjectRuntime, milestoneIndex: number, tracks: Track[]) {
    const project = (await getProject(runtime.sessionID))!
    const limit = Math.max(1, project.maxParallelWorkers)
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

  private async runTrack(runtime: ProjectRuntime, milestoneIndex: number, track: Track) {
    const project = (await getProject(runtime.sessionID))!
    const milestone = project.milestones[milestoneIndex]!
    const { sessionID: roleSessionID, agentApplied } = await this.spawnRoleSession(runtime, track.role, project)
    await assignTrackSession(runtime.sessionID, milestoneIndex, track.id, roleSessionID)
    runtime.roleAgentApplied.set(roleSessionID, agentApplied)
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
      })
      await this.ops.promptSession(roleSessionID, withRoleIdentity(track.role, agentApplied, taskText))
      const report = await this.awaitReport(runtime, roleSessionID)
      await submitTrackReport(roleSessionID, report)
    } finally {
      runtime.activeRoleSessions.delete(roleSessionID)
      runtime.reportWaiters.delete(roleSessionID)
    }
  }

  private async runSuccessAudit(runtime: ProjectRuntime) {
    const project = (await getProject(runtime.sessionID))!
    const { sessionID: successSession, agentApplied } = await this.spawnRoleSession(runtime, "successAuditor", project)
    await recordAdhocSession(runtime.sessionID, "successAuditor", successSession)
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
      })
      await this.ops.promptSession(successSession, withRoleIdentity("successAuditor", agentApplied, taskText))
      const report = await this.awaitReport(runtime, successSession)
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
      await setSentinelUpdate(runtime.sessionID, `Project "${project.slug}" completed and verified end to end.`)
      await refreshPlanAndProgress(runtime.directory, (await getProject(runtime.sessionID))!)
      await this.ops.sendSynthetic(
        runtime.sessionID,
        `[Teamwork Sentinel] Project "${project.slug}" is complete: all milestones passed and the Success Auditor verified it end to end.`,
      )
    } finally {
      runtime.activeRoleSessions.delete(successSession)
      runtime.reportWaiters.delete(successSession)
    }
  }

  // -------------------------------------------------------------------------

  private async spawnRoleSession(
    runtime: ProjectRuntime,
    role: TeamRole | RoleAgentName,
    project: Project,
  ): Promise<{ sessionID: string; agentApplied: boolean }> {
    const result = await this.ops.createSession({
      agent: agentNameForRole(role as RoleAgentName),
      title: `${project.slug} — ${role}`,
    })
    runtime.activeRoleSessions.add(result.sessionID)
    this.roleOwners.set(result.sessionID, runtime.sessionID)
    return result
  }

  private async awaitReport(runtime: ProjectRuntime, roleSessionID: string) {
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
