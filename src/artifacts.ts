import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Project } from "./state"

/**
 * Teamwork artifacts are real markdown files under `<repo>/.teamwork/` so the
 * user can review and edit them. The plugin owns the writing: brief.md from
 * the approved Phase 1 brief, request.md from the same brief, plan.md from
 * the orchestrator's milestone plan, progress.md from live track state.
 * The state JSON only stores pointers to these paths.
 */

export function artifactDirPath(directory: string) {
  return join(directory, ".teamwork")
}

export function artifactPaths(directory: string) {
  const dir = artifactDirPath(directory)
  return {
    dir,
    brief: join(dir, "brief.md"),
    request: join(dir, "request.md"),
    plan: join(dir, "plan.md"),
    progress: join(dir, "progress.md"),
    scratch: join(dir, "scratch"),
    knowledge: join(dir, "knowledge"),
  }
}

export type ArtifactPaths = ReturnType<typeof artifactPaths>

function iso(timestamp: number) {
  return new Date(timestamp * 1000).toISOString()
}

function speedKnobs(project: Project) {
  const team = project.brief.teamScale ?? "default"
  const deep = project.brief.deep ? "on" : "off"
  return `workers=${project.maxParallelWorkers}, team=${team}, deep=${deep}`
}

export function renderBriefArtifact(project: Project) {
  const lines = [
    `# Teamwork Project Brief: ${project.slug}`,
    "",
    `- Project: ${project.slug}`,
    `- Working directory: ${project.workingDirectory ?? "n/a"}`,
    `- Execution path: ${project.brief.executionPath}`,
    `- Integrity mode: ${project.brief.integrityMode}`,
    `- Speed knobs: ${speedKnobs(project)}`,
    `- Status: ${project.phase}`,
    "",
    `## Objectives & scope`,
    "",
    project.brief.objectives,
    "",
    `## Requirements`,
    "",
    project.brief.requirements,
    "",
    `## Independent verification`,
    "",
    project.brief.verification,
    "",
    `## Acceptance criteria`,
    "",
    project.brief.acceptanceCriteria,
    "",
  ]
  return lines.join("\n")
}

export function renderRequestArtifact(project: Project) {
  const lines = [
    `# Teamwork Project Request: ${project.slug}`,
    "",
    `- Project: ${project.slug}`,
    `- Working directory: ${project.workingDirectory ?? "n/a"}`,
    `- Execution path: ${project.brief.executionPath}`,
    `- Integrity mode: ${project.brief.integrityMode}`,
    `- Speed knobs: ${speedKnobs(project)}`,
    `- Status: ${project.phase}`,
    "",
    `## Objectives & scope`,
    "",
    project.brief.objectives,
    "",
    `## Requirements`,
    "",
    project.brief.requirements,
    "",
    `## Independent verification`,
    "",
    project.brief.verification,
    "",
    `## Acceptance criteria`,
    "",
    project.brief.acceptanceCriteria,
    "",
  ]
  return lines.join("\n")
}

export function renderPlanArtifact(project: Project) {
  const lines = [`# Teamwork Project Plan: ${project.slug}`, ""]
  if (project.milestones.length === 0) {
    lines.push(`_The orchestrator has not recorded a milestone plan yet._`, "")
    return lines.join("\n")
  }
  lines.push(`## Milestones`, "")
  project.milestones.forEach((milestone, index) => {
    const active = index === project.activeMilestoneIndex ? " *(active)*" : ""
    lines.push(`### ${milestone.id}: ${milestone.title} [${milestone.status}]${active}`, "")
    lines.push(milestone.description, "")
    if (milestone.tracks.length > 0) {
      lines.push(`**Tracks:**`, "")
      for (const track of milestone.tracks) {
        const files = track.assignedFiles.length > 0 ? ` — files: ${track.assignedFiles.join(", ")}` : ""
        const report = track.lastReport ? ` — verdict: ${track.lastReport.verdict}` : ""
        lines.push(`- ${track.id} [${track.status}] (${track.role}) ${track.title}${files}${report}`)
      }
      lines.push("")
    }
  })
  return lines.join("\n")
}

export function renderProgressArtifact(project: Project) {
  const lines = [
    `# Teamwork Progress: ${project.slug}`,
    "",
    `- Phase: ${project.phase}`,
    `- Path: ${project.brief.executionPath}`,
    `- Milestone progress: ${project.milestones.filter((m) => m.status === "passed").length}/${project.milestones.length}`,
    "",
  ]
  if (project.sentinelUpdate) {
    lines.push(`## Latest Sentinel update`, "", `- ${iso(project.sentinelUpdate.timestamp)} — ${project.sentinelUpdate.message}`, "")
  } else {
    lines.push(`## Latest Sentinel update`, "", `_No Sentinel update posted yet._`, "")
  }
  lines.push(`## Milestone progress`, "")
  for (const milestone of project.milestones) {
    lines.push(`- ${milestone.id} [${milestone.status}] ${milestone.title}`)
    for (const track of milestone.tracks) {
      const report = track.lastReport ? ` — verdict: ${track.lastReport.verdict}` : ""
      lines.push(`  - ${track.id} [${track.status}] (${track.role}, attempt ${track.attempt}) ${track.title}${report}`)
    }
  }
  lines.push("")
  return lines.join("\n")
}

async function writeFileAtomicallyEnough(path: string, content: string) {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, content, "utf8")
}

/** Writes all four artifacts plus scratch/knowledge dirs; returns their paths. */
export async function writeArtifacts(directory: string, project: Project) {
  const paths = artifactPaths(directory)
  await mkdir(paths.dir, { recursive: true, mode: 0o700 })
  await mkdir(paths.scratch, { recursive: true, mode: 0o700 })
  if (project.brief.executionPath === "math" || project.brief.executionPath === "math-large") {
    await mkdir(paths.knowledge, { recursive: true, mode: 0o700 })
    const pitfalls = join(paths.knowledge, "pitfalls.md")
    try {
      await writeFile(pitfalls, "# Pitfall Registry\n\nDocument failed approaches and invalid lemmas here.\n", {
        encoding: "utf8",
        flag: "wx",
      })
    } catch {
      // Already exists; keep the accumulated registry.
    }
  }
  await writeFileAtomicallyEnough(paths.brief, renderBriefArtifact(project))
  await writeFileAtomicallyEnough(paths.request, renderRequestArtifact(project))
  await writeFileAtomicallyEnough(paths.plan, renderPlanArtifact(project))
  await writeFileAtomicallyEnough(paths.progress, renderProgressArtifact(project))
  return { brief: paths.brief, request: paths.request, plan: paths.plan, progress: paths.progress }
}

/** Refreshes the plan and progress artifacts after state changes. */
export async function refreshPlanAndProgress(directory: string, project: Project) {
  const paths = artifactPaths(directory)
  await writeFileAtomicallyEnough(paths.plan, renderPlanArtifact(project))
  await writeFileAtomicallyEnough(paths.progress, renderProgressArtifact(project))
  return { plan: paths.plan, progress: paths.progress }
}
