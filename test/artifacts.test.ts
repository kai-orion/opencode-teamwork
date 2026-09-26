import { expect, test } from "bun:test"
import { artifactPaths, renderPlanArtifact, renderProgressArtifact, renderRequestArtifact } from "../src/artifacts"
import type { Project } from "../src/state"

function project(overrides: Partial<Project> = {}): Project {
  return {
    sessionID: "s1",
    slug: "fastify-migration",
    brief: {
      name: "fastify-migration",
      objectives: "Migrate the REST API from Express to Fastify.",
      requirements: "Routes keep behavior.",
      verification: "Integration suite passes.",
      acceptanceCriteria: "npm test is green.",
      integrityMode: "demo",
      artifactLocale: "en",
    },
    phase: "executing",
    milestones: [
      {
        id: "m1",
        title: "Survey routes",
        description: "Map all Express routes.",
        status: "passed",
        verificationAttempts: 1,
        tracks: [
          {
            id: "m1t1",
            title: "Route survey",
            role: "explorer",
            assignedFiles: [],
            status: "passed",
            sessionID: "role-1",
            attempt: 1,
            lastReport: {
              role: "explorer",
              verdict: "pass",
              findings: ["12 routes found"],
              evidence: ["grep output"],
              blockers: [],
              artifactsWritten: [],
              submittedAt: 100,
            },
          },
        ],
      },
      {
        id: "m2",
        title: "Port server",
        description: "Port the server.",
        status: "inProgress",
        verificationAttempts: 0,
        tracks: [
          {
            id: "m2t1",
            title: "Port handlers",
            role: "worker",
            assignedFiles: ["src/server.ts"],
            status: "running",
            sessionID: "role-2",
            attempt: 1,
            lastReport: null,
          },
        ],
      },
    ],
    activeMilestoneIndex: 1,
    artifacts: null,
    workingDirectory: "/repo",
    tokenBudget: null,
    tokensUsed: 500,
    usageTrackers: {},
    timeUsedSeconds: 90,
    lastAccountedAt: 100,
    sessionsSpawned: 2,
    maxAutoTurns: null,
    maxDurationSeconds: null,
    maxParallelWorkers: 5,
    maxVerificationRetries: 2,
    executor: "native",
    trackStallReminderSeconds: 1800,
    planPaused: false,
    sentinelUpdate: { message: "Milestone m1 passed", timestamp: 120 },
    history: [],
    completionEvidence: null,
    blocker: null,
    closedAt: null,
    stopReason: null,
    lastStatus: "ok",
    createdAt: 10,
    updatedAt: 120,
    ...overrides,
  }
}

test("artifact paths live under .opencode/teamwork/<slug>/", () => {
  const paths = artifactPaths("/repo", "fastify-migration")
  const normalized = (value: string) => value.replaceAll("\\", "/")
  expect(normalized(paths.request)).toBe("/repo/.opencode/teamwork/fastify-migration/request.md")
  expect(normalized(paths.plan)).toContain("plan.md")
  expect(normalized(paths.progress)).toContain("progress.md")
})

test("request artifact renders the full approved brief", () => {
  const markdown = renderRequestArtifact(project())
  expect(markdown).toContain("# Teamwork Project Request: fastify-migration")
  expect(markdown).toContain("Migrate the REST API from Express to Fastify.")
  expect(markdown).toContain("- Integrity mode: demo")
  expect(markdown).toContain("Executor: native")
  expect(markdown).toContain("## Acceptance criteria")
})

test("plan artifact lists milestones, tracks, ownership, and verdicts", () => {
  const markdown = renderPlanArtifact(project())
  expect(markdown).toContain("### m1: Survey routes [passed]")
  expect(markdown).toContain("*(active)*")
  expect(markdown).toContain("(explorer) Route survey")
  expect(markdown).toContain("files: src/server.ts")
  expect(markdown).toContain("verdict: pass")
})

test("plan artifact renders the empty-state placeholder before planning", () => {
  const markdown = renderPlanArtifact(project({ milestones: [], activeMilestoneIndex: -1 }))
  expect(markdown).toContain("has not recorded a milestone plan")
})

test("progress artifact renders phase, sentinel update, and milestone progress", () => {
  const markdown = renderProgressArtifact(project())
  expect(markdown).toContain("- Phase: executing")
  expect(markdown).toContain("1/2")
  expect(markdown).toContain("Milestone m1 passed")
})

test("artifacts follow the brief's artifact locale", () => {
  const localized = project({ brief: { ...project().brief, artifactLocale: "zh-TW" } })
  const markdown = renderRequestArtifact(localized)
  expect(markdown).toContain("完整性模式")
  expect(markdown).toContain("驗收標準")
})
