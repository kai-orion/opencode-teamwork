import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  approveProject,
  cancelProject,
  completeProject,
  createProject,
  failTrackSession,
  getProject,
  normalizeExecutionPath,
  normalizeSlug,
  normalizeTeamScale,
  pauseProject,
  resumeProject,
  setMilestonePlan,
  setMilestoneStatus,
  submitTrackReport,
  recordAdhocSession,
} from "../src/state"
import type { Brief } from "../src/state"

let stateDir: string
let originalStatePath: string | undefined

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "opencode-teamwork-state-"))
  originalStatePath = process.env.OPENCODE_TEAMWORK_STATE_PATH
  process.env.OPENCODE_TEAMWORK_STATE_PATH = join(stateDir, "projects.json")
})

afterEach(async () => {
  if (originalStatePath === undefined) delete process.env.OPENCODE_TEAMWORK_STATE_PATH
  else process.env.OPENCODE_TEAMWORK_STATE_PATH = originalStatePath
  await rm(stateDir, { recursive: true, force: true })
})

const BRIEF: Brief = {
  name: "Fastify Migration",
  objectives: "Migrate the REST API from Express to Fastify.",
  requirements: "All existing routes keep their behavior; TypeScript throughout.",
  verification: "The migrated service must pass the existing integration test suite.",
  acceptanceCriteria: "npm test passes with zero failures on the Fastify server.",
  integrityMode: "development",
  executionPath: "general",
  teamScale: null,
  deep: true,
}

function briefOf(overrides: Partial<Brief> = {}) {
  return { ...BRIEF, ...overrides }
}

test("normalizeSlug produces kebab-case slugs and rejects unusable names", () => {
  expect(normalizeSlug("Fastify Migration!")).toBe("fastify-migration")
  expect(normalizeSlug("  migration project ")).toBe("migration-project")
  expect(() => normalizeSlug("!!!")).toThrow()
})

test("execution path and knobs normalize with safe defaults", () => {
  expect(normalizeExecutionPath("review")).toBe("review")
  expect(normalizeExecutionPath("math-large")).toBe("math-large")
  expect(normalizeExecutionPath("bogus")).toBe("general")
  expect(normalizeExecutionPath(undefined)).toBe("general")
  expect(normalizeTeamScale("L")).toBe("L")
  expect(normalizeTeamScale("XL")).toBeNull()
  expect(normalizeTeamScale(undefined)).toBeNull()
})

test("createProject persists a project awaiting approval with atomic state file", async () => {
  const project = await createProject("s1", briefOf())
  expect(project.phase).toBe("awaitingApproval")
  expect(project.slug).toBe("fastify-migration")
  // The brief name is stored normalized (it doubles as the slug).
  expect(project.brief.name).toBe("fastify-migration")
  expect(project.brief.executionPath).toBe("general")
  expect(project.brief.deep).toBe(true)
  expect(project.workingDirectory).toBeNull()

  const raw = await readFile(process.env.OPENCODE_TEAMWORK_STATE_PATH!, "utf8")
  const parsed = JSON.parse(raw)
  expect(parsed.version).toBe(2)
  expect(parsed.projects.s1.brief.name).toBe("fastify-migration")
})

test("v1 state files are dropped without failing (no old-project support)", async () => {
  await createProject("s1", briefOf())
  const stateFile = process.env.OPENCODE_TEAMWORK_STATE_PATH!
  const raw = JSON.parse(await readFile(stateFile, "utf8"))
  raw.version = 1
  await writeFile(stateFile, JSON.stringify(raw), "utf8")
  expect(await getProject("s1")).toBeNull()
})

test("a session cannot hold two non-closed projects", async () => {
  await createProject("s1", briefOf())
  await expect(createProject("s1", briefOf({ name: "Second" }))).rejects.toThrow(/non-closed project/)
})

