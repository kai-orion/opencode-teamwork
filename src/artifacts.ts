import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { TeamworkLocale } from "./i18n"
import type { Project } from "./state"

/**
 * Teamwork artifacts are real markdown files under
 * `<repo>/.opencode/teamwork/<slug>/` so the user can review and edit them.
 * The plugin owns the writing: request.md from the approved brief, plan.md
 * from the orchestrator's milestone plan, progress.md from live track state.
 * The state JSON only stores pointers to these paths.
 */

export function artifactDirPath(directory: string, slug: string) {
  return join(directory, ".opencode", "teamwork", slug)
}

export function artifactPaths(directory: string, slug: string) {
  const dir = artifactDirPath(directory, slug)
  return { dir, request: join(dir, "request.md"), plan: join(dir, "plan.md"), progress: join(dir, "progress.md") }
}

const LABELS: Record<TeamworkLocale, Record<string, string>> = {
  en: {
    title: "Teamwork Project Request",
    project: "Project",
    workingDirectory: "Working directory",
    integrityMode: "Integrity mode",
    status: "Status",
    objectives: "Objectives & scope",
    requirements: "Requirements",
    verification: "Independent verification",
    acceptanceCriteria: "Acceptance criteria",
    plan: "Teamwork Project Plan",
    milestones: "Milestones",
    noPlan: "The orchestrator has not recorded a milestone plan yet.",
    progress: "Teamwork Progress",
    phase: "Phase",
    milestoneProgress: "Milestone progress",
    latestUpdate: "Latest Sentinel update",
    noUpdate: "No Sentinel update posted yet.",
    tracks: "Tracks",
    verdict: "verdict",
    attempt: "attempt",
  },
  "zh-TW": {
    title: "Teamwork 專案請求",
    project: "專案",
    workingDirectory: "工作目錄",
    integrityMode: "完整性模式",
    status: "狀態",
    objectives: "目標與範疇",
    requirements: "需求",
    verification: "獨立驗證",
    acceptanceCriteria: "驗收標準",
    plan: "Teamwork 專案計畫",
    milestones: "里程碑",
    noPlan: "協調者尚未記錄里程碑計畫。",
    progress: "Teamwork 進度",
    phase: "階段",
    milestoneProgress: "里程碑進度",
    latestUpdate: "最新 Sentinel 更新",
    noUpdate: "尚無 Sentinel 更新。",
    tracks: "Track",
    verdict: "判定",
    attempt: "嘗試",
  },
  "zh-CN": {
    title: "Teamwork 项目请求",
    project: "项目",
    workingDirectory: "工作目录",
    integrityMode: "完整性模式",
    status: "状态",
    objectives: "目标与范畴",
    requirements: "需求",
    verification: "独立验证",
    acceptanceCriteria: "验收标准",
    plan: "Teamwork 项目计划",
    milestones: "里程碑",
    noPlan: "协调者尚未记录里程碑计划。",
    progress: "Teamwork 进度",
    phase: "阶段",
    milestoneProgress: "里程碑进度",
    latestUpdate: "最新 Sentinel 更新",
    noUpdate: "尚无 Sentinel 更新。",
    tracks: "Track",
    verdict: "判定",
    attempt: "尝试",
  },
}

function labels(locale: TeamworkLocale) {
  return LABELS[locale] ?? LABELS.en
}

function iso(timestamp: number) {
  return new Date(timestamp * 1000).toISOString()
}

export function renderRequestArtifact(project: Project) {
  const label = labels(project.brief.artifactLocale)
  return [
    `# ${label.title}: ${project.slug}`,
    "",
    `- ${label.project}: ${project.slug}`,
    `- ${label.workingDirectory}: ${project.workingDirectory ?? "n/a"}`,
    `- ${label.integrityMode}: ${project.brief.integrityMode}`,
    `- ${label.status}: ${project.phase}`,
    "",
    `## ${label.objectives}`,
    "",
    project.brief.objectives,
    "",
    `## ${label.requirements}`,
    "",
    project.brief.requirements,
    "",
    `## ${label.verification}`,
    "",
    project.brief.verification,
    "",
    `## ${label.acceptanceCriteria}`,
    "",
    project.brief.acceptanceCriteria,
    "",
  ].join("\n")
}

