import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Data, Effect, Schema } from "effect"
import { atomicWriteFile } from "./atomic-write"

export type Phase =
  | "interview"
  | "awaitingApproval"
  | "executing"
  | "paused"
  | "budgetLimited"
  | "complete"
  | "cancelled"

export type IntegrityMode = "development" | "demo" | "benchmark"

export type ExecutionPath = "general" | "iterative" | "review" | "math" | "math-large"

export type TeamScale = "S" | "M" | "L"

export type TeamRole =
  | "orchestrator"
  | "explorer"
  | "worker"
  | "critic"
  | "challenger"
  | "auditor"
  | "successAuditor"
  | "prover"
  | "falsifier"
  | "verifier"
  | "reviewer"
  | "synthesizer"

export type MilestoneStatus = "pending" | "inProgress" | "verification" | "passed" | "failed"
export type TrackStatus = "queued" | "running" | "awaitingVerification" | "passed" | "failed"
export type Verdict = "pass" | "fail" | "blocked"

export type ProjectHistoryType =
  | "created"
  | "updated"
  | "artifact"
  | "approved"
  | "paused"
  | "resumed"
  | "milestone"
  | "verification"
  | "completed"
  | "cancelled"
  | "warning"
  | "limited"
  | "error"

export type ProjectHistoryEntry = {
  type: ProjectHistoryType
  detail: string
  timestamp: number
}

export type Brief = {
  name: string
  objectives: string
  requirements: string
  verification: string
  acceptanceCriteria: string
  integrityMode: IntegrityMode
  executionPath: ExecutionPath
  teamScale: TeamScale | null
  deep: boolean
}

export type RoleReport = {
  role: TeamRole
  verdict: Verdict
  findings: string[]
  evidence: string[]
  blockers: string[]
  artifactsWritten: string[]
  submittedAt: number
}

export type Track = {
  id: string
  title: string
  role: TeamRole
  assignedFiles: string[]
  status: TrackStatus
  /** The role session executing this track; null while queued. */
  sessionID: string | null
  attempt: number
  lastReport: RoleReport | null
}

export type Milestone = {
  id: string
  title: string
  description: string
  status: MilestoneStatus
  tracks: Track[]
  verificationAttempts: number
}

export type SentinelUpdate = {
  message: string
  timestamp: number
}

export type CreateProjectOptions = {
  tokenBudget?: number | null
  maxAutoTurns?: number | null
  maxDurationSeconds?: number | null
  maxParallelWorkers?: number | null
  workingDirectory?: string | null
  trackStallReminderSeconds?: number | null
}

export type UsageTracker = {
  baseline: number
  lastObserved: number
  baseTokens: number
  pendingBaseline: number | null
  pendingBaseTokens: number | null
}

export type Project = {
  sessionID: string
  slug: string
  brief: Brief
  phase: Phase
  milestones: Milestone[]
  activeMilestoneIndex: number
  artifacts: { brief: string; request: string; plan: string; progress: string } | null
  workingDirectory: string | null
  tokenBudget: number | null
  tokensUsed: number
  usageTrackers: Record<string, UsageTracker>
  timeUsedSeconds: number
  lastAccountedAt: number | null
  /** Role sessions spawned since the last resume; counts against maxAutoTurns. */
  sessionsSpawned: number
  maxAutoTurns: number | null
  maxDurationSeconds: number | null
  maxParallelWorkers: number
  /** Soft per-track stall reminder threshold in seconds; null disables. */
  trackStallReminderSeconds: number | null
  planPaused: boolean
  sentinelUpdate: SentinelUpdate | null
  history: ProjectHistoryEntry[]
  completionEvidence: string | null
  blocker: string | null
  closedAt: number | null
  stopReason: string | null
  lastStatus: string | null
  createdAt: number
  updatedAt: number
}

type State = {
  version: 2
  projects: Record<string, Project>
}

class StateReadError extends Data.TaggedError("StateReadError")<{
  readonly cause: unknown
}> {}

class StateDecodeError extends Data.TaggedError("StateDecodeError")<{
  readonly cause: unknown
}> {}

class StateWriteError extends Data.TaggedError("StateWriteError")<{
  readonly cause: unknown
}> {}

const MAX_HISTORY_ENTRIES = 80
const CHECKPOINT_CHAR_LIMIT = 280
const DEFAULT_MAX_PARALLEL_WORKERS = 5
const MAX_PARALLEL_WORKERS_CAP = 8
const DEFAULT_TRACK_STALL_REMINDER_SECONDS = 1800
const NULLABLE_STRING = Schema.NullOr(Schema.String)
const NULLABLE_NUMBER = Schema.NullOr(Schema.Number)

export const EXECUTION_PATHS: ExecutionPath[] = ["general", "iterative", "review", "math", "math-large"]

export function isExecutionPath(value: unknown): value is ExecutionPath {
  return typeof value === "string" && (EXECUTION_PATHS as string[]).includes(value)
}

export function normalizeExecutionPath(value: unknown): ExecutionPath {
  return isExecutionPath(value) ? value : "general"
}

export function normalizeTeamScale(value: unknown): TeamScale | null {
  return value === "S" || value === "M" || value === "L" ? value : null
}

export function normalizeDeepFlag(value: unknown): boolean {
  return value === undefined ? true : value !== false && value !== "off" && value !== 0
}

export function clampParallelWorkers(value: unknown): number {
  const parsed = typeof value === "number" && Number.isSafeInteger(value) ? value : DEFAULT_MAX_PARALLEL_WORKERS
  return Math.min(MAX_PARALLEL_WORKERS_CAP, Math.max(1, parsed))
}

export { DEFAULT_MAX_PARALLEL_WORKERS, MAX_PARALLEL_WORKERS_CAP, DEFAULT_TRACK_STALL_REMINDER_SECONDS }

const HistoryEntrySchema = Schema.Struct({
  type: Schema.Literal(
    "created",
    "updated",
    "artifact",
    "approved",
    "paused",
    "resumed",
    "milestone",
    "verification",
    "completed",
    "cancelled",
    "warning",
    "limited",
    "error",
  ),
  detail: Schema.String,
  timestamp: Schema.Number,
})

const BriefSchema = Schema.Struct({
  name: Schema.String,
  objectives: Schema.String,
  requirements: Schema.String,
  verification: Schema.String,
  acceptanceCriteria: Schema.String,
  integrityMode: Schema.Literal("development", "demo", "benchmark"),
  executionPath: Schema.Literal("general", "iterative", "review", "math", "math-large"),
  teamScale: Schema.NullOr(Schema.Literal("S", "M", "L")),
  deep: Schema.Boolean,
})

const TEAM_ROLES = [
  "orchestrator",
  "explorer",
  "worker",
  "critic",
  "challenger",
  "auditor",
  "successAuditor",
  "prover",
  "falsifier",
  "verifier",
  "reviewer",
  "synthesizer",
] as const

const RoleReportSchema = Schema.Struct({
  role: Schema.Literal(...TEAM_ROLES),
  verdict: Schema.Literal("pass", "fail", "blocked"),
  findings: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  evidence: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  blockers: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  artifactsWritten: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  submittedAt: Schema.Number,
})

const TrackSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  role: Schema.Literal(...TEAM_ROLES),
  assignedFiles: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  status: Schema.Literal("queued", "running", "awaitingVerification", "passed", "failed"),
  sessionID: Schema.optionalWith(NULLABLE_STRING, { default: () => null }),
  attempt: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  lastReport: Schema.optionalWith(Schema.NullOr(RoleReportSchema), { default: () => null }),
})

const MilestoneSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  status: Schema.Literal("pending", "inProgress", "verification", "passed", "failed"),
  tracks: Schema.optionalWith(Schema.Array(TrackSchema), { default: () => [] }),
  verificationAttempts: Schema.optionalWith(Schema.Number, { default: () => 0 }),
})

const SentinelUpdateSchema = Schema.Struct({
  message: Schema.String,
  timestamp: Schema.Number,
})

const UsageTrackerSchema = Schema.Struct({
  baseline: Schema.optionalWith(Schema.Unknown, { default: () => null }),
  lastObserved: Schema.optionalWith(Schema.Unknown, { default: () => null }),
  baseTokens: Schema.optionalWith(Schema.Unknown, { default: () => null }),
  pendingBaseline: Schema.optionalWith(Schema.Unknown, { default: () => null }),
  pendingBaseTokens: Schema.optionalWith(Schema.Unknown, { default: () => null }),
})

const ArtifactsSchema = Schema.Struct({
  brief: Schema.String,
  request: Schema.String,
  plan: Schema.String,
  progress: Schema.String,
})

const ProjectSchema = Schema.Struct({
  sessionID: Schema.String,
  slug: Schema.String,
  brief: BriefSchema,
  phase: Schema.Literal(
    "interview",
    "awaitingApproval",
    "executing",
    "paused",
    "budgetLimited",
    "complete",
    "cancelled",
  ),
  milestones: Schema.optionalWith(Schema.Array(MilestoneSchema), { default: () => [] }),
  activeMilestoneIndex: Schema.optionalWith(Schema.Number, { default: () => -1 }),
  artifacts: Schema.optionalWith(Schema.NullOr(ArtifactsSchema), { default: () => null }),
  workingDirectory: Schema.optionalWith(NULLABLE_STRING, { default: () => null }),
  tokenBudget: Schema.optionalWith(NULLABLE_NUMBER, { default: () => null }),
  tokensUsed: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  usageTrackers: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: UsageTrackerSchema }),
    { default: () => ({}) },
  ),
  timeUsedSeconds: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  lastAccountedAt: Schema.optionalWith(NULLABLE_NUMBER, { default: () => null }),
  sessionsSpawned: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  maxAutoTurns: Schema.optionalWith(NULLABLE_NUMBER, { default: () => null }),
  maxDurationSeconds: Schema.optionalWith(NULLABLE_NUMBER, { default: () => null }),
  maxParallelWorkers: Schema.optionalWith(Schema.Number, { default: () => DEFAULT_MAX_PARALLEL_WORKERS }),
  trackStallReminderSeconds: Schema.optionalWith(NULLABLE_NUMBER, {
    default: () => DEFAULT_TRACK_STALL_REMINDER_SECONDS,
  }),
  planPaused: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  sentinelUpdate: Schema.optionalWith(Schema.NullOr(SentinelUpdateSchema), { default: () => null }),
  history: Schema.optionalWith(Schema.Array(HistoryEntrySchema), { default: () => [] }),
  completionEvidence: Schema.optionalWith(NULLABLE_STRING, { default: () => null }),
  blocker: Schema.optionalWith(NULLABLE_STRING, { default: () => null }),
  closedAt: Schema.optionalWith(NULLABLE_NUMBER, { default: () => null }),
  stopReason: Schema.optionalWith(NULLABLE_STRING, { default: () => null }),
  lastStatus: Schema.optionalWith(NULLABLE_STRING, { default: () => null }),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

const StateSchema = Schema.Struct({
  version: Schema.Literal(2),
  projects: Schema.Record({ key: Schema.String, value: ProjectSchema }),
})

function defaultStateFile() {
  const dataHome =
    process.env.XDG_DATA_HOME ||
    (process.platform === "win32" && process.env.APPDATA ? process.env.APPDATA : join(homedir(), ".local", "share"))
  return join(dataHome, "opencode-teamwork", "projects.json")
}

