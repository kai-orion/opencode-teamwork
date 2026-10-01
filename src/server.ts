import type { Config, Plugin } from "@opencode-ai/plugin"
import type * as PluginV2 from "@opencode/plugin"
import type { Info as ToolV2Info } from "@opencode/plugin/promise/tool"
import type { Tool as ToolSchema } from "@opencode/schema/tool"
import { appendFileSync } from "node:fs"
import { TeamEngine, TEAMWORK_TITLE_PREFIX, isEditingRole } from "./engine"
import type { PlanMilestoneInput, ReportPayload, SessionOps } from "./engine"
import { writeArtifacts } from "./artifacts"
import {
  agentNameForRole,
  approveCommandTemplate,
  cancelCommandTemplate,
  pauseCommandTemplate,
  resumeCommandTemplate,
  reviseCommandTemplate,
  statusCommandTemplate,
  systemReminder,
  teamworkCommandTemplate,
  ROLE_AGENT_NAMES,
  ROLE_AGENT_SYSTEM_PROMPTS,
} from "./prompts"
import {
  approveProject,
  cancelProject,
  createProject,
  getAllProjects,
  getProject,
  onStateRecovery,
  pauseProject,
  resumeProject,
  setProjectArtifacts,
  statePath,
  suspendTimerForPermission,
  updateProjectBrief,
  accountProjectUsage,
  formatProjectDetail,
  markProjectPlanPaused,
} from "./state"
import type { ExecutionPath, TeamRole, TeamScale } from "./state"

// ---------------------------------------------------------------------------
// Options (English only; no locale, no executor, no retry ceiling)
// ---------------------------------------------------------------------------

type Options = {
  register_command?: boolean
  max_parallel_workers?: number
  default_token_budget?: number
  max_auto_turns?: number
  max_duration_seconds?: number
  restricted_agents?: string[]
  track_stall_reminder_seconds?: number | null
}

const DEFAULT_RESTRICTED_AGENTS = ["plan"]
const TEAMWORK_AGENT_PREFIX = "teamwork-"

function positiveIntegerOrNull(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null
}

function restrictedAgentSet(options?: Options) {
  const names = Array.isArray(options?.restricted_agents) ? options.restricted_agents : DEFAULT_RESTRICTED_AGENTS
  return new Set(names.map((name) => (typeof name === "string" ? name.trim().toLowerCase() : "")).filter(Boolean))
}

function clampParallelWorkersOption(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null
  return Math.min(8, Math.max(1, value))
}

function stallReminderFromOptions(options?: Options): number | null | undefined {
  if (!options || !("track_stall_reminder_seconds" in options)) return undefined
  const value = options.track_stall_reminder_seconds
  if (value === null) return null
  return positiveIntegerOrNull(value) ?? undefined
}

// ---------------------------------------------------------------------------
// English-only tool/command copy
// ---------------------------------------------------------------------------

const MESSAGES = {
  commands: {
    teamworkDescription: "Start a Teamwork project: scoping interview, then an autonomous multi-agent build",
    approveDescription: "Approve the reviewed brief artifact and start Phase 2 execution",
    reviseDescription: "Apply revision instructions to the brief artifact and wait for approval again",
    statusDescription: "Show the current Teamwork project status",
    pauseDescription: "Pause the running Teamwork team",
    resumeDescription: "Resume the paused Teamwork team",
    cancelDescription: "Cancel the Teamwork project for this session",
  },
  tools: {
    createProject:
      "Commit the Phase 1 scoping interview results as a Teamwork project. Call this only after the interview has " +
      "converged: the user has confirmed objectives, requirements, independent verification, acceptance criteria, " +
      "the working directory, an integrity mode, and an execution path. This persists the brief artifact, records " +
      "the project state, and returns the artifact paths for the user to review.",
    submitReport:
      "Submit the structured final report for the currently assigned teamwork task. Required before the task " +
      "session ends: a session that finishes without submitting this report is treated as having failed the task.",
    getProject:
      "Get the current Teamwork project for this OpenCode session, including phase, execution path, integrity mode, " +
      "milestone progress, active tracks, budgets, and the latest Sentinel update.",
    projectName: "Short project slug used for identification (kebab-case).",
    brief: "Project objectives and scope: what to build, its purpose, and the audience.",
    requirements: "Requirement blocks covering what the user actually cares about.",
    verification: "Independent verification method per requirement: test suites, benchmarks, or rubric-judged review.",
    acceptanceCriteria: "Clear, testable criteria for considering the project complete.",
    integrityMode: "Verification strictness: development (default), demo, or benchmark.",
    executionPath: "Execution path: general (default), iterative, review, math, or math-large.",
    teamScale: "Team scale for the Large Team math path: S, M, or L. Null for other paths.",
    deep: "Deep verification on/off (default on). Off skips the challenger/falsifier depth.",
    role: "The reporting role.",
    verdict: "The role's verdict: pass, fail, or blocked.",
    findings: "Concrete findings from this role's pass.",
    evidence: "Concrete evidence: command output, test results, file references.",
    blockers: "Anything blocking this task from proceeding.",
    artifactsWritten: "Paths of files this role created or modified, if any.",
    tokenBudget: "Optional positive token budget for the whole team (all role sessions combined).",
    maxAutoTurns: "Optional cap on the number of role sessions the team may spawn.",
    maxDurationSeconds: "Optional wall-clock limit for the whole project.",
    maxParallelWorkers: "Max parallel tracks within a phase (default 5, cap 8).",
    trackStallReminderSeconds: "Per-track soft stall reminder in seconds (default 1800); null disables. Reminder only, never fails the track.",
  },
}

