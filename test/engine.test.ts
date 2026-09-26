import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TeamEngine, TEAMWORK_TITLE_PREFIX } from "../src/engine"
import type { PlanMilestoneInput, ReportPayload, SessionOps } from "../src/engine"
import { approveProject, cancelProject, createProject, getProject, submitTrackReport } from "../src/state"

let stateDir: string
let originalStatePath: string | undefined

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "opencode-teamwork-engine-"))
  originalStatePath = process.env.OPENCODE_TEAMWORK_STATE_PATH
  process.env.OPENCODE_TEAMWORK_STATE_PATH = join(stateDir, "projects.json")
})

afterEach(async () => {
  if (originalStatePath === undefined) delete process.env.OPENCODE_TEAMWORK_STATE_PATH
  else process.env.OPENCODE_TEAMWORK_STATE_PATH = originalStatePath
  await rm(stateDir, { recursive: true, force: true })
})

const BRIEF = {
  name: "Engine Test",
  objectives: "Build the thing.",
  requirements: "It must work.",
  verification: "npm test passes.",
  acceptanceCriteria: "All tests green.",
  integrityMode: "development" as const,
  artifactLocale: "en" as const,
}

type FakeSession = {
  id: string
  agent: string
  title: string
  prompts: string[]
}

/**
 * Deterministic fake session ops. Role sessions submit their scripted outcome
 * on a macrotask after being prompted, which guarantees the engine has already
 * installed its report waiter (microtask ordering).
 */
function makeFake() {
  const sessions = new Map<string, FakeSession>()
  /** Survives removeSession so tests can inspect what was created. */
  const created: Array<{ agent: string; title: string }> = []
  let counter = 0
  const planByProject = new Map<string, PlanMilestoneInput[]>()
  const verdictByRole = new Map<string, "pass" | "fail">()
  const engineRef: { engine?: TeamEngine } = {}

  const ops: SessionOps = {
    async createSession({ agent, title }) {
      const id = `role-${++counter}`
      sessions.set(id, { id, agent, title, prompts: [] })
      created.push({ agent, title })
      return { sessionID: id, agentApplied: true }
    },
    async promptSession(sessionID, text) {
      const session = sessions.get(sessionID)
      if (!session) throw new Error(`unknown session ${sessionID}`)
      session.prompts.push(text)
      setTimeout(() => {
        const engine = engineRef.engine
        if (!engine) return
        if (session.agent === "teamwork-orchestrator") {
          const plan = planByProject.get("main")
          if (plan) engine.onPlan("main", plan)
          return
        }
        const role = session.agent.replace("teamwork-", "")
        const verdict = verdictByRole.get(role) ?? "pass"
        const report: ReportPayload = {
          role: role as ReportPayload["role"],
          verdict,
          findings: [verdict === "pass" ? "done" : `problem found by ${role}`],
          evidence: ["ran commands for real"],
          blockers: verdict === "fail" ? ["off-by-one"] : [],
          artifactsWritten: [],
        }
        engine.onReport(sessionID, report)
        void submitTrackReport(sessionID, report)
      }, 0)
    },
    async waitForSession() {
      // Sessions never "end" in the fake; reports resolve the waiters first.
      await new Promise<void>(() => {})
    },
    async sendSynthetic() {},
    async promptMain() {},
    async interruptSession() {},
    async removeSession(sessionID) {
      return sessions.delete(sessionID)
    },
    async renameSession(sessionID, title) {
      const session = sessions.get(sessionID)
      if (session) session.title = title
    },
  }
  return { ops, sessions, created, planByProject, verdictByRole, engineRef }
}

async function setupApprovedProject(maxVerificationRetries = 2) {
  await createProject("main", BRIEF, { maxVerificationRetries, workingDirectory: stateDir })
  await approveProject("main", {})
}