export function statePath() {
  return process.env.OPENCODE_TEAMWORK_STATE_PATH || defaultStateFile()
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function emptyState(): State {
  return { version: 2, projects: {} }
}

function isMissingStateFile(error: unknown) {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT"
}

function mutableState(state: Schema.Schema.Type<typeof StateSchema>): State {
  return JSON.parse(JSON.stringify(state)) as State
}

const warnedEmptyStatePaths = new Set<string>()
export type StateRecoveryNotice = {
  stateFile: string
  quarantineFile: string
  outcome: "quarantined" | "quarantineFailed" | "sourceChanged"
  error?: string
}
type StateRecoveryListener = {
  stateFile: string
  report: (notice: StateRecoveryNotice) => Promise<void> | void
}
const stateRecoveryListeners = new Set<StateRecoveryListener>()

export function onStateRecovery(stateFile: string, report: StateRecoveryListener["report"]) {
  const listener = { stateFile, report }
  stateRecoveryListeners.add(listener)
  return () => stateRecoveryListeners.delete(listener)
}

function notifyStateRecovery(notice: StateRecoveryNotice) {
  for (const listener of stateRecoveryListeners) {
    if (listener.stateFile !== notice.stateFile) continue
    void Promise.resolve()
      .then(() => listener.report(notice))
      .catch((error) => {
        try {
          console.error(
            "[opencode-teamwork] Failed to report quarantined state:",
            error instanceof Error ? error.message : String(error),
          )
        } catch {
          // Reporting must never block state recovery.
        }
      })
  }
}

function isStatePadding(character: string) {
  return character === "\0" || character.trim() === ""
}

function parseStateText(raw: string, file: string) {
  let start = 0
  let end = raw.length
  while (start < end && isStatePadding(raw[start]!)) start += 1
  while (end > start && isStatePadding(raw[end - 1]!)) end -= 1
  const content = raw.slice(start, end)
  if (content) {
    try {
      return { value: JSON.parse(content) as unknown, recoveryContent: null }
    } catch {
      // Unparseable content (interrupted write, editor crash, encoding damage):
      // quarantine the raw bytes and recover with empty state instead of
      // hard-failing every project operation forever.
      if (!warnedEmptyStatePaths.has(file)) {
        warnedEmptyStatePaths.add(file)
        console.warn(`[opencode-teamwork] Unparseable state file at ${file}; quarantining and recovering with empty state.`)
      }
      return { value: emptyState(), recoveryContent: raw }
    }
  }

  if (!warnedEmptyStatePaths.has(file)) {
    warnedEmptyStatePaths.add(file)
    console.warn(`[opencode-teamwork] Empty or zero-filled state file at ${file}; recovering with empty state.`)
  }
  return { value: emptyState(), recoveryContent: raw || null }
}

function decodeState(value: unknown) {
  // Breaking change: v1 state (old plugin) is not supported. Start fresh
  // instead of failing every operation forever.
  if (typeof value === "object" && value !== null && (value as Record<string, unknown>).version === 1) {
    if (!warnedEmptyStatePaths.has("__v1__")) {
      warnedEmptyStatePaths.add("__v1__")
      console.warn("[opencode-teamwork] Unsupported v1 project state found; starting fresh (old projects are not migrated).")
      if (process.env.OPENCODE_TEAMWORK_DEBUG_V1) {
        try {
          console.warn(`[opencode-teamwork] v1 payload keys: ${Object.keys(value as object).join(",")}`)
          console.warn(`[opencode-teamwork] v1 payload: ${JSON.stringify(value).slice(0, 500)}`)
        } catch { /* ignore */ }
      }
    }
    return Effect.succeed(emptyState())
  }
  return Schema.decodeUnknown(StateSchema)(value).pipe(
    Effect.map(mutableState),
    Effect.map(normalizeState),
    Effect.mapError((cause) => new StateDecodeError({ cause })),
  )
}

function readStateResultEffect(file = statePath()) {
  return Effect.tryPromise({
    try: () => readFile(file, "utf8"),
    catch: (cause) => new StateReadError({ cause }),
  }).pipe(
    Effect.flatMap((raw) =>
      Effect.try({
        try: () => parseStateText(raw, file),
        catch: (cause) => new StateDecodeError({ cause }),
      }),
    ),
    Effect.flatMap(({ value, recoveryContent }) =>
      decodeState(value).pipe(Effect.map((state) => ({ state, recoveryContent }))),
    ),
    Effect.catchAll((error) =>
      error._tag === "StateReadError" && isMissingStateFile(error.cause)
        ? Effect.succeed({ state: emptyState(), recoveryContent: null })
        : Effect.fail(error),
    ),
  )
}

function readStateEffect(file = statePath()) {
  return readStateResultEffect(file).pipe(Effect.map(({ state }) => state))
}

function quarantineStateEffect(file: string, content: string) {
  return Effect.promise(async () => {
    const quarantineFile = `${file}.corrupt-${Date.now()}-${randomUUID()}`
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      await atomicWriteFile(quarantineFile, content)
      return { quarantineFile, error: null }
    } catch (error) {
      return { quarantineFile, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

function verifyRecoverySourceEffect(file: string, expectedContent: string, quarantineFile: string) {
  return Effect.promise(async () => {
    try {
      return (await readFile(file, "utf8")) === expectedContent
    } catch (error) {
      if (!isMissingStateFile(error)) {
        try {
          console.error(
            `[opencode-teamwork] Could not re-read ${file} after preserving it at ${quarantineFile}; continuing recovery:`,
            error instanceof Error ? error.message : String(error),
          )
        } catch {
          // Diagnostics must never block state recovery.
        }
      }
      return true
    }
  })
}

function writeStateEffect(state: State, file = statePath()) {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      await atomicWriteFile(file, JSON.stringify(state, null, 2) + "\n")
    },
    catch: (cause) => new StateWriteError({ cause }),
  })
}

async function readState(): Promise<State> {
  return Effect.runPromise(readStateEffect())
}

function readStateSync(): State {
  try {
    const file = statePath()
    const raw = readFileSync(file, "utf8")
    const parsed = parseStateText(raw, file).value
    if (typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>).version === 1) {
      return emptyState()
    }
    return normalizeState(mutableState(Schema.decodeUnknownSync(StateSchema)(parsed)))
  } catch (error) {
    if (isMissingStateFile(error)) return emptyState()
    throw error
  }
}

let mutationQueue: Promise<void> = Promise.resolve()

function enqueueMutation<T>(operation: () => Promise<T>) {
  const current = mutationQueue.then(operation, operation)
  mutationQueue = current.then(
    () => undefined,
    () => undefined,
  )
  return current
}

async function mutate<T>(fn: (state: State) => T | Promise<T>) {
  return enqueueMutation(() => {
    const file = statePath()
    return Effect.runPromise(
      Effect.gen(function* () {
        const { state, recoveryContent } = yield* readStateResultEffect(file)
        const result = yield* Effect.tryPromise({
          try: () => Promise.resolve(fn(state)),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        })
        if (recoveryContent != null) {
          const quarantine = yield* quarantineStateEffect(file, recoveryContent)
          if (quarantine.error != null) {
            const notice: StateRecoveryNotice = {
              stateFile: file,
              quarantineFile: quarantine.quarantineFile,
              outcome: "quarantineFailed",
              error: quarantine.error,
            }
            try {
              console.error(
                `[opencode-teamwork] Could not quarantine corrupt state at ${file}; continuing recovery:`,
                quarantine.error,
              )
            } catch {
              // Diagnostics must never block state recovery.
            }
            notifyStateRecovery(notice)
          } else {
            const unchanged = yield* verifyRecoverySourceEffect(file, recoveryContent, quarantine.quarantineFile)
            if (!unchanged) {
              const message = "project state changed while recovery was being quarantined; refusing to overwrite it"
              notifyStateRecovery({
                stateFile: file,
                quarantineFile: quarantine.quarantineFile,
                outcome: "sourceChanged",
                error: message,
              })
              return yield* Effect.fail(new StateWriteError({ cause: new Error(message) }))
            }
            try {
              console.warn(
                `[opencode-teamwork] Preserved corrupt state from ${file} at ${quarantine.quarantineFile}; continuing recovery.`,
              )
            } catch {
              // Diagnostics must never block state recovery.
            }
            notifyStateRecovery({
              stateFile: file,
              quarantineFile: quarantine.quarantineFile,
              outcome: "quarantined",
            })
          }
        }
        yield* writeStateEffect(state, file)
        return result
      }),
    )
  })
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeState(state: State): State {
  for (const project of Object.values(state.projects)) normalizeProject(project)
  return state
}

function normalizeBrief(brief: Brief): Brief {
  return {
    name: brief.name,
    objectives: brief.objectives,
    requirements: brief.requirements,
    verification: brief.verification,
    acceptanceCriteria: brief.acceptanceCriteria,
    integrityMode:
      brief.integrityMode === "demo" || brief.integrityMode === "benchmark" ? brief.integrityMode : "development",
    executionPath: normalizeExecutionPath((brief as { executionPath?: unknown }).executionPath),
    teamScale: normalizeTeamScale((brief as { teamScale?: unknown }).teamScale),
    deep: normalizeDeepFlag((brief as { deep?: unknown }).deep),
  }
}

function normalizeProject(project: Project) {
  project.phase = isPhase(project.phase) ? project.phase : "awaitingApproval"
  project.milestones = (project.milestones ?? []).map(normalizeMilestone)
  project.activeMilestoneIndex = nonNegativeIntegerOrNull(project.activeMilestoneIndex) ?? -1
  project.artifacts = project.artifacts ?? null
  project.workingDirectory = project.workingDirectory ?? null
  project.tokenBudget = positiveIntegerOrNull(project.tokenBudget)
  project.tokensUsed = nonNegativeInteger(project.tokensUsed, 0)
  project.usageTrackers = normalizeUsageTrackers(project.usageTrackers)
  project.timeUsedSeconds = nonNegativeInteger(project.timeUsedSeconds, 0)
  project.sessionsSpawned = nonNegativeInteger(project.sessionsSpawned, 0)
  project.maxAutoTurns = positiveIntegerOrNull(project.maxAutoTurns)
  project.maxDurationSeconds = positiveIntegerOrNull(project.maxDurationSeconds)
  project.maxParallelWorkers = clampParallelWorkers(project.maxParallelWorkers)
  project.brief = normalizeBrief(project.brief)
  const stall = (project as { trackStallReminderSeconds?: unknown }).trackStallReminderSeconds
  project.trackStallReminderSeconds =
    stall === null ? null : positiveIntegerOrNull(stall) ?? DEFAULT_TRACK_STALL_REMINDER_SECONDS
  project.planPaused = project.planPaused === true
  project.history = (project.history ?? []).slice(-MAX_HISTORY_ENTRIES)
  project.completionEvidence = project.completionEvidence ?? null
  project.blocker = project.blocker ?? null
  project.closedAt = project.closedAt ?? null
  project.stopReason = project.stopReason ?? null
  project.lastStatus = project.lastStatus ?? null
  return project
}

function normalizeMilestone(milestone: Milestone): Milestone {
  milestone.tracks = (milestone.tracks ?? []).map(normalizeTrack)
  milestone.verificationAttempts = nonNegativeInteger(milestone.verificationAttempts, 0)
  return milestone
}

function normalizeTrack(track: Track): Track {
  track.assignedFiles = track.assignedFiles ?? []
  track.sessionID = track.sessionID ?? null
  track.attempt = nonNegativeInteger(track.attempt, 0)
  track.lastReport = track.lastReport ?? null
  return track
}

function normalizeUsageTrackers(trackers: Record<string, UsageTracker> | undefined) {
  const normalized: Record<string, UsageTracker> = {}
  for (const [source, rawTracker] of Object.entries(trackers ?? {})) {
    const tracker = rawTracker as Partial<UsageTracker>
    const baseline = nonNegativeIntegerOrNull(tracker?.baseline)
    const lastObserved = nonNegativeIntegerOrNull(tracker?.lastObserved)
    const baseTokens = nonNegativeIntegerOrNull(tracker?.baseTokens)
    if (source && baseline != null && lastObserved != null && baseTokens != null && lastObserved >= baseline) {
      const pendingBaseline = nonNegativeIntegerOrNull(tracker.pendingBaseline)
      const pendingBaseTokens = nonNegativeIntegerOrNull(tracker.pendingBaseTokens)
      normalized[source] = {
        baseline,
        lastObserved,
        baseTokens,
        pendingBaseline,
        pendingBaseTokens: pendingBaseline == null ? null : pendingBaseTokens,
      }
    }
  }
  return normalized
}

function positiveIntegerOrNull(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null
}

function nonNegativeInteger(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function nonNegativeIntegerOrNull(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

const PHASES: Phase[] = [
  "interview",
  "awaitingApproval",
  "executing",
  "paused",
  "budgetLimited",
  "complete",
  "cancelled",
]

function isPhase(value: unknown): value is Phase {
  return typeof value === "string" && (PHASES as string[]).includes(value)
}

function isClosed(phase: Phase) {
  return phase === "complete" || phase === "cancelled"
}

function isExecuting(phase: Phase) {
  return phase === "executing"
}

function remainingTokens(project: Project) {
  return project.tokenBudget == null ? null : Math.max(0, project.tokenBudget - project.tokensUsed)
}

function summarizeText(text: string, limit = CHECKPOINT_CHAR_LIMIT) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return ""
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}...` : normalized
}

function pushHistory(project: Project, type: ProjectHistoryType, detail: string | null | undefined) {
  const value = summarizeText(detail ?? "", 400)
  if (!value) return
  project.history = [...project.history, { type, detail: value, timestamp: nowSeconds() }].slice(-MAX_HISTORY_ENTRIES)
}

function accountWallClock(project: Project, now = nowSeconds()) {
  if (!isExecuting(project.phase)) return
  if (project.lastAccountedAt == null) {
    project.lastAccountedAt = now
    return
  }
  project.timeUsedSeconds += Math.max(0, now - project.lastAccountedAt)
  project.lastAccountedAt = now
}

function maybeStopForBudget(project: Project) {
  if (!isExecuting(project.phase)) return false
  if (project.tokenBudget == null || project.tokensUsed < project.tokenBudget) return false
  accountWallClock(project)
  project.phase = "budgetLimited"
  project.lastAccountedAt = null
  project.stopReason = `token budget reached (${project.tokensUsed}/${project.tokenBudget})`
  project.lastStatus = `${project.stopReason}; wrap-up required.`
  pushHistory(project, "limited", project.lastStatus)
  return true
}

function maybeStopForUsageLimit(project: Project, now = nowSeconds()) {
  if (!isExecuting(project.phase)) return false
  if (project.maxAutoTurns != null && project.sessionsSpawned >= project.maxAutoTurns) {
    accountWallClock(project)
    project.phase = "budgetLimited"
    project.lastAccountedAt = null
    project.stopReason = `max team sessions reached (${project.maxAutoTurns})`
    project.lastStatus = `${project.stopReason}; wrap-up required.`
    pushHistory(project, "limited", project.lastStatus)
    project.updatedAt = now
    return true
  }
  if (project.maxDurationSeconds != null && project.timeUsedSeconds >= project.maxDurationSeconds) {
    accountWallClock(project)
    project.phase = "budgetLimited"
    project.lastAccountedAt = null
    project.stopReason = `max duration reached (${project.maxDurationSeconds}s)`
    project.lastStatus = `${project.stopReason}; wrap-up required.`
    pushHistory(project, "limited", project.lastStatus)
    project.updatedAt = now
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export type ProjectSnapshot = Project & {
  remainingTokens: number | null
  sampledAt: number
}

export type TrackLocation = {
  projectSessionID: string
  milestoneIndex: number
  trackID: string
  role: TeamRole
  trackStatus: TrackStatus
}

export function snapshot(project: Project): ProjectSnapshot {
  normalizeProject(project)
  const sampledAt = nowSeconds()
  const activeSeconds =
    isExecuting(project.phase) && project.lastAccountedAt != null
      ? Math.max(0, sampledAt - project.lastAccountedAt)
      : 0
  return {
    ...project,
    timeUsedSeconds: project.timeUsedSeconds + activeSeconds,
    remainingTokens: remainingTokens(project),
    sampledAt,
  }
}

export function findTrackBySession(project: Project, roleSessionID: string): TrackLocation | null {
  for (let milestoneIndex = 0; milestoneIndex < project.milestones.length; milestoneIndex += 1) {
    const milestone = project.milestones[milestoneIndex]!
    for (const track of milestone.tracks) {
      if (track.sessionID === roleSessionID) {
        return {
          projectSessionID: project.sessionID,
          milestoneIndex,
          trackID: track.id,
          role: track.role,
          trackStatus: track.status,
        }
      }
    }
  }
  return null
}

/** Finds the project that owns a role session (or that is the main session). */
export async function locateProjectByRoleSession(roleSessionID: string) {
  const state = await readState()
  for (const project of Object.values(state.projects)) {
    if (project.sessionID === roleSessionID) {
      return { snapshot: snapshot(project), location: null }
    }
    const location = findTrackBySession(project, roleSessionID)
    if (location) return { snapshot: snapshot(project), location }
  }
  return null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const MAX_TEXT_CHARS = 100_000
const MAX_SLUG_LENGTH = 80

function boundedText(value: string, label: string, limit = MAX_TEXT_CHARS) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} must not be empty`)
  if ([...trimmed].length > limit) throw new Error(`${label} must be at most ${limit} characters`)
  return trimmed
}

export function normalizeSlug(name: string) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "")
  if (!slug) throw new Error("project name must contain usable characters (letters, digits, or CJK)")
  return slug
}

