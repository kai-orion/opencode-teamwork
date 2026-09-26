import { expect, test } from "bun:test"
import {
  approveCommandTemplate,
  cancelCommandTemplate,
  pauseCommandTemplate,
  resumeCommandTemplate,
  reviseCommandTemplate,
  roleAgentName,
  roleTaskPrompt,
  statusCommandTemplate,
  teamworkCommandTemplate,
  ROLE_AGENT_NAMES,
  ROLE_AGENT_SYSTEM_PROMPTS,
} from "../src/prompts"
import { resolveLocale } from "../src/i18n"

test("all seven role prompts exist and demand teamwork_report", () => {
  expect(ROLE_AGENT_NAMES).toEqual([
    "orchestrator",
    "explorer",
    "worker",
    "critic",
    "challenger",
    "auditor",
    "successAuditor",
  ])
  for (const role of ROLE_AGENT_NAMES) {
    const prompt = ROLE_AGENT_SYSTEM_PROMPTS[role]
    expect(prompt).toContain("teamwork_report")
    expect(prompt.length).toBeGreaterThan(200)
  }
  expect(ROLE_AGENT_SYSTEM_PROMPTS.explorer).toMatch(/read-only/i)
  expect(ROLE_AGENT_SYSTEM_PROMPTS.worker).toMatch(/file ownership/i)
  expect(ROLE_AGENT_SYSTEM_PROMPTS.auditor).toMatch(/integrity mode/i)
  expect(ROLE_AGENT_SYSTEM_PROMPTS.successAuditor).toMatch(/end-to-end/i)
})

test("roleAgentName rejects unknown roles", () => {
  expect(roleAgentName("worker")).toBe("worker")
  expect(roleAgentName("sentinel")).toBeNull()
  expect(roleAgentName("root")).toBeNull()
})

test("role task prompt carries project context, ownership, scratch, and reporting contract", () => {
  const prompt = roleTaskPrompt({
    role: "worker",
    projectSlug: "fastify-migration",
    workingDirectory: "/repo",
    artifactPaths: { request: "/repo/.opencode/teamwork/fastify-migration/request.md", plan: "/repo/p.md", progress: "/repo/pr.md" },
    integrityMode: "benchmark",
    taskTitle: "Port handlers",
    taskDetail: "Port every handler.",
    assignedFiles: ["src/server.ts"],
    scratchDirectory: "/repo/.opencode/teamwork/fastify-migration/scratch",
    attemptContext: "Prior attempt verdict: fail.",
  })
  expect(prompt).toContain("fastify-migration")
  expect(prompt).toContain("benchmark")
  expect(prompt).toContain("- src/server.ts")
  expect(prompt).toContain("request.md")
  expect(prompt).toContain("scratch")
  expect(prompt).toContain("Prior attempt verdict: fail.")
  expect(prompt).toContain("teamwork_report")
})

test("command templates localize and substitute $ARGUMENTS only in the interview template", () => {
  for (const locale of ["en", "zh-TW", "zh-CN"] as const) {
    const interview = teamworkCommandTemplate(locale)
    expect(interview).toContain("$ARGUMENTS")
    expect(interview).toContain("teamwork_create_project")
    expect(approveCommandTemplate(locale)).toContain("teamwork_approve")
    expect(reviseCommandTemplate(locale)).toContain("teamwork_revise")
    expect(statusCommandTemplate(locale)).toContain("teamwork_get_project")
    expect(pauseCommandTemplate(locale)).toContain("teamwork_pause")
    expect(resumeCommandTemplate(locale)).toContain("teamwork_resume")
    expect(cancelCommandTemplate(locale)).toContain("teamwork_cancel")
    // Non-interview commands must not keep the placeholder.
    expect(approveCommandTemplate(locale)).not.toContain("$ARGUMENTS")
  }
  // Locale negotiation falls back to English templates.
  expect(teamworkCommandTemplate(resolveLocale("fr"))).toBe(teamworkCommandTemplate("en"))
})