async function waitForPhase(expected: Array<string>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const project = await getProject("main")
    if (project && expected.includes(project.phase)) return project
    if (Date.now() > deadline) return project
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const PLAN: PlanMilestoneInput[] = [
  { title: "Explore", description: "Map the code.", tracks: [{ title: "Survey", role: "explorer", assignedFiles: [] }] },
  {
    title: "Implement",
    description: "Build it.",
    tracks: [
      { title: "Build", role: "worker", assignedFiles: ["src/a.ts"] },
      { title: "Review", role: "critic", assignedFiles: [] },
      { title: "Audit", role: "auditor", assignedFiles: [] },
    ],
  },
]

test("engine runs plan -> milestones -> success audit -> complete", async () => {
  const fake = makeFake()
  const engine = new TeamEngine(fake.ops, { directory: stateDir, locale: "en" })
  fake.engineRef.engine = engine
  await setupApprovedProject()
  fake.planByProject.set("main", PLAN)

  engine.startExecution("main")
  const project = await waitForPhase(["complete", "paused", "budgetLimited"])
  expect(project?.phase).toBe("complete")
  expect(project?.milestones.map((milestone) => milestone.status)).toEqual(["passed", "passed"])
  expect(project?.completionEvidence).toBeString()
  expect(project?.artifacts?.request.replaceAll("\\", "/")).toContain(".opencode/teamwork/engine-test")
  // Role sessions were recognizable when created...
  expect(fake.created.length).toBeGreaterThan(0)
  for (const session of fake.created) {
    expect(session.title).toContain(TEAMWORK_TITLE_PREFIX)
  }
  // Role sessions were recognizable when created...
  expect(fake.created.length).toBeGreaterThan(0)
  for (const session of fake.created) {
    expect(session.title).toContain(TEAMWORK_TITLE_PREFIX)
  }
  // ...and cleanup removed every role session on completion. Cleanup runs
  // shortly after the phase flips to complete: wait for it to settle.
  const cleanupDeadline = Date.now() + 5000
  while (fake.sessions.size > 0 && Date.now() < cleanupDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(fake.sessions.size).toBe(0)
}, 20_000)

test("engine removes role sessions when the project is cancelled", async () => {
  const fake2 = makeFake()
  const engine2 = new TeamEngine(fake2.ops, { directory: stateDir, locale: "en" })
  fake2.engineRef.engine = engine2
  await createProject("other", BRIEF, { workingDirectory: stateDir })
  await approveProject("other", {})
  // An empty plan list means the orchestrator's onPlan never fires, so the
  // orchestrator session stays pending — a clean point to cancel mid-run.
  fake2.planByProject.set("other", [])
  engine2.startExecution("other")
  const deadline = Date.now() + 5000
  while (fake2.created.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(fake2.created.length).toBeGreaterThan(0)
  // The server cancels through cancelProject + engine.cancel.
  await cancelProject("other", "Cancelled by the test.")
  await engine2.cancel("other")
  const cancelled = await getProject("other")
  expect(cancelled?.phase).toBe("cancelled")
  expect(fake2.sessions.size).toBe(0)
}, 20_000)

test("engine pauses the project when verification fails past the retry ceiling", async () => {
  const fake = makeFake()
  const engine = new TeamEngine(fake.ops, { directory: stateDir, locale: "en" })
  fake.engineRef.engine = engine
  await setupApprovedProject(1) // ceiling: 2 verification attempts
  fake.planByProject.set("main", [
    {
      title: "Build",
      description: "Build it.",
      tracks: [
        { title: "Build", role: "worker", assignedFiles: [] },
        { title: "Review", role: "critic", assignedFiles: [] },
      ],
    },
  ])
  fake.verdictByRole.set("critic", "fail")

  engine.startExecution("main")
  const project = await waitForPhase(["paused", "complete"])
  expect(project?.phase).toBe("paused")
  expect(project?.stopReason).toBe("verification failed")
  expect(project?.milestones[0]!.verificationAttempts).toBe(2)
  // The worker was re-prompted once before the ceiling hit.
  const workers = [...fake.sessions.values()].filter((session) => session.agent === "teamwork-worker")
  expect(workers.length).toBe(1)
  expect(workers[0]!.prompts.length).toBe(2)
  expect(workers[0]!.prompts[1]).toContain("Fix and complete")
}, 20_000)