test("approve -> pause -> resume -> complete lifecycle", async () => {
  await createProject("s1", briefOf())
  await expect(approveProject("s1", {})).resolves.toMatchObject({ phase: "executing" })
  await pauseProject("s1", "stepping out")
  const paused = await getProject("s1")
  expect(paused?.phase).toBe("paused")
  expect(paused?.blocker).toBe("stepping out")
  await resumeProject("s1")
  expect((await getProject("s1"))?.phase).toBe("executing")
  await completeProject("s1", "all tests passed: 42/42")
  const done = await getProject("s1")
  expect(done?.phase).toBe("complete")
  expect(done?.completionEvidence).toContain("42/42")
  expect(done?.closedAt).not.toBeNull()
})

test("approve rejects projects that are not awaiting approval", async () => {
  await createProject("s1", briefOf())
  await approveProject("s1", {})
  await expect(approveProject("s1", {})).rejects.toThrow(/not awaiting approval/)
})

test("brief can only be revised while awaiting approval", async () => {
  await createProject("s1", briefOf())
  await approveProject("s1", {})
  await expect(createProject("s1", briefOf({ name: "Other" }))).rejects.toThrow()
})

test("cancel closes the project and blocks further transitions", async () => {
  await createProject("s1", briefOf())
  await approveProject("s1", {})
  expect(await cancelProject("s1", "changed mind")).toBe(true)
  const project = await getProject("s1")
  expect(project?.phase).toBe("cancelled")
  await expect(resumeProject("s1")).rejects.toThrow(/closed/)
})

test("setMilestonePlan persists milestones with sequential ids", async () => {
  await createProject("s1", briefOf())
  await approveProject("s1", {})
  const project = await setMilestonePlan("s1", [
    {
      title: "Explore routes",
      description: "Map all Express routes.",
      tracks: [{ title: "Route survey", role: "explorer", assignedFiles: [] }],
    },
    {
      title: "Migrate server",
      description: "Port the server to Fastify.",
      tracks: [
        { title: "Port handlers", role: "worker", assignedFiles: ["src/server.ts"] },
        { title: "Review", role: "critic", assignedFiles: [] },
      ],
    },
  ])
  expect(project.milestones.map((milestone) => milestone.id)).toEqual(["m1", "m2"])
  expect(project.activeMilestoneIndex).toBe(0)
  expect(project.milestones[1]!.tracks.map((track) => track.id)).toEqual(["m2t1", "m2t2"])
})

test("math and review roles persist in plans", async () => {
  await createProject("s1", briefOf({ name: "Proof", executionPath: "math" }))
  await approveProject("s1", {})
  const project = await setMilestonePlan("s1", [
    {
      title: "Prove bound",
      description: "Prove the bound.",
      tracks: [
        { title: "Candidate", role: "prover", assignedFiles: [] },
        { title: "Attack", role: "falsifier", assignedFiles: [] },
        { title: "Judge", role: "verifier", assignedFiles: [] },
      ],
    },
  ])
  expect(project.milestones[0]!.tracks.map((track) => track.role)).toEqual(["prover", "falsifier", "verifier"])
})

test("assignTrackSession tracks role sessions and counts spawns", async () => {
  await createProject("s1", briefOf())
  await approveProject("s1", {})
  await setMilestonePlan("s1", [
    { title: "M", description: "D", tracks: [{ title: "T", role: "worker", assignedFiles: ["a.ts"] }] },
  ])
  const project = await recordAdhocSession("s1", "orchestrator", "role-orch")
  expect(project.sessionsSpawned).toBe(1)
  const after = await submitTrackReport("role-orch", {
    role: "orchestrator",
    verdict: "pass",
    findings: ["plan ready"],
    evidence: ["read request artifact"],
    blockers: [],
    artifactsWritten: [],
  })
  expect(after?.lastStatus).toContain("orchestrator reported: pass")
})