export function renderPlanArtifact(project: Project) {
  const label = labels(project.brief.artifactLocale)
  const lines = [`# ${label.plan}: ${project.slug}`, ""]
  if (project.milestones.length === 0) {
    lines.push(`_${label.noPlan}_`, "")
    return lines.join("\n")
  }
  lines.push(`## ${label.milestones}`, "")
  project.milestones.forEach((milestone, index) => {
    const active = index === project.activeMilestoneIndex ? " *(active)*" : ""
    lines.push(`### ${milestone.id}: ${milestone.title} [${milestone.status}]${active}`, "")
    lines.push(milestone.description, "")
    if (milestone.tracks.length > 0) {
      lines.push(`**${label.tracks}:**`, "")
      for (const track of milestone.tracks) {
        const files = track.assignedFiles.length > 0 ? ` — files: ${track.assignedFiles.join(", ")}` : ""
        const report = track.lastReport ? ` — ${label.verdict}: ${track.lastReport.verdict}` : ""
        lines.push(`- ${track.id} [${track.status}] (${track.role}) ${track.title}${files}${report}`)
      }
      lines.push("")
    }
  })
  return lines.join("\n")
}

export function renderProgressArtifact(project: Project) {
  const label = labels(project.brief.artifactLocale)
  const lines = [
    `# ${label.progress}: ${project.slug}`,
    "",
    `- ${label.phase}: ${project.phase}`,
    `- ${label.milestoneProgress}: ${project.milestones.filter((m) => m.status === "passed").length}/${project.milestones.length}`,
    "",
  ]
  if (project.sentinelUpdate) {
    lines.push(`## ${label.latestUpdate}`, "", `- ${iso(project.sentinelUpdate.timestamp)} — ${project.sentinelUpdate.message}`, "")
  } else {
    lines.push(`## ${label.latestUpdate}`, "", `_${label.noUpdate}_`, "")
  }
  lines.push(`## ${label.milestoneProgress}`, "")
  for (const milestone of project.milestones) {
    lines.push(`- ${milestone.id} [${milestone.status}] ${milestone.title}`)
    for (const track of milestone.tracks) {
      const report = track.lastReport ? ` — ${label.verdict}: ${track.lastReport.verdict}` : ""
      lines.push(`  - ${track.id} [${track.status}] (${track.role}, ${label.attempt} ${track.attempt}) ${track.title}${report}`)
    }
  }
  lines.push("")
  return lines.join("\n")
}

async function writeFileAtomicallyEnough(path: string, content: string) {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, content, "utf8")
}

/** Writes all three artifacts and returns their paths. */
export async function writeArtifacts(directory: string, project: Project) {
  const paths = artifactPaths(directory, project.slug)
  await mkdir(paths.dir, { recursive: true, mode: 0o700 })
  await writeFileAtomicallyEnough(paths.request, renderRequestArtifact(project))
  await writeFileAtomicallyEnough(paths.plan, renderPlanArtifact(project))
  await writeFileAtomicallyEnough(paths.progress, renderProgressArtifact(project))
  return { request: paths.request, plan: paths.plan, progress: paths.progress }
}

/** Refreshes the plan and progress artifacts after state changes. */
export async function refreshPlanAndProgress(directory: string, project: Project) {
  const paths = artifactPaths(directory, project.slug)
  await writeFileAtomicallyEnough(paths.plan, renderPlanArtifact(project))
  await writeFileAtomicallyEnough(paths.progress, renderProgressArtifact(project))
  return { plan: paths.plan, progress: paths.progress }
}