// ---------------------------------------------------------------------------
// Role agent registration
// ---------------------------------------------------------------------------

type RoleAgentDefinition = {
  role: (typeof ROLE_AGENT_NAMES)[number]
  permission: { edit: "allow" | "deny" }
}

const ROLE_AGENT_DEFINITIONS: RoleAgentDefinition[] = ROLE_AGENT_NAMES.map((role) => ({
  role,
  // Builders and adversarial probers write scratch/synthesis artifacts; every
  // verification role is strictly read-only over project sources.
  permission: { edit: isEditingRole(role) ? "allow" : "deny" },
}))

function agentConfigEntries() {
  const entries: Record<string, Record<string, unknown>> = {}
  for (const definition of ROLE_AGENT_DEFINITIONS) {
    entries[agentNameForRole(definition.role)] = {
      description: `${definition.role} role of an Antigravity-style teamwork project (spawned by the plugin state machine).`,
      mode: "subagent",
      hidden: true,
      prompt: ROLE_AGENT_SYSTEM_PROMPTS[definition.role],
      permission: {
        edit: definition.permission.edit,
        // Role sessions run non-interactive verification commands constantly;
        // inherit everything else from the user's global permission policy.
      },
    }
  }
  return entries
}

/**
 * Role agents are registered through the V1 `config` hook (the only
 * registration channel that persists on stable 2.x hosts): the default
 * definition exposes both this `server` function and the V2 `setup`, and the
 * host applies the returned hooks' `config` mutation at config resolution.
 */
const server: Plugin = async () => ({
  config: async (config: Config) => {
    try {
      config.agent = config.agent ?? {}
      for (const [name, definition] of Object.entries(agentConfigEntries())) {
        ;(config.agent as Record<string, unknown>)[name] = definition
      }
    } catch (error) {
      logError("Failed to register teamwork role agents through the config hook", error)
    }
  },
})

/**
 * Best-effort V2 agent-editor registration: on hosts where the editor's list
 * is the live registry this makes the agents visible without a config reload;
 * where it returns a copy, the config hook above is the effective channel.
 */
async function registerAgentsV2(context: PluginV2.Plugin.Context) {
  const entries = agentConfigEntries()
  try {
    if (!context.agent || typeof context.agent.transform !== "function") {
      logError("Agent registration unavailable: context.agent.transform is missing", new Error("missing"))
      return
    }
    await context.agent.transform((draft) => {
      const list = draft.list() as unknown as Array<Record<string, unknown>>
      for (const [name, definition] of Object.entries(entries)) {
        if (list.some((agent) => agent["id"] === name || agent["name"] === name)) continue
        const permission = definition as { permission?: { edit?: string } }
        list.push({
          id: name,
          name,
          mode: "subagent",
          hidden: true,
          description: definition["description"],
          system: definition["prompt"],
          request: { settings: {}, headers: {}, body: {} },
          permissions: [
            { action: "edit", resource: "*", effect: permission.permission?.edit === "deny" ? "deny" : "allow" },
          ],
        })
      }
    })
  } catch (error) {
    trace(`agent registration failed: ${error instanceof Error ? error.message : String(error)}`)
    logError("Failed to register teamwork role agents through the agent editor", error)
  }
}

// ---------------------------------------------------------------------------
// JSON schema helpers (V2 tools use raw JSON Schema, matching the goal plugin)
// ---------------------------------------------------------------------------

function v2ObjectSchema(properties: Record<string, unknown>, required: string[] = []): ToolSchema.ValueSchema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  } as ToolSchema.ValueSchema
}

const TEXT_SCHEMA = (description: string) => ({ type: "string", description })
const TEXT_ARRAY_SCHEMA = (description: string) => ({
  type: "array",
  items: { type: "string" },
  description,
})

const INTEGRITY_ENUM = {
  type: "string",
  enum: ["development", "demo", "benchmark"],
}

const EXECUTION_PATH_ENUM = {
  type: "string",
  enum: ["general", "iterative", "review", "math", "math-large"],
}

const TEAM_SCALE_ENUM = {
  type: ["string", "null"],
  enum: ["S", "M", "L", null],
}

const TRACK_ROLES = [
  "explorer",
  "worker",
  "critic",
  "challenger",
  "auditor",
  "prover",
  "falsifier",
  "verifier",
  "reviewer",
  "synthesizer",
]

const REPORT_ROLES = [...TRACK_ROLES, "orchestrator", "successAuditor"]