export async function getProject(sessionID: string) {
  const state = await readState()
  const project = state.projects[sessionID]
  return project ? snapshot(project) : null
}

export function getProjectSync(sessionID: string) {
  const state = readStateSync()
  const project = state.projects[sessionID]
  return project ? snapshot(project) : null
}

export async function getAllProjects() {
  const state = await readState()
  return Object.values(state.projects)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map(snapshot)
}

/** Commits the Phase 1 brief as a project awaiting approval. */
export async function createProject(
  sessionID: string,
  brief: Brief,
  options?: CreateProjectOptions,
  agent?: string | null,
) {
  const normalizedBrief: Brief = normalizeBrief({
    name: normalizeSlug(boundedText(brief.name, "project name", 200)),
    objectives: boundedText(brief.objectives, "project objectives"),
    requirements: boundedText(brief.requirements, "project requirements"),
    verification: boundedText(brief.verification, "project verification"),
    acceptanceCriteria: boundedText(brief.acceptanceCriteria, "acceptance criteria"),
    integrityMode: brief.integrityMode,
    executionPath: (brief as { executionPath?: unknown }).executionPath as ExecutionPath,
    teamScale: (brief as { teamScale?: unknown }).teamScale as TeamScale | null,
    deep: (brief as { deep?: unknown }).deep as boolean,
  })
  const workingDirectory =
    typeof options?.workingDirectory === "string" && options.workingDirectory.trim()
      ? options.workingDirectory.trim()
      : null
  return mutate((state) => {
    const existing = state.projects[sessionID]
    if (existing && !isClosed(existing.phase) && existing.phase !== "interview") {
      throw new Error("cannot create a new project because this session already has a non-closed project")
    }
    const now = nowSeconds()
    const project: Project = {
      sessionID,
      slug: normalizedBrief.name,
      brief: normalizedBrief,
      phase: "awaitingApproval",
      milestones: [],
      activeMilestoneIndex: -1,
      artifacts: null,
      workingDirectory,
      tokenBudget: positiveIntegerOrNull(options?.tokenBudget),
      tokensUsed: 0,
      usageTrackers: {},
      timeUsedSeconds: 0,
      lastAccountedAt: null,
      sessionsSpawned: 0,
      maxAutoTurns: positiveIntegerOrNull(options?.maxAutoTurns),
      maxDurationSeconds: positiveIntegerOrNull(options?.maxDurationSeconds),
      maxParallelWorkers: clampParallelWorkers(options?.maxParallelWorkers),
      trackStallReminderSeconds:
        options?.trackStallReminderSeconds === null
          ? null
          : (positiveIntegerOrNull(options?.trackStallReminderSeconds) ?? DEFAULT_TRACK_STALL_REMINDER_SECONDS),
      planPaused: false,
      sentinelUpdate: null,
      history: [],
      completionEvidence: null,
      blocker: null,
      closedAt: null,
      stopReason: null,
      lastStatus: "Project created from the scoping interview; awaiting approval.",
      createdAt: now,
      updatedAt: now,
    }
    pushHistory(project, "created", `Project "${project.slug}" created; awaiting approval.`)
    pushHistory(project, "artifact", "Prompt artifact committed from the Phase 1 interview.")
    if (agent) {
      // agent is recorded through the server's own hooks; nothing to persist here.
    }
    state.projects[sessionID] = project
    return snapshot(project)
  })
}

