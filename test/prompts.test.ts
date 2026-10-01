import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  agentNameForRole,
  approveCommandTemplate,
  cancelCommandTemplate,
  findOwnershipConflicts,
  hasValidReportBlock,
  pauseCommandTemplate,
  permissionApprovalPrompt,
  resumeCommandTemplate,
  reviseCommandTemplate,
  roleAgentName,
  roleTaskPrompt,
  statusCommandTemplate,
  systemReminder,
  teamworkCommandTemplate,
  trackSummaryPrompt,
  ROLE_AGENT_NAMES,
  ROLE_AGENT_SYSTEM_PROMPTS,
} from "../src/prompts"
import { ROLE_PROMPTS, SENTINEL_MD, SHARED_BASE_MD, SKILL_MD } from "../src/prompts.generated"

const EXPECTED_ROLES = [
  "orchestrator",
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
  "successAuditor",
]

test("all twelve role prompts exist and demand teamwork_report", () => {
  expect([...ROLE_AGENT_NAMES] as string[]).toEqual(EXPECTED_ROLES)
  for (const role of ROLE_AGENT_NAMES) {
    const prompt = ROLE_AGENT_SYSTEM_PROMPTS[role]
    expect(prompt).toContain("report block")
    expect(prompt.length).toBeGreaterThan(100)
  }
  expect(ROLE_AGENT_SYSTEM_PROMPTS.explorer).toMatch(/read-only/i)
  expect(ROLE_AGENT_SYSTEM_PROMPTS.worker).toMatch(/assigned/i)
  expect(ROLE_AGENT_SYSTEM_PROMPTS.auditor).toMatch(/integrity mode/i)
  expect(ROLE_AGENT_SYSTEM_PROMPTS.successAuditor).toMatch(/end-to-end/i)
  expect(ROLE_AGENT_SYSTEM_PROMPTS.prover).toMatch(/tournament/i)
  expect(ROLE_AGENT_SYSTEM_PROMPTS.reviewer).toMatch(/rubric/i)
})

test("generated prompts match the skill-teamwork markdown verbatim", () => {
  const read = (path: string) => readFileSync(join("skill-teamwork", path), "utf8")
  expect(SKILL_MD).toBe(read("SKILL.md"))
  expect(SENTINEL_MD).toBe(read(join("roles", "sentinel.md")))
  expect(SHARED_BASE_MD).toBe(read(join("roles", "shared", "base.md")))
  const fileFor: Record<string, string> = {
    orchestrator: join("roles", "orchestrator.md"),
    explorer: join("roles", "coding", "explorer.md"),
    worker: join("roles", "coding", "worker.md"),
    critic: join("roles", "coding", "critic.md"),
    challenger: join("roles", "coding", "challenger.md"),
    auditor: join("roles", "coding", "auditor.md"),
    prover: join("roles", "math", "prover.md"),
    falsifier: join("roles", "math", "falsifier.md"),
    verifier: join("roles", "math", "verifier.md"),
    reviewer: join("roles", "review", "reviewer.md"),
    synthesizer: join("roles", "review", "synthesizer.md"),
    successAuditor: join("roles", "success-auditor.md"),
  }
  for (const role of EXPECTED_ROLES) {
    const prompt = ROLE_PROMPTS[role as keyof typeof ROLE_PROMPTS] as string
    expect(prompt).toBe(read(fileFor[role]!))
  }
})

test("roleAgentName and agentNameForRole cover all roles", () => {
  for (const role of EXPECTED_ROLES) {
    expect(roleAgentName(role) as string | null).toBe(role)
    expect(agentNameForRole(role as keyof typeof ROLE_AGENT_SYSTEM_PROMPTS)).toBe(`teamwork-${role}`)
  }
  expect(roleAgentName("sentinel")).toBeNull()
  expect(roleAgentName("root")).toBeNull()
})