const BRIEF_PROPERTIES = {
  name: TEXT_SCHEMA(MESSAGES.tools.projectName),
  objectives: TEXT_SCHEMA(MESSAGES.tools.brief),
  requirements: TEXT_SCHEMA(MESSAGES.tools.requirements),
  verification: TEXT_SCHEMA(MESSAGES.tools.verification),
  acceptance_criteria: TEXT_SCHEMA(MESSAGES.tools.acceptanceCriteria),
  integrity_mode: { ...INTEGRITY_ENUM, description: MESSAGES.tools.integrityMode },
  execution_path: { ...EXECUTION_PATH_ENUM, description: MESSAGES.tools.executionPath },
  team_scale: { ...TEAM_SCALE_ENUM, description: MESSAGES.tools.teamScale },
  deep: { type: "boolean", description: MESSAGES.tools.deep },
}

type BriefArgs = {
  name: string
  objectives: string
  requirements: string
  verification: string
  acceptance_criteria: string
  integrity_mode?: "development" | "demo" | "benchmark"
  execution_path?: ExecutionPath
  team_scale?: TeamScale | null
  deep?: boolean
  token_budget?: number | null
  max_auto_turns?: number | null
  max_duration_seconds?: number | null
  max_parallel_workers?: number | null
  track_stall_reminder_seconds?: number | null
}

type ReportArgs = {
  role: TeamRole
  verdict: "pass" | "fail" | "blocked"
  findings?: string[]
  evidence?: string[]
  blockers?: string[]
  artifacts_written?: string[]
}

type PlanArgs = {
  milestones: Array<{
    title: string
    description: string
    tracks: Array<{ title: string; role: TeamRole; assigned_files?: string[] }>
  }>
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function tokensFromRecord(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const tokens = value as Record<string, unknown>
  if (typeof tokens.total === "number") return tokens.total
  const cache = tokens.cache && typeof tokens.cache === "object" ? (tokens.cache as Record<string, unknown>) : {}
  const fields = [tokens.input, tokens.output, tokens.reasoning, cache.read, cache.write]
  if (!fields.some((field) => typeof field === "number")) return undefined
  return fields.reduce<number>(
    (sum, field) => sum + (typeof field === "number" && Number.isFinite(field) ? field : 0),
    0,
  )
}

type V2EventLike = {
  type: string
  created: number
  data: Record<string, unknown>
}

function decodeV2Event(value: unknown): V2EventLike | undefined {
  let decoded = value
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded)
    } catch {
      return undefined
    }
  }
  if (!isRecord(decoded) || typeof decoded.type !== "string" || !isRecord(decoded.data)) return undefined
  if (typeof decoded.created !== "number") return undefined
  return decoded as V2EventLike
}

function isPermissionPendingEvent(event: V2EventLike): boolean {
  const type = event.type.toLowerCase()
  if (type.includes("permission") || type.includes("approval") || type.includes("auth.ask") || type.includes("ask.permission")) {
    return true
  }
  const data = event.data
  for (const key of ["permission", "approval", "permissionRequest", "authRequest"]) {
    if (data[key] != null) return true
  }
  const status = typeof data.status === "string" ? data.status.toLowerCase() : ""
  if (status.includes("permission") || status.includes("approval") || status.includes("waiting")) {
    // Only treat waiting-for-approval shapes as permission blocks, not every
    // generic waiting state: require a permission-flavored marker nearby.
    const blob = JSON.stringify(data).toLowerCase()
    if (blob.includes("permission") || blob.includes("approval")) return true
  }
  return false
}

function permissionDetailFromEvent(event: V2EventLike): string {
  const data = event.data
  const candidates = [
    data.detail,
    data.message,
    data.permission,
    data.permissionRequest,
    data.approval,
    data.authRequest,
    data.tool,
    data.action,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 500)
    if (isRecord(candidate)) {
      try {
        return JSON.stringify(candidate).slice(0, 500)
      } catch {
        // Fall through to the generic detail.
      }
    }
  }
  return `Host event "${event.type}" indicates a permission approval is waiting. Approve or deny it in the host UI.`
}

function logError(message: string, error: unknown) {
  try {
    console.error(`[opencode-teamwork] ${message}:`, error instanceof Error ? error.message : String(error))
  } catch {
    // Logging must never break plugin control flow.
  }
}

function unwrap<T>(response: { data?: unknown } | T): T {
  const record = response as { data?: unknown } | undefined
  if (record && typeof record === "object" && "data" in record && record.data !== undefined) {
    return record.data as T
  }
  return response as T
}

// ---------------------------------------------------------------------------
// V2 setup
// ---------------------------------------------------------------------------

function traceFile() {
  return process.env.OPENCODE_TEAMWORK_TRACE
}

function trace(message: string) {
  const file = traceFile()
  if (!file) return
  try {
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Tracing must never break setup.
  }
}