/** Replaces the brief while still awaiting approval (after /teamwork-revise). */
export async function updateProjectBrief(sessionID: string, brief: Brief) {
  const normalizedBrief: Brief = normalizeBrief({
    name: normalizeSlug(boundedText(brief.name, "project name", 200)),
    objectives: boundedText(brief.objectives, "project objectives"),
    requirements: boundedText(brief.requirements, "project requirements"),
    verification: boundedText(brief.verification, "project verification"),
    acceptanceCriteria: boundedText(brief.acceptanceCriteria, "acceptance criteria"),
    integrityMode: brief.integrityMode,
    executionPath: (brief as { executionPath?: unknown }).executionPath as ExecutionPath,
    teamScale: (brief as { teamScale?: unknown }).teamScale as TeamScale | null,
    deep: (brief as { deep?: unknown }).deep as boolean,
  })
  return mutate((state) => {
    const project = state.projects[sessionID]
    if (!project) throw new Error("cannot revise the project because this session has no project")
    if (isClosed(project.phase)) throw new Error("cannot revise the project because it is closed")
    if (project.phase !== "awaitingApproval") {
      throw new Error("the project brief can only be revised while awaiting approval")
    }
    project.brief = normalizedBrief
    project.slug = normalizedBrief.name
    project.updatedAt = nowSeconds()
    project.lastStatus = "Project brief revised; awaiting approval."
    pushHistory(project, "updated", `Project brief revised for "${project.slug}".`)
    return snapshot(project)
  })
}

/**
 * Suspends wall-clock accounting during permission waits so approval latency
 * does not consume the project's duration budget. The next accounting call
 * re-anchors the timer without accruing the gap.
 */
export async function suspendTimerForPermission(sessionID: string) {
  return mutate((state) => {
    const project = state.projects[sessionID]
    if (!project) return null
    if (!isExecuting(project.phase)) return snapshot(project)
    accountWallClock(project)
    project.lastAccountedAt = null
    project.updatedAt = nowSeconds()
    pushHistory(project, "warning", "Permission wait started; wall-clock timer suspended.")
    return snapshot(project)
  })
}

