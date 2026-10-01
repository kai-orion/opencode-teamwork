import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TeamEngine, TEAMWORK_TITLE_PREFIX } from "../src/engine"
import type { PlanMilestoneInput, ReportPayload, SessionOps } from "../src/engine"
import { approveProject, cancelProject, createProject, getProject, submitTrackReport } from "../src/state"
import type { Brief } from "../src/state"

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

const BRIEF: Brief = {
  name: "Engine Test",
  objectives: "Build the thing.",
  requirements: "It must work.",
  verification: "npm test passes.",
  acceptanceCriteria: "All tests green.",
  integrityMode: "development",
  executionPath: "general",
  teamScale: null,
  deep: true,
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
  /** Number of initial "fail" verdicts per role before switching to pass. */
  const failFirst = new Map<string, number>()
  const seenCounts = new Map<string, number>()
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
          const plan = planByProject.get("main") ?? planByProject.get("other")
          if (plan) engine.onPlan(sessionID, plan)
          return
        }
        const role = session.agent.replace("teamwork-", "")
        const seen = (seenCounts.get(role) ?? 0) + 1
        seenCounts.set(role, seen)
        const verdict =
          seen <= (failFirst.get(role) ?? 0) ? "fail" : (verdictByRole.get(role) ?? "pass")
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
  return { ops, sessions, created, planByProject, verdictByRole, failFirst, engineRef }
}