async function setupV2(context: PluginV2.Plugin.Context): Promise<PluginV2.Plugin.Cleanup> {
  trace("setup: start")
  const options = (context.options ?? {}) as Options
  const registerCommand = options.register_command ?? true
  const directory = context.location?.directory ?? process.cwd()
  const planAgents = restrictedAgentSet(options)
  const isPlanAgent = (agent: unknown) =>
    typeof agent === "string" && planAgents.has(agent.trim().toLowerCase())

  const agentSupport = { namedAgents: false }
  const engine = new TeamEngine(sessionOps(context, agentSupport), { directory })

  const registrations: Array<{ dispose(): Promise<void> }> = []
  let disposed = false

  // Corrupt-state quarantine reporting (best-effort, mirrors the goal plugin).
  const recoveryOff = onStateRecovery(statePath(), (notice) => {
    try {
      console.warn(
        `[opencode-teamwork] Project state at ${notice.stateFile} was quarantined at ${notice.quarantineFile} (${notice.outcome}).`,
      )
    } catch {
      // Diagnostics must never break control flow.
    }
  })

  await registerAgentsV2(context)
  trace("setup: agents done")
  // Detect whether the role agents are actually visible to the host: the
  // agent-editor push does not persist on every host, and config-hook
  // injection is too late for lazily loaded plugins. When the named agents
  // are missing, role sessions run without a named agent and the role
  // identity rides the task prompt instead.
  let namedAgentsAvailable = false
  try {
    const listedResponse = (await context.agent.list()) as unknown as
      | Array<{ id?: string; name?: string }>
      | { data?: Array<{ id?: string; name?: string }> }
    const listed = Array.isArray(listedResponse) ? listedResponse : (listedResponse?.data ?? [])
    const names = new Set((listed ?? []).map((agent) => String(agent?.id ?? agent?.name ?? "")))
    namedAgentsAvailable = names.has(agentNameForRole("orchestrator"))
    trace(`setup: named agents available = ${namedAgentsAvailable} (${names.size} agents)`)
  } catch (error) {
    trace(`agent list failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  agentSupport.namedAgents = namedAgentsAvailable

  // Runtime capability probe: the V2 host may pass a narrower session domain
  // than the type declares. Log what is actually available so the cleanup
  // strategy degrades correctly.
  try {
    const runtimeSession = context.session as unknown as Record<string, unknown>
    const available = Object.getOwnPropertyNames(Object.getPrototypeOf(runtimeSession) ?? {})
      .concat(Object.keys(runtimeSession))
      .filter((key, index, all) => all.indexOf(key) === index)
    trace(`setup: session methods = [${available.join(", ")}]`)
  } catch (error) {
    trace(`setup: session probe failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // --- Residual sweep -------------------------------------------------------
  //
  // Projects that closed (complete/cancel) may still have role sessions on
  // disk when the process died before cleanup ran. On setup, delete them so
  // crashed runs do not leave debris in the user's session list. Sessions
  // are only removed when they carry the teamwork metadata marker.
  void sweepResidualSessionsV2(context, directory).catch((error) => {
    trace(`residual sweep failed: ${error instanceof Error ? error.message : String(error)}`)
  })

  // --- Commands ------------------------------------------------------------

  if (registerCommand) {
    let listed: Array<{ name: string }> = []
    try {
      const listedResponse = await context.command.list()
      listed = (Array.isArray(listedResponse) ? listedResponse : ((listedResponse as { data?: Array<{ name: string }> }).data ?? [])) as Array<{
        name: string
      }>
    } catch (error) {
      trace(`setup: command.list failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const existingCommands = new Set(listed.map((command) => command.name))
    trace(`setup: command.list -> ${existingCommands.size} existing`)
    const commandDefinitions = [
      { name: "teamwork", description: MESSAGES.commands.teamworkDescription, template: teamworkCommandTemplate() },
      { name: "teamwork-approve", description: MESSAGES.commands.approveDescription, template: approveCommandTemplate() },
      { name: "teamwork-revise", description: MESSAGES.commands.reviseDescription, template: reviseCommandTemplate() },
      { name: "teamwork-status", description: MESSAGES.commands.statusDescription, template: statusCommandTemplate() },
      { name: "teamwork-pause", description: MESSAGES.commands.pauseDescription, template: pauseCommandTemplate() },
      { name: "teamwork-resume", description: MESSAGES.commands.resumeDescription, template: resumeCommandTemplate() },
      { name: "teamwork-cancel", description: MESSAGES.commands.cancelDescription, template: cancelCommandTemplate() },
    ]
    try {
      registrations.push(
        await context.command.transform((draft) => {
          for (const command of commandDefinitions) {
            if (existingCommands.has(command.name)) continue
            draft.add({
              name: command.name,
              description: command.description,
              execute: async (input) => {
                const text = command.template.replaceAll("$ARGUMENTS", () => input.prompt.text.trim())
                await context.session.prompt({
                  sessionID: input.sessionID,
                  text,
                  delivery: input.delivery,
                })
              },
            })
          }
        }),
      )
      trace(`setup: commands registered (${commandDefinitions.length})`)
    } catch (error) {
      trace(`setup: command.transform failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // --- Tools ---------------------------------------------------------------

    try {
      await context.tool.transform((draft) => {
        for (const tool of teamworkToolsV2({ options, engine, directory })) draft.add(tool)
      })
      trace("setup: tools registered")
    } catch (error) {
      trace(`setup: tool.transform failed: ${error instanceof Error ? error.message : String(error)}`)
    }

  // --- Hooks ---------------------------------------------------------------

  registrations.push(
    await context.session.hook("context", (sessionContext) => {
      // Role sessions carry their own agent system prompt; the reminder is
      // only for main sessions.
      if (typeof sessionContext.agent === "string" && sessionContext.agent.startsWith(TEAMWORK_AGENT_PREFIX)) return
      const reminder = systemReminder()
      if (sessionContext.system.some((part) => part.type === "text" && part.text.includes(reminder))) return
      sessionContext.system.push({ type: "text", text: reminder })
    }),
  )

  // --- Events (usage accounting + plan-mode pausing) ------------------------

  trace("setup: commands+tools registered")

  const abortController = new AbortController()
  let eventIterator: AsyncIterator<unknown> | undefined
  const consumer = (async () => {
    try {
      const subscription = context.event.subscribe({ signal: abortController.signal })
      const iterator = subscription[Symbol.asyncIterator]()
      eventIterator = iterator
      while (true) {
        const { done, value } = await iterator.next()
        if (done) break
        const event = decodeV2Event(value)
        if (event) await handleV2Event(event)
      }
    } catch (error) {
      if (!abortController.signal.aborted) logError("V2 event consumer stopped", error)
    }
  })()

  async function handleV2Event(event: V2EventLike) {
    const data = event.data
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    if (!sessionID || disposed) return

    // Permission-pending detection (best-effort across host versions): any
    // event whose type or payload mentions permission/approval is treated as
    // a role session blocked on user approval. Slow-but-alive must not look
    // like progress, so Sentinel alarms immediately and suspends the timer.
    if (isPermissionPendingEvent(event)) {
      try {
        const detail = permissionDetailFromEvent(event)
        await suspendTimerForPermission(engine.projectSessionFor(sessionID) ?? sessionID).catch(() => null)
        engine.notifyPermissionPending(sessionID, detail)
      } catch (error) {
        logError("Failed to handle permission pending event", error)
      }
      return
    }

    switch (event.type) {
      // Plan-mode detection: pausing the team while the user switches the
      // main session to a restricted (plan) agent.
      case "session.agent.selected": {
        if (typeof data.agent === "string") {
          try {
            await markProjectPlanPaused(sessionID, isPlanAgent(data.agent))
          } catch (error) {
            logError("Failed to update plan-pause state", error)
          }
        }
        return
      }
      case "session.usage.updated": {
        const tokens = tokensFromRecord(data.tokens)
        if (typeof tokens !== "number") return
        await accountTokens(sessionID, tokens, "v2.session")
        return
      }
      case "session.step.ended":
      case "session.step.failed": {
        const tokens = tokensFromRecord(data.tokens)
        if (typeof tokens !== "number") return
        await accountTokens(sessionID, tokens, "v2.steps")
        return
      }
      default:
        return
    }
  }

  async function accountTokens(sessionID: string, tokens: number, source: string) {
    try {
      const owner = engine.projectSessionFor(sessionID)
      if (owner) {
        // Role-session usage is attributed to the owning project with a
        // per-session tracker so compaction-safe baselines stay independent.
        await accountProjectUsage(owner, tokens, { cumulative: true, source: `${sessionID}:${source}` })
        return
      }
      await accountProjectUsage(sessionID, tokens, { cumulative: true, source })
    } catch (error) {
      logError("Failed to account project token usage", error)
    }
  }

  return async () => {
    disposed = true
    abortController.abort()
    recoveryOff()
    for (const registration of registrations) await registration.dispose()
    const termination = Promise.allSettled([consumer, eventIterator?.return?.()])
    await Promise.race([termination, new Promise((resolve) => setTimeout(resolve, 2_000))])
    console.error("[opencode-teamwork] setup: cleanup complete")
  }
}

/**
 * Deletes leftover role sessions from closed (complete/cancelled) projects.
 * A session is only removed when it still exists and carries the teamwork
 * metadata marker, so user-created sessions are never touched. Best-effort
 * and idempotent: missing sessions resolve to "already gone".
 */
async function sweepResidualSessionsV2(context: PluginV2.Plugin.Context, directory: string) {
  const allProjects = await getAllProjects()
  const closed = allProjects.filter(
    (project) => isClosedPhase(project.phase) && (project.workingDirectory ?? directory) === directory,
  )
  if (closed.length === 0) return
  const candidates = new Set<string>()
  for (const project of closed) {
    for (const milestone of project.milestones) {
      for (const track of milestone.tracks) {
        if (track.sessionID) candidates.add(track.sessionID)
      }
    }
  }
  if (candidates.size === 0) return
  const domain = context.session as unknown as Record<string, unknown>
  const remove = domain.remove as ((input: { sessionID: string }) => Promise<unknown>) | undefined
  const update = domain.update as ((input: { sessionID: string; title: string }) => Promise<unknown>) | undefined
  for (const sessionID of candidates) {
    try {
      const info = unwrap<{ metadata?: Record<string, unknown>; title?: string }>(await context.session.get({ sessionID }))
      if (!info || info.metadata?.teamwork !== true) continue
      if (typeof remove === "function") {
        await remove({ sessionID })
        trace(`residual sweep: removed ${sessionID}`)
      } else if (typeof update === "function" && !String(info.title ?? "").includes("[teamwork done]")) {
        // Host cannot delete: at least make the leftover recognizable.
        await update({ sessionID, title: `${info.title ?? "teamwork session"} [teamwork done]` })
        trace(`residual sweep: marked ${sessionID}`)
      }
    } catch {
      // Missing or undeletable session: skip.
    }
  }
}

function isClosedPhase(phase: string): boolean {
  return phase === "complete" || phase === "cancelled"
}

function sessionOps(context: PluginV2.Plugin.Context, agentSupport: { namedAgents: boolean }): SessionOps {
  const directory = context.location?.directory ?? process.cwd()
  const traceSession = (message: string) => {
    if (!process.env.OPENCODE_TEAMWORK_TRACE) return
    try {
      appendFileSync(
        process.env.OPENCODE_TEAMWORK_TRACE,
        `${new Date().toISOString()} sessionOps: ${message}\n`,
      )
    } catch {
      // Tracing must never break control flow.
    }
  }
  return {
    async createSession({ agent, title }) {
      const useAgent = agentSupport.namedAgents
      traceSession(`create start (${agent}, named=${useAgent})`)
      // Mark the session so tools, the TUI, and the residual sweep can tell
      // teamwork sessions apart from user-created ones.
      const [projectSlug] = title.startsWith(TEAMWORK_TITLE_PREFIX)
        ? [title.slice(TEAMWORK_TITLE_PREFIX.length).trim().split(" — ")[0] ?? "unknown"]
        : ["unknown"]
      const response = await context.session.create({
        ...(useAgent ? { agent } : {}),
        title,
        location: { directory },
        metadata: {
          teamwork: true,
          agent,
          projectSlug,
        },
      })
      const info = unwrap<{ id?: string }>(response)
      if (!info?.id) throw new Error("session.create returned no session id")
      traceSession(`created ${info.id}`)
      return { sessionID: info.id, agentApplied: useAgent }
    },
    async removeSession(sessionID) {
      // The V2 SessionDomain type omits `remove`, but the host hands the plugin
      // the full session API at runtime (HTTP DELETE /api/session/{id}).
      const candidate = context.session as typeof context.session & {
        remove?: (input: { sessionID: string }) => Promise<unknown>
      }
      if (typeof candidate.remove !== "function") {
        traceSession(`remove unavailable host ${sessionID}`)
        return false
      }
      try {
        await candidate.remove({ sessionID })
        traceSession(`removed ${sessionID}`)
        return true
      } catch (error) {
        traceSession(`remove FAILED ${sessionID}: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },
    async renameSession(sessionID, title) {
      // The runtime domain exposes `update` (title/metadata PATCH) but not
      // `rename`; accept either so the fallback works across host versions.
      const domain = context.session as unknown as Record<string, unknown>
      try {
        const update = domain.update
        if (typeof update === "function") {
          await (update as (input: { sessionID: string; title: string }) => Promise<unknown>)({ sessionID, title })
          return
        }
        const rename = domain.rename
        if (typeof rename === "function") {
          await (rename as (input: { sessionID: string; title: string }) => Promise<unknown>)({ sessionID, title })
          return
        }
        traceSession(`rename unavailable host ${sessionID}`)
      } catch (error) {
        traceSession(`rename FAILED ${sessionID}: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    async promptSession(sessionID, text) {
      traceSession(`prompt ${sessionID} (${text.length} chars)`)
      try {
        await context.session.prompt({ sessionID, text })
        traceSession(`prompt delivered ${sessionID}`)
      } catch (error) {
        traceSession(`prompt FAILED ${sessionID}: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    },
    async waitForSession(sessionID) {
      traceSession(`wait ${sessionID}`)
      await context.session.wait({ sessionID })
      traceSession(`wait done ${sessionID}`)
    },
    async sendSynthetic(sessionID, text) {
      await context.session.synthetic({ sessionID, text })
    },
    async promptMain(sessionID, text) {
      await context.session.prompt({ sessionID, text })
    },
    async interruptSession(sessionID) {
      await context.session.interrupt({ sessionID })
    },
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function teamworkToolsV2(services: {
  options: Options
  engine: TeamEngine
  directory: string
}): ToolV2Info[] {
  const { options, engine, directory } = services
  return [
    {
      name: "teamwork_create_project",
      description: MESSAGES.tools.createProject,
      input: v2ObjectSchema(
        {
          ...BRIEF_PROPERTIES,
          token_budget: { type: ["integer", "null"], minimum: 1, description: MESSAGES.tools.tokenBudget },
          max_auto_turns: { type: ["integer", "null"], minimum: 1, description: MESSAGES.tools.maxAutoTurns },
          max_duration_seconds: { type: ["integer", "null"], minimum: 1, description: MESSAGES.tools.maxDurationSeconds },
          max_parallel_workers: { type: ["integer", "null"], minimum: 1, maximum: 8, description: MESSAGES.tools.maxParallelWorkers },
          track_stall_reminder_seconds: {
            type: ["integer", "null"],
            minimum: 1,
            description: MESSAGES.tools.trackStallReminderSeconds,
          },
        },
        ["name", "objectives", "requirements", "verification", "acceptance_criteria"],
      ),
      options: { codemode: false },
      execute: async (rawArgs, toolContext) => {
        const args = rawArgs as BriefArgs
        const stallFromArgs =
          "track_stall_reminder_seconds" in args
            ? args.track_stall_reminder_seconds === null
              ? null
              : (positiveIntegerOrNull(args.track_stall_reminder_seconds) ?? undefined)
            : stallReminderFromOptions(options)
        const project = await createProject(
          toolContext.sessionID,
          {
            name: args.name,
            objectives: args.objectives,
            requirements: args.requirements,
            verification: args.verification,
            acceptanceCriteria: args.acceptance_criteria,
            integrityMode: args.integrity_mode ?? "development",
            executionPath: args.execution_path ?? "general",
            teamScale: args.team_scale ?? null,
            deep: args.deep ?? true,
          },
          {
            tokenBudget: positiveIntegerOrNull(args.token_budget) ?? positiveIntegerOrNull(options.default_token_budget),
            maxAutoTurns: positiveIntegerOrNull(args.max_auto_turns) ?? positiveIntegerOrNull(options.max_auto_turns),
            maxDurationSeconds:
              positiveIntegerOrNull(args.max_duration_seconds) ?? positiveIntegerOrNull(options.max_duration_seconds),
            maxParallelWorkers:
              clampParallelWorkersOption(args.max_parallel_workers) ??
              clampParallelWorkersOption(options.max_parallel_workers),
            trackStallReminderSeconds: stallFromArgs,
            workingDirectory: directory,
          },
        )
        const artifacts = await writeArtifacts(directory, project)
        await setProjectArtifacts(toolContext.sessionID, artifacts)
        return {
          content: JSON.stringify(
            {
              created: true,
              project: project.slug,
              phase: project.phase,
              execution_path: project.brief.executionPath,
              integrity_mode: project.brief.integrityMode,
              artifacts,
              next_step: "Show the artifacts to the user and ask them to run /teamwork-approve (or /teamwork-revise).",
            },
            null,
            2,
          ),
        }
      },
    },
    {
      name: "teamwork_revise",
      description:
        "Commit a revised brief for the project that is awaiting approval. Call after the user requests changes " +
        "through /teamwork-revise, passing the complete updated brief.",
      input: v2ObjectSchema(
        { ...BRIEF_PROPERTIES },
        ["name", "objectives", "requirements", "verification", "acceptance_criteria"],
      ),
      options: { codemode: false },
      execute: async (rawArgs, toolContext) => {
        const args = rawArgs as BriefArgs
        const project = await updateProjectBrief(toolContext.sessionID, {
          name: args.name,
          objectives: args.objectives,
          requirements: args.requirements,
          verification: args.verification,
          acceptanceCriteria: args.acceptance_criteria,
          integrityMode: args.integrity_mode ?? "development",
          executionPath: args.execution_path ?? "general",
          teamScale: args.team_scale ?? null,
          deep: args.deep ?? true,
        })
        const artifacts = await writeArtifacts(directory, project)
        await setProjectArtifacts(toolContext.sessionID, artifacts)
        return {
          content: JSON.stringify({ revised: true, project: project.slug, phase: project.phase, artifacts }, null, 2),
        }
      },
    },
    {
      name: "teamwork_approve",
      description:
        "Approve the project that is awaiting approval and start the autonomous multi-agent team (Phase 2). " +
        "Only the user can approve; call this from the /teamwork-approve command flow.",
      input: v2ObjectSchema({}),
      options: { codemode: false },
      execute: async (_args, toolContext) => {
        const project = await approveProject(toolContext.sessionID)
        if (!project.planPaused) engine.startExecution(toolContext.sessionID)
        return {
          content: JSON.stringify(
            {
              approved: true,
              project: project.slug,
              phase: project.phase,
              plan_paused: project.planPaused,
            },
            null,
            2,
          ),
        }
      },
    },
    {
      name: "teamwork_pause",
      description: "Pause the executing team. Role sessions are interrupted and the project stops scheduling work.",
      input: v2ObjectSchema({}),
      options: { codemode: false },
      execute: async (_args, toolContext) => {
        await engine.pause(toolContext.sessionID)
        const project = await pauseProject(toolContext.sessionID, "Paused by the user.", {
          stopReason: "paused",
          blocker: null,
        })
        return { content: JSON.stringify({ paused: true, project: project.slug, phase: project.phase }, null, 2) }
      },
    },
    {
      name: "teamwork_resume",
      description: "Resume the paused team; the state machine continues from the first unfinished milestone.",
      input: v2ObjectSchema({}),
      options: { codemode: false },
      execute: async (_args, toolContext) => {
        const project = await resumeProject(toolContext.sessionID)
        engine.startExecution(toolContext.sessionID)
        return { content: JSON.stringify({ resumed: true, project: project.slug, phase: project.phase }, null, 2) }
      },
    },
    {
      name: "teamwork_cancel",
      description: "Cancel the project for this session. Role sessions are interrupted and the project is closed.",
      input: v2ObjectSchema({}),
      options: { codemode: false },
      execute: async (_args, toolContext) => {
        await engine.cancel(toolContext.sessionID)
        const cancelled = await cancelProject(toolContext.sessionID, "Cancelled by the user.")
        return { content: JSON.stringify({ cancelled }, null, 2) }
      },
    },
    {
      name: "teamwork_get_project",
      description: MESSAGES.tools.getProject,
      input: v2ObjectSchema({}),
      options: { codemode: false },
      execute: async (_args, toolContext) => {
        const project = await getProject(toolContext.sessionID)
        return { content: formatProjectDetail(project) }
      },
    },
    {
      name: "teamwork_submit_plan",
      description:
        "Submit the milestone plan for the project (orchestrator role only). Required before any implementation " +
        "work: the state machine sequences milestones exactly as planned here.",
      input: v2ObjectSchema(
        {
          milestones: {
            type: "array",
            description: "Ordered milestones for the whole project.",
            items: {
              type: "object",
              properties: {
                title: TEXT_SCHEMA("Short milestone title."),
                description: TEXT_SCHEMA("Outcome of this milestone and how it is verified."),
                tracks: {
                  type: "array",
                  description: "Work tracks for this milestone.",
                  items: {
                    type: "object",
                    properties: {
                      title: TEXT_SCHEMA("Short track title."),
                      role: {
                        type: "string",
                        enum: TRACK_ROLES,
                      },
                      assigned_files: TEXT_ARRAY_SCHEMA(
                        "Exclusive file list for builder tracks; a file may appear in at most one builder track per milestone.",
                      ),
                    },
                    required: ["title", "role"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["title", "description", "tracks"],
              additionalProperties: false,
            },
          },
        },
        ["milestones"],
      ),
      options: { codemode: false },
      execute: async (rawArgs, toolContext) => {
        const args = rawArgs as PlanArgs
        const plan: PlanMilestoneInput[] = (args.milestones ?? []).map((milestone) => ({
          title: String(milestone.title ?? ""),
          description: String(milestone.description ?? ""),
          tracks: (milestone.tracks ?? []).map((track) => ({
            title: String(track.title ?? ""),
            role: track.role,
            assignedFiles: Array.isArray(track.assigned_files) ? track.assigned_files.map(String) : [],
          })),
        }))
        engine.onPlan(toolContext.sessionID, plan)
        return {
          content: JSON.stringify({ submitted: true, milestones: plan.length }, null, 2),
        }
      },
    },
    {
      name: "teamwork_report",
      description: MESSAGES.tools.submitReport,
      input: v2ObjectSchema(
        {
          role: {
            type: "string",
            enum: REPORT_ROLES,
            description: MESSAGES.tools.role,
          },
          verdict: {
            type: "string",
            enum: ["pass", "fail", "blocked"],
            description: MESSAGES.tools.verdict,
          },
          findings: TEXT_ARRAY_SCHEMA(MESSAGES.tools.findings),
          evidence: TEXT_ARRAY_SCHEMA(MESSAGES.tools.evidence),
          blockers: TEXT_ARRAY_SCHEMA(MESSAGES.tools.blockers),
          artifacts_written: TEXT_ARRAY_SCHEMA(MESSAGES.tools.artifactsWritten),
        },
        ["role", "verdict"],
      ),
      options: { codemode: false },
      execute: async (rawArgs, toolContext) => {
        const args = rawArgs as ReportArgs
        const report: ReportPayload = {
          role: args.role,
          verdict: args.verdict,
          findings: Array.isArray(args.findings) ? args.findings.map(String) : [],
          evidence: Array.isArray(args.evidence) ? args.evidence.map(String) : [],
          blockers: Array.isArray(args.blockers) ? args.blockers.map(String) : [],
          artifactsWritten: Array.isArray(args.artifacts_written) ? args.artifacts_written.map(String) : [],
        }
        engine.onReport(toolContext.sessionID, report)
        return {
          content: JSON.stringify({ received: true, verdict: report.verdict }, null, 2),
        }
      },
    },
  ]
}

export default {
  id: "local.teamwork.server",
  server,
  setup: setupV2,
}

// Re-exported for tests and the TUI.
export { statePath, getProject }
export const __internals = { decodeV2Event, tokensFromRecord, v2ObjectSchema }