/** Submits a report against a track ID (flat-topology path has no role session). */
export async function submitTrackReportByID(
  projectSessionID: string,
  milestoneIndex: number,
  trackID: string,
  report: Omit<RoleReport, "submittedAt">,
) {
  const normalizedReport: RoleReport = {
    role: report.role,
    verdict: report.verdict,
    findings: (report.findings ?? []).map((item) => boundedText(item, "report finding", 2000)).slice(0, 50),
    evidence: (report.evidence ?? []).map((item) => boundedText(item, "report evidence", 2000)).slice(0, 50),
    blockers: (report.blockers ?? []).map((item) => boundedText(item, "report blocker", 2000)).slice(0, 20),
    artifactsWritten: (report.artifactsWritten ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 100),
    submittedAt: nowSeconds(),
  }
  return mutate((state) => {
    const project = state.projects[projectSessionID]
    if (!project) throw new Error("cannot submit the report because the project does not exist")
    const milestone = project.milestones[milestoneIndex]
    if (!milestone) throw new Error("cannot submit the report because the milestone does not exist")
    const track = milestone.tracks.find((candidate) => candidate.id === trackID)
    if (!track) throw new Error("cannot submit the report because the track does not exist")
    track.lastReport = normalizedReport
    track.status = normalizedReport.verdict === "pass" ? "passed" : normalizedReport.verdict === "fail" ? "failed" : track.status
    project.lastStatus = `${track.role} reported: ${normalizedReport.verdict}`
    project.updatedAt = nowSeconds()
    pushHistory(project, "verification", `${track.role} (${milestone.id}) reported ${normalizedReport.verdict}`)
    return snapshot(project)
  })
}

export async function setProjectArtifacts(
  sessionID: string,
  artifacts: { brief: string; request: string; plan: string; progress: string },
) {
  return mutate((state) => {
    const project = state.projects[sessionID]
    if (!project) throw new Error("cannot record artifacts because this session has no project")
    project.artifacts = artifacts
    project.updatedAt = nowSeconds()
    return snapshot(project)
  })
}

/** Approves the project: awaitingApproval -> executing. */
export async function approveProject(sessionID: string, options?: { planPaused?: boolean }) {
  return mutate((state) => {
    const project = state.projects[sessionID]
    if (!project) throw new Error("cannot approve because this session has no project")
    if (isClosed(project.phase)) throw new Error("cannot approve because this project is closed")
    if (project.phase !== "awaitingApproval") {
      throw new Error("the project is not awaiting approval")
    }
    const now = nowSeconds()
    project.phase = "executing"
    project.planPaused = options?.planPaused === true
    project.lastAccountedAt = project.planPaused ? null : now
    project.lastStatus = project.planPaused
      ? "Project approved; execution paused until the session leaves Plan mode."
      : "Project approved; the team is starting."
    project.updatedAt = now
    pushHistory(project, "approved", project.lastStatus)
    if (project.planPaused) pushHistory(project, "paused", project.lastStatus)
    return snapshot(project)
  })
}

/** Resumes from paused or plan-paused states back to executing. */
export async function resumeProject(sessionID: string) {
  return mutate((state) => {
    const project = state.projects[sessionID]
    if (!project) throw new Error("cannot resume because this session has no project")
    if (isClosed(project.phase)) throw new Error("cannot resume because this project is closed")
    if (project.phase !== "paused") {
      throw new Error("the project is not paused")
    }
    const now = nowSeconds()
    project.phase = "executing"
    project.planPaused = false
    project.lastAccountedAt = now
    project.stopReason = null
    project.blocker = null
    project.lastStatus = "Project resumed; the team continues."
    project.updatedAt = now
    pushHistory(project, "resumed", project.lastStatus)
    return snapshot(project)
  })
}

/** Pauses the project from executing; records the reason. */
export async function pauseProject(sessionID: string, reason: string | null | undefined, options?: {
  planPaused?: boolean
  stopReason?: string | null
  blocker?: string | null
  historyType?: ProjectHistoryType
}) {
  return mutate((state) => {
    const project = state.projects[sessionID]
    if (!project) throw new Error("cannot pause because this session has no project")
    if (project.phase !== "executing" && project.phase !== "budgetLimited") {
      throw new Error("the project is not executing")
    }
    const now = nowSeconds()
    accountWallClock(project, now)
    project.phase = "paused"
    project.lastAccountedAt = null
    project.stopReason = options?.stopReason ?? (reason?.trim() ? reason.trim() : "paused")
    project.blocker = options?.blocker ?? (summarizeText(reason ?? "", 400) || null)
    project.planPaused = options?.planPaused === true
    project.lastStatus = summarizeText(reason ?? "Project paused.", 400)
    project.updatedAt = now
    pushHistory(project, options?.historyType ?? "paused", project.lastStatus)
    return snapshot(project)
  })
}

/** Marks the plan-paused flag while executing (session entered Plan mode). */
export async function markProjectPlanPaused(sessionID: string, planPaused: boolean) {
  return mutate((state) => {
    const project = state.projects[sessionID]
    if (!project || project.phase !== "executing") return project ? snapshot(project) : null
    if (project.planPaused === planPaused) return snapshot(project)
    project.planPaused = planPaused
    if (planPaused) {
      project.stopReason = "plan mode"
      project.blocker =
        "The team is paused because the session entered Plan mode. Switch to Build mode and resume the project."
      project.lastStatus = "Team paused while the session is in Plan mode."
      pushHistory(project, "paused", project.lastStatus)
    }
    project.updatedAt = nowSeconds()
    return snapshot(project)
  })
}

export async function cancelProject(sessionID: string, reason?: string | null) {
  return mutate((state) => {
    const project = state.projects[sessionID]
    if (!project) return false
    if (isClosed(project.phase)) return false
    const now = nowSeconds()
    accountWallClock(project, now)
    project.phase = "cancelled"
    project.closedAt = now
    project.lastAccountedAt = null
    project.blocker = summarizeText(reason ?? "Cancelled by the user.", 400) || null
    project.stopReason = "cancelled"
    project.lastStatus = "Project cancelled."
    project.updatedAt = now
    pushHistory(project, "cancelled", project.blocker ?? "Cancelled.")
    return true
  })
}

export async function completeProject(sessionID: string, evidence: string) {
  const value = boundedText(evidence, "completion evidence")
  return mutate((state) => {
    const project = state.projects[sessionID]
    if (!project) throw new Error("cannot complete because this session has no project")
    if (isClosed(project.phase)) throw new Error("cannot complete because this project is closed")
    const now = nowSeconds()
    accountWallClock(project, now)
    project.phase = "complete"
    project.closedAt = now
    project.lastAccountedAt = null
    project.completionEvidence = value
    project.blocker = null
    project.stopReason = null
    project.lastStatus = "Project completed."
    project.updatedAt = now
    pushHistory(project, "completed", value)
    return snapshot(project)
  })
}

/** Records the Orchestrator's milestone plan (Phase 2 kickoff / re-plan). */
export async function setMilestonePlan(
  sessionID: string,
  milestones: Array<Pick<Milestone, "title" | "description"> & { tracks: Array<Pick<Track, "title" | "role" | "assignedFiles">> }>,
) {
  return mutate((state) => {
    const project = state.projects[sessionID]
    if (!project) throw new Error("cannot record the plan because this session has no project")
    if (project.phase !== "executing") throw new Error("the plan can only be recorded while executing")
    if (!Array.isArray(milestones) || milestones.length === 0) {
      throw new Error("the milestone plan must contain at least one milestone")
    }
    const now = nowSeconds()
    project.milestones = milestones.map((milestone, milestoneIndex) => ({
      id: `m${milestoneIndex + 1}`,
      title: boundedText(milestone.title, "milestone title", 500),
      description: boundedText(milestone.description, "milestone description"),
      status: "pending",
      verificationAttempts: 0,
      tracks: (milestone.tracks ?? []).map((track, trackIndex) => ({
        id: `m${milestoneIndex + 1}t${trackIndex + 1}`,
        title: boundedText(track.title, "track title", 500),
        role: track.role,
        assignedFiles: Array.isArray(track.assignedFiles) ? track.assignedFiles.map(String) : [],
        status: "queued",
        sessionID: null,
        attempt: 0,
        lastReport: null,
      })),
    }))
    project.activeMilestoneIndex = 0
    project.lastStatus = `Milestone plan recorded (${project.milestones.length} milestones).`
    project.updatedAt = now
    pushHistory(project, "milestone", project.lastStatus)
    return snapshot(project)
  })
}