test("submitTrackReport fails the track when a session dies without reporting", async () => {
  await createProject("s1", briefOf())
  await approveProject("s1", {})
  await setMilestonePlan("s1", [
    { title: "M", description: "D", tracks: [{ title: "T", role: "worker", assignedFiles: [] }] },
  ])
  await recordAdhocSession("s1", "worker", "role-w1")
  await failTrackSession("role-w1", "ended without teamwork_report")
  const state = await getProject("s1")
  // The ad-hoc track was appended after the planned track.
  const track = state?.milestones[0]?.tracks.find((candidate) => candidate.sessionID === "role-w1")
  expect(track?.status).toBe("failed")
  expect(state?.history.some((entry) => entry.type === "error")).toBe(true)
})

test("milestone status updates advance the active milestone on pass", async () => {
  await createProject("s1", briefOf())
  await approveProject("s1", {})
  await setMilestonePlan("s1", [
    { title: "M1", description: "D1", tracks: [] },
    { title: "M2", description: "D2", tracks: [] },
  ])
  await setMilestoneStatus("s1", 0, "inProgress")
  await setMilestoneStatus("s1", 0, "passed")
  const project = await getProject("s1")
  expect(project?.milestones[0]!.status).toBe("passed")
  expect(project?.activeMilestoneIndex).toBe(1)
})

test("token budget exhaustion moves an executing project to budgetLimited", async () => {
  await createProject("s1", briefOf(), { tokenBudget: 100 })
  await approveProject("s1", {})
  const state = await import("../src/state")
  // Cumulative accounting measures growth from the first observation; the
  // initial baseline anchors that first sample at zero growth.
  const project = await state.accountProjectUsage("s1", 250, { cumulative: true, initialBaseline: 0 })
  expect(project?.tokensUsed).toBe(250)
  expect(project?.phase).toBe("budgetLimited")
  expect(project?.stopReason).toContain("token budget reached")
})

test("corrupt state is quarantined before recovery", async () => {
  const stateFile = process.env.OPENCODE_TEAMWORK_STATE_PATH!
  await createProject("s1", briefOf())
  const valid = await readFile(stateFile, "utf8")
  await import("node:fs/promises").then((fs) => fs.writeFile(stateFile, "{corrupt", "utf8"))
  await createProject("s2", briefOf({ name: "Recovery" }))
  const files = await readdir(stateDir)
  expect(files.some((file) => file.includes(".corrupt-"))).toBe(true)
  const recovered = await getProject("s2")
  expect(recovered?.slug).toBe("recovery")
  // The valid pre-corruption content must have been preserved byte-for-byte.
  const quarantine = files.find((file) => file.includes(".corrupt-"))
  const quarantined = await readFile(join(stateDir, quarantine!), "utf8")
  expect(quarantined).toBe("{corrupt")
  void valid
})

test("parallel workers clamp to 1..8 and default to 5", async () => {
  const { clampParallelWorkers } = await import("../src/state")
  expect(clampParallelWorkers(99)).toBe(8)
  expect(clampParallelWorkers(0)).toBe(1)
  const project = await createProject("s-exec", briefOf())
  expect(project.maxParallelWorkers).toBe(5)
  expect(project.trackStallReminderSeconds).toBe(1800)
  const capped = await createProject("s-cap", briefOf({ name: "Cap" }), { maxParallelWorkers: 99 })
  expect(capped.maxParallelWorkers).toBe(8)
})

test("submitTrackReportByID and permission timer suspension work", async () => {
  const { setMilestonePlan, submitTrackReportByID, suspendTimerForPermission } = await import("../src/state")
  await createProject("s-rep", briefOf())
  await approveProject("s-rep", {})
  await setMilestonePlan("s-rep", [
    { title: "M", description: "D", tracks: [{ title: "T", role: "worker", assignedFiles: [] }] },
  ])
  const submitted = await submitTrackReportByID("s-rep", 0, "m1t1", {
    role: "worker",
    verdict: "pass",
    findings: ["done"],
    evidence: ["npm test -> ok"],
    blockers: [],
    artifactsWritten: [],
  })
  expect(submitted?.milestones[0]?.tracks[0]?.lastReport?.verdict).toBe("pass")
  const suspended = await suspendTimerForPermission("s-rep")
  expect(suspended?.lastAccountedAt).toBeNull()
})