async function setupApprovedProject(overrides: Partial<Brief> = {}) {
  await createProject("main", { ...BRIEF, ...overrides }, { workingDirectory: stateDir })
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

const GENERAL_PLAN: PlanMilestoneInput[] = [
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
  const engine = new TeamEngine(fake.ops, { directory: stateDir })
  fake.engineRef.engine = engine
  await setupApprovedProject()
  fake.planByProject.set("main", GENERAL_PLAN)

  engine.startExecution("main")
  const project = await waitForPhase(["complete", "paused", "budgetLimited"])
  expect(project?.phase).toBe("complete")
  expect(project?.milestones.map((milestone) => milestone.status)).toEqual(["passed", "passed"])
  expect(project?.completionEvidence).toBeString()
  expect(project?.artifacts?.brief.replaceAll("\\", "/")).toContain(".teamwork/brief.md")
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
  const engine2 = new TeamEngine(fake2.ops, { directory: stateDir })
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

test("engine retries failed gates with no fixed ceiling until pass", async () => {
  const fake = makeFake()
  const engine = new TeamEngine(fake.ops, { directory: stateDir })
  fake.engineRef.engine = engine
  await setupApprovedProject()
  fake.planByProject.set("main", [
    {
      title: "Build",
      description: "Build it.",
      tracks: [
        { title: "Build", role: "worker", assignedFiles: [] },
        { title: "Review", role: "critic", assignedFiles: [] },
        { title: "Audit", role: "auditor", assignedFiles: [] },
      ],
    },
  ])
  // The critic fails twice before passing: no retry ceiling stops the loop.
  fake.failFirst.set("critic", 2)

  engine.startExecution("main")
  const project = await waitForPhase(["paused", "complete"], 15000)
  expect(project?.phase).toBe("complete")
  expect(project?.milestones[0]!.verificationAttempts).toBe(3)
  // The worker was re-prompted for each failed gate.
  const workers = [...fake.sessions.values()].filter((session) => session.agent === "teamwork-worker")
  expect(workers.length).toBe(1)
  expect(workers[0]!.prompts.length).toBe(3)
  expect(workers[0]!.prompts[1]).toContain("Prior attempt context")
}, 20_000)

test("engine pauses when the plan is missing its gate tracks", async () => {
  const fake = makeFake()
  const engine = new TeamEngine(fake.ops, { directory: stateDir })
  fake.engineRef.engine = engine
  await setupApprovedProject()
  fake.planByProject.set("main", [
    {
      title: "Build",
      description: "Build it.",
      tracks: [{ title: "Build", role: "worker", assignedFiles: [] }],
    },
  ])

  engine.startExecution("main")
  const project = await waitForPhase(["paused", "complete"])
  expect(project?.phase).toBe("paused")
  expect(project?.stopReason).toBe("plan invalid")
}, 20_000)

test("engine rejects parallel builders on the iterative path", async () => {
  const fake = makeFake()
  const engine = new TeamEngine(fake.ops, { directory: stateDir })
  fake.engineRef.engine = engine
  await setupApprovedProject({ executionPath: "iterative" })
  fake.planByProject.set("main", [
    {
      title: "Build",
      description: "Build it.",
      tracks: [
        { title: "Build A", role: "worker", assignedFiles: ["src/a.ts"] },
        { title: "Build B", role: "worker", assignedFiles: ["src/b.ts"] },
      ],
    },
  ])

  engine.startExecution("main")
  const project = await waitForPhase(["paused", "complete"])
  expect(project?.phase).toBe("paused")
}, 20_000)

test("engine runs the review path through reviewers, synthesizer, and gates", async () => {
  const fake = makeFake()
  const engine = new TeamEngine(fake.ops, { directory: stateDir })
  fake.engineRef.engine = engine
  await setupApprovedProject({ executionPath: "review" })
  fake.planByProject.set("main", [
    {
      title: "Review the RFC",
      description: "Critique the RFC against the rubric.",
      tracks: [
        { title: "Correctness angle", role: "reviewer", assignedFiles: [] },
        { title: "Clarity angle", role: "reviewer", assignedFiles: [] },
        { title: "Adjudicate", role: "synthesizer", assignedFiles: [] },
        { title: "Review", role: "critic", assignedFiles: [] },
        { title: "Audit", role: "auditor", assignedFiles: [] },
      ],
    },
  ])

  engine.startExecution("main")
  const project = await waitForPhase(["complete", "paused", "budgetLimited"])
  expect(project?.phase).toBe("complete")
  const agents = fake.created.map((session) => session.agent)
  expect(agents).toContain("teamwork-reviewer")
  expect(agents).toContain("teamwork-synthesizer")
}, 20_000)

test("engine runs the math path and skips the falsifier when deep is off", async () => {
  const fake = makeFake()
  const engine = new TeamEngine(fake.ops, { directory: stateDir })
  fake.engineRef.engine = engine
  await setupApprovedProject({ executionPath: "math", deep: false })
  fake.planByProject.set("main", [
    {
      title: "Prove the bound",
      description: "Prove it.",
      tracks: [
        { title: "Candidate", role: "prover", assignedFiles: [] },
        { title: "Attack", role: "falsifier", assignedFiles: [] },
        { title: "Judge", role: "verifier", assignedFiles: [] },
      ],
    },
  ])

  engine.startExecution("main")
  const project = await waitForPhase(["complete", "paused", "budgetLimited"])
  expect(project?.phase).toBe("complete")
  const agents = fake.created.map((session) => session.agent)
  expect(agents).toContain("teamwork-prover")
  expect(agents).toContain("teamwork-verifier")
  expect(agents).not.toContain("teamwork-falsifier")
}, 20_000)

test("permission alarm does not fail the track", async () => {
  const fake = makeFake()
  const engine = new TeamEngine(fake.ops, { directory: stateDir })
  fake.engineRef.engine = engine
  await createProject("main", BRIEF, { workingDirectory: stateDir })
  await approveProject("main", {})
  fake.planByProject.set("main", [
    {
      title: "M",
      description: "D",
      tracks: [
        { title: "T", role: "worker", assignedFiles: [] },
        { title: "R", role: "critic", assignedFiles: [] },
        { title: "A", role: "auditor", assignedFiles: [] },
      ],
    },
  ])
  engine.startExecution("main")
  // Wait for the worker session to exist, then simulate a permission wait.
  const deadline = Date.now() + 5000
  let workerID: string | null = null
  while (!workerID && Date.now() < deadline) {
    const project = await getProject("main")
    workerID = project?.milestones[0]?.tracks[0]?.sessionID ?? null
    if (!workerID) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(workerID).toBeString()
  engine.notifyPermissionPending(workerID as string, "approve bash: npm test")
  const project = await waitForPhase(["complete", "paused", "budgetLimited"], 8000)
  // Permission alarm is best-effort; the run still completes via the fake reports.
  expect(["complete", "paused", "budgetLimited"]).toContain(project?.phase as string)
}, 20_000)