/** Registers a role session against a queued track (or an ad-hoc role task). */
export async function assignTrackSession(
  projectSessionID: string,
  milestoneIndex: number,
  trackID: string,
  roleSessionID: string,
) {
  return mutate((state) => {
    const project = state.projects[projectSessionID]
    if (!project) throw new Error("cannot assign a session because the project does not exist")
    const milestone = project.milestones[milestoneIndex]
    if (!milestone) throw new Error("cannot assign a session because the milestone does not exist")
    const track = milestone.tracks.find((candidate) => candidate.id === trackID)
    if (!track) throw new Error("cannot assign a session because the track does not exist")
    track.sessionID = roleSessionID
    track.status = "running"
    track.attempt += 1
    track.lastReport = null
    project.sessionsSpawned += 1
    project.updatedAt = nowSeconds()
    maybeStopForUsageLimit(project)
    return snapshot(project)
  })
}

/** Registers an ad-hoc role task that has no plan track (e.g. Orchestrator itself). */
export async function recordAdhocSession(projectSessionID: string, role: TeamRole, roleSessionID: string) {
  return mutate((state) => {
    const project = state.projects[projectSessionID]
    if (!project) throw new Error("cannot record the session because the project does not exist")
    const index = project.activeMilestoneIndex >= 0 ? project.activeMilestoneIndex : 0
    const milestone = project.milestones[index]
    if (milestone) {
      milestone.tracks.push({
        id: `adhoc-${role}-${roleSessionID.slice(0, 8)}`,
        title: `Ad-hoc ${role} task`,
        role,
        assignedFiles: [],
        status: "running",
        sessionID: roleSessionID,
        attempt: 1,
        lastReport: null,
      })
    }
    project.sessionsSpawned += 1
    project.updatedAt = nowSeconds()
    maybeStopForUsageLimit(project)
    return snapshot(project)
  })
}

/** Marks a track's role session as finished without a submitted report. */
export async function failTrackSession(roleSessionID: string, reason: string) {
  return mutate((state) => {
    for (const project of Object.values(state.projects)) {
      const location = findTrackBySession(project, roleSessionID)
      if (!location) continue
      const milestone = project.milestones[location.milestoneIndex]!
      const track = milestone.tracks.find((candidate) => candidate.id === location.trackID)!
      track.status = "failed"
      project.lastStatus = `${track.role} session failed: ${summarizeText(reason, 200)}`
      project.updatedAt = nowSeconds()
      pushHistory(project, "error", project.lastStatus)
      return snapshot(project)
    }
    return null
  })
}

/** Applies a structured report submitted through the teamwork_report tool. */
export async function submitTrackReport(roleSessionID: string, report: Omit<RoleReport, "submittedAt">) {
  const normalizedReport: RoleReport = {
    role: report.role,
    verdict: report.verdict,
    findings: (report.findings ?? []).map((item) => boundedText(item, "report finding", 2000)).slice(0, 50),
    evidence: (report.evidence ?? []).map((item) => boundedText(item, "report evidence", 2000)).slice(0, 50),
    blockers: (report.blockers ?? []).map((item) => boundedText(item, "report blocker", 2000)).slice(0, 20),
    artifactsWritten: (report.artifactsWritten ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 100),
    submittedAt: nowSeconds(),
  }
  return mutate((state) => {
    for (const project of Object.values(state.projects)) {
      const location = findTrackBySession(project, roleSessionID)
      if (!location) continue
      const milestone = project.milestones[location.milestoneIndex]!
      const track = milestone.tracks.find((candidate) => candidate.id === location.trackID)!
      track.lastReport = normalizedReport
      track.status = normalizedReport.verdict === "pass" ? "passed" : normalizedReport.verdict === "fail" ? "failed" : track.status
      if (track.status === "passed" && (track.role === "explorer" || track.role === "worker")) {
        // Implementation/research tracks that pass stay "passed"; verification
        // roles drive milestone status through the state machine.
      }
      project.lastStatus = `${track.role} reported: ${normalizedReport.verdict}`
      project.updatedAt = nowSeconds()
      pushHistory(project, "verification", `${track.role} (${milestone.id}) reported ${normalizedReport.verdict}`)
      return snapshot(project)
    }
    return null
  })
}

export async function setSentinelUpdate(sessionID: string, message: string) {
  const value = boundedText(message, "sentinel update", 2000)
  return mutate((state) => {
    const project = state.projects[sessionID]
    if (!project) throw new Error("cannot record the update because this session has no project")
    project.sentinelUpdate = { message: value, timestamp: nowSeconds() }
    project.updatedAt = nowSeconds()
    return snapshot(project)
  })
}

export async function setMilestoneStatus(
  sessionID: string,
  milestoneIndex: number,
  status: MilestoneStatus,
) {
  return mutate((state) => {
    const project = state.projects[sessionID]
    if (!project) throw new Error("cannot update the milestone because this session has no project")
    const milestone = project.milestones[milestoneIndex]
    if (!milestone) throw new Error("cannot update the milestone because it does not exist")
    milestone.status = status
    if (status === "passed") {
      project.activeMilestoneIndex = Math.min(milestoneIndex + 1, project.milestones.length - 1)
      if (milestoneIndex === project.milestones.length - 1) project.activeMilestoneIndex = milestoneIndex
    }
    project.updatedAt = nowSeconds()
    pushHistory(project, "milestone", `${milestone.id} (${milestone.title}) -> ${status}`)
    return snapshot(project)
  })
}

export async function recordVerificationAttempt(sessionID: string, milestoneIndex: number) {
  return mutate((state) => {
    const project = state.projects[sessionID]
    if (!project) throw new Error("cannot record the attempt because this session has no project")
    const milestone = project.milestones[milestoneIndex]
    if (!milestone) throw new Error("cannot record the attempt because the milestone does not exist")
    milestone.verificationAttempts += 1
    project.updatedAt = nowSeconds()
    pushHistory(
      project,
      "verification",
      `${milestone.id} verification attempt ${milestone.verificationAttempts}`,
    )
    return snapshot(project)
  })
}

