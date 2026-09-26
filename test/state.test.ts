import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  approveProject,
  cancelProject,
  completeProject,
  createProject,
  failTrackSession,
  getProject,
  normalizeSlug,
  pauseProject,
  resumeProject,
  setMilestonePlan,
  setMilestoneStatus,
  submitTrackReport,
  recordAdhocSession,
} from "../src/state"

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

const BRIEF = {
  name: "Fastify Migration",
  objectives: "Migrate the REST API from Express to Fastify.",
  requirements: "All existing routes keep their behavior; TypeScript throughout.",
  verification: "The migrated service must pass the existing integration test suite.",
  acceptanceCriteria: "npm test passes with zero failures on the Fastify server.",
  integrityMode: "development" as const,
  artifactLocale: "en" as const,
}

function briefOf(overrides: Partial<typeof BRIEF> = {}) {
  return { ...BRIEF, ...overrides }
}

test("normalizeSlug produces kebab-case slugs and rejects unusable names", () => {
  expect(normalizeSlug("Fastify Migration!")).toBe("fastify-migration")
  expect(normalizeSlug("  遷移 專案 ")).toBe("遷移-專案")
  expect(() => normalizeSlug("!!!")).toThrow()
})

test("createProject persists a project awaiting approval with atomic state file", async () => {
  const project = await createProject("s1", briefOf())
  expect(project.phase).toBe("awaitingApproval")
  expect(project.slug).toBe("fastify-migration")
  // The brief name is stored normalized (it doubles as the slug).
  expect(project.brief.name).toBe("fastify-migration")
  expect(project.workingDirectory).toBeNull()

  const raw = await readFile(process.env.OPENCODE_TEAMWORK_STATE_PATH!, "utf8")
  expect(JSON.parse(raw).projects.s1.brief.name).toBe("fastify-migration")
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