test("role task prompt is base + role + SKILL.md task block", () => {
  const prompt = roleTaskPrompt({
    role: "worker",
    projectSlug: "fastify-migration",
    workingDirectory: "/repo",
    integrityMode: "benchmark",
    executionPath: "general",
    workers: 5,
    teamScale: null,
    deep: true,
    artifactPaths: {
      brief: "/repo/.teamwork/brief.md",
      request: "/repo/.teamwork/request.md",
      plan: "/repo/.teamwork/plan.md",
      progress: "/repo/.teamwork/progress.md",
    },
    taskTitle: "Port handlers",
    taskDetail: "Port every handler.",
    assignedFiles: ["src/server.ts"],
    contextPacket: "Explorer m1t1:\n- src/server.ts:10",
    acceptanceCriteria: ["npm test passes"],
    scratchDirectory: "/repo/.teamwork/scratch/m1t2",
    attemptContext: "Prior attempt verdict: fail.",
  })
  // Shared base first, then the verbatim role file.
  expect(prompt.indexOf("Evidence discipline")).toBeLessThan(prompt.indexOf("You are a Worker"))
  expect(prompt).toContain("fastify-migration")
  expect(prompt).toContain("benchmark")
  expect(prompt).toContain("Path: general")
  expect(prompt).toContain("workers=5")
  expect(prompt).toContain("- src/server.ts")
  expect(prompt).toContain("brief.md")
  expect(prompt).toContain("Context Packet")
  expect(prompt).toContain("src/server.ts:10")
  expect(prompt).toContain("Scope boundary")
  expect(prompt).toContain("Acceptance criteria for this milestone")
  expect(prompt).toContain("npm test passes")
  expect(prompt).toContain("scratch")
  expect(prompt).toContain("Prior attempt verdict: fail.")
  expect(prompt).toContain("teamwork_report")
  expect(prompt).toContain("Fabricated evidence is an automatic failure")
})

test("read-only tracks get an explicit read-only ownership line", () => {
  const prompt = roleTaskPrompt({
    role: "critic",
    projectSlug: "demo",
    workingDirectory: "/repo",
    integrityMode: "development",
    executionPath: "general",
    workers: 5,
    teamScale: null,
    deep: true,
    artifactPaths: null,
    taskTitle: "Review",
    taskDetail: "Review it.",
    assignedFiles: [],
    contextPacket: null,
    acceptanceCriteria: [],
    scratchDirectory: null,
    attemptContext: null,
  })
  expect(prompt).toContain("- read-only")
})

test("command templates are thin wrappers with $ARGUMENTS only in interview/revise", () => {
  const interview = teamworkCommandTemplate()
  expect(interview).toContain("$ARGUMENTS")
  expect(interview).toContain("teamwork_create_project")
  expect(interview).toContain("Specify What, Not How")
  expect(interview).toContain(SENTINEL_MD.trim().slice(0, 80))
  expect(approveCommandTemplate()).toContain("teamwork_approve")
  expect(reviseCommandTemplate()).toContain("teamwork_revise")
  expect(statusCommandTemplate()).toContain("teamwork_get_project")
  expect(pauseCommandTemplate()).toContain("teamwork_pause")
  expect(resumeCommandTemplate()).toContain("teamwork_resume")
  expect(cancelCommandTemplate()).toContain("teamwork_cancel")
  expect(approveCommandTemplate()).not.toContain("$ARGUMENTS")
  expect(systemReminder()).toContain("teamwork_report")
})

test("track summary and permission prompts carry the reporting contract", () => {
  const summary = trackSummaryPrompt({
    projectSlug: "demo",
    trackID: "m1t1",
    role: "worker",
    title: "Port",
    verdict: "pass",
    findings: ["ok"],
    evidence: ["npm test -> ok"],
    running: 1,
    queued: 2,
  })
  expect(summary).toContain("m1t1")
  expect(summary).toContain("running 1, queued 2")
  const alarm = permissionApprovalPrompt({ projectSlug: "demo", trackID: "m1t1", role: "worker", detail: "approve bash" })
  expect(alarm).toContain("[NEEDS-APPROVAL]")
})

test("report block validator accepts full blocks and rejects thin evidence", () => {
  expect(
    hasValidReportBlock(
      "verdict: pass\nfindings: done\nEvidence: npm test -> 42 passing\nblockers: none\nartifacts written: src/a.ts",
    ),
  ).toBe(true)
  expect(hasValidReportBlock("no block here")).toBe(false)
  expect(hasValidReportBlock("verdict: pass\nfindings: x\nEvidence: ok\nblockers: none\nartifacts written: none")).toBe(
    false,
  )
})

test("ownership checker flags files shared by two builder tracks", () => {
  expect(
    findOwnershipConflicts([
      { title: "A", assignedFiles: ["src/a.ts"] },
      { title: "B", assignedFiles: ["src/a.ts"] },
    ]),
  ).toHaveLength(1)
  expect(
    findOwnershipConflicts([
      { title: "A", assignedFiles: ["src/a.ts"] },
      { title: "B", assignedFiles: [] },
      { title: "C", assignedFiles: ["read-only"] },
    ]),
  ).toHaveLength(0)
})