export async function accountProjectUsage(
  sessionID: string,
  tokensUsed?: number,
  options?: { cumulative?: boolean; source?: string; initialBaseline?: number },
) {
  return mutate((state) => {
    const project = state.projects[sessionID]
    if (!project) return null
    accountWallClock(project)
    if (typeof tokensUsed === "number" && Number.isFinite(tokensUsed)) {
      const observed = Math.max(0, Math.ceil(tokensUsed))
      if (options?.cumulative === true) {
        const source = options.source?.trim() || "default"
        let tracker = project.usageTrackers[source]
        if (!tracker) {
          const initialBaseline = nonNegativeIntegerOrNull(options.initialBaseline)
          tracker = {
            baseline: initialBaseline != null && initialBaseline <= observed ? initialBaseline : observed,
            lastObserved: observed,
            baseTokens: project.tokensUsed,
            pendingBaseline: null,
            pendingBaseTokens: null,
          }
          project.usageTrackers[source] = tracker
        } else if (observed < tracker.lastObserved) {
          const initialBaseline = nonNegativeIntegerOrNull(options.initialBaseline)
          if (initialBaseline != null && initialBaseline <= observed) {
            tracker = {
              baseline: initialBaseline,
              lastObserved: observed,
              baseTokens: project.tokensUsed,
              pendingBaseline: null,
              pendingBaseTokens: null,
            }
            project.usageTrackers[source] = tracker
          } else if (tracker.pendingBaseline == null || observed < tracker.pendingBaseline) {
            tracker.pendingBaseline = observed
            tracker.pendingBaseTokens = project.tokensUsed
          } else {
            tracker = {
              baseline: tracker.pendingBaseline,
              lastObserved: observed,
              baseTokens: tracker.pendingBaseTokens ?? project.tokensUsed,
              pendingBaseline: null,
              pendingBaseTokens: null,
            }
            project.usageTrackers[source] = tracker
          }
        } else {
          tracker.lastObserved = observed
          tracker.pendingBaseline = null
          tracker.pendingBaseTokens = null
        }
        project.tokensUsed = Math.max(project.tokensUsed, tracker.baseTokens + observed - tracker.baseline)
      } else {
        project.tokensUsed = Math.max(project.tokensUsed, observed)
      }
    }
    maybeStopForBudget(project)
    project.updatedAt = nowSeconds()
    return snapshot(project)
  })
}

/** Usage accounting for a role session, attributed to its owning project. */
export async function accountRoleSessionUsage(
  roleSessionID: string,
  tokensUsed?: number,
  options?: { cumulative?: boolean; source?: string; initialBaseline?: number },
) {
  const state = await readState()
  for (const project of Object.values(state.projects)) {
    if (project.sessionID === roleSessionID) {
      return accountProjectUsage(project.sessionID, tokensUsed, options)
    }
  }
  // Role sessions are located by scanning; a second read inside mutate is
  // serialized by the mutation queue so this stays consistent.
  return mutate((state) => {
    for (const project of Object.values(state.projects)) {
      if (!findTrackBySession(project, roleSessionID)) continue
      if (!isExecuting(project.phase)) return snapshot(project)
      accountWallClock(project)
      if (typeof tokensUsed === "number" && Number.isFinite(tokensUsed)) {
        const observed = Math.max(0, Math.ceil(tokensUsed))
        const source = `${roleSessionID}:${options?.source?.trim() || "default"}`
        let tracker = project.usageTrackers[source]
        if (!tracker) {
          const initialBaseline = nonNegativeIntegerOrNull(options?.initialBaseline)
          tracker = {
            baseline: initialBaseline != null && initialBaseline <= observed ? initialBaseline : observed,
            lastObserved: observed,
            baseTokens: project.tokensUsed,
            pendingBaseline: null,
            pendingBaseTokens: null,
          }
          project.usageTrackers[source] = tracker
        } else if (observed >= tracker.lastObserved) {
          tracker.lastObserved = observed
          tracker.pendingBaseline = null
          tracker.pendingBaseTokens = null
        }
        project.tokensUsed = Math.max(project.tokensUsed, tracker.baseTokens + observed - tracker.baseline)
      }
      maybeStopForBudget(project)
      project.updatedAt = nowSeconds()
      return snapshot(project)
    }
    return null
  })
}

export function estimateTokensFromText(text: string) {
  return Math.ceil(text.length / 4)
}

export function formatProject(project: ProjectSnapshot | null) {
  if (!project) return "No Teamwork project is set for this session."
  const lines = [
    `Project: ${project.slug}`,
    `Phase: ${project.phase}`,
    `Path: ${project.brief.executionPath}`,
    `Integrity mode: ${project.brief.integrityMode}`,
    `Speed knobs: workers=${project.maxParallelWorkers}, team=${project.brief.teamScale ?? "default"}, deep=${project.brief.deep ? "on" : "off"}`,
    `Milestones: ${project.milestones.length}${
      project.activeMilestoneIndex >= 0 ? ` (active: m${project.activeMilestoneIndex + 1})` : ""
    }`,
    `Time used: ${project.timeUsedSeconds}s`,
    `Tokens used: ${project.tokensUsed}${project.tokenBudget == null ? "" : `/${project.tokenBudget}`}`,
  ]
  if (project.remainingTokens != null) lines.push(`Tokens remaining: ${project.remainingTokens}`)
  if (project.maxDurationSeconds != null) lines.push(`Duration limit: ${project.maxDurationSeconds}s`)
  if (project.artifacts) {
    lines.push(`Brief artifact: ${project.artifacts.brief}`)
    lines.push(`Request artifact: ${project.artifacts.request}`)
    lines.push(`Plan artifact: ${project.artifacts.plan}`)
    lines.push(`Progress artifact: ${project.artifacts.progress}`)
  }
  if (project.sentinelUpdate) {
    lines.push(`Latest Sentinel update: ${project.sentinelUpdate.message}`)
  }
  if (project.lastStatus) lines.push(`Last status: ${project.lastStatus}`)
  if (project.stopReason) lines.push(`Stop reason: ${project.stopReason}`)
  if (project.completionEvidence) lines.push(`Completion evidence: ${project.completionEvidence}`)
  if (project.blocker) lines.push(`Blocker: ${project.blocker}`)
  return lines.join("\n")
}

export function formatProjectDetail(project: ProjectSnapshot | null) {
  if (!project) return "No Teamwork project is set for this session."
  const lines = [formatProject(project)]
  if (project.milestones.length > 0) {
    lines.push("", "Milestones:")
    project.milestones.forEach((milestone, index) => {
      lines.push(`- ${milestone.id} [${milestone.status}] ${milestone.title}`)
      for (const track of milestone.tracks) {
        const files = track.assignedFiles.length > 0 ? ` files: ${track.assignedFiles.join(", ")}` : ""
        lines.push(`  - ${track.id} [${track.status}] (${track.role}) ${track.title}${files}`)
        if (track.lastReport) {
          lines.push(
            `    verdict: ${track.lastReport.verdict}; findings: ${track.lastReport.findings.length}; evidence: ${track.lastReport.evidence.length}`,
          )
        }
      }
      if (index === 4) lines.push("- ... (truncated)")
    })
  }
  if (project.history.length > 0) {
    lines.push("", "Recent history:")
    for (const entry of project.history.slice(-8)) {
      lines.push(`- [${new Date(entry.timestamp * 1000).toISOString()}] ${entry.type}: ${entry.detail}`)
    }
  }
  return lines.join("\n")
}
