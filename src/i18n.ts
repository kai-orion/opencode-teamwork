export type TeamworkLocale = "en" | "zh-TW" | "zh-CN"

export type Phase =
  | "interview"
  | "awaitingApproval"
  | "executing"
  | "paused"
  | "budgetLimited"
  | "complete"
  | "cancelled"

export type IntegrityMode = "development" | "demo" | "benchmark"

export type TeamworkMessages = {
  commands: {
    teamworkDescription: string
    approveDescription: string
    reviseDescription: string
    statusDescription: string
    pauseDescription: string
    resumeDescription: string
    cancelDescription: string
  }
  tools: {
    createProject: string
    submitReport: string
    getProject: string
    projectName: string
    brief: string
    requirements: string
    verification: string
    acceptanceCriteria: string
    integrityMode: string
    artifactLocale: string
    role: string
    verdict: string
    findings: string
    evidence: string
    blockers: string
    artifactsWritten: string
    tokenBudget: string
    maxAutoTurns: string
    maxDurationSeconds: string
  }
  notices: {
    planModeCreate: string
    duplicateProject: string
    noProject: string
    notAwaitingApproval: string
    notExecuting: string
    closedProject: string
    budgetLimitedProject: string
  }
  reports: {
    noProject: string
    timeUsed: string
    tokenUsage: string
    milestone: string
    integrityMode: string
    evidence: string
    blocker: string
    seconds: string
    activeTracks: string
    latestUpdate: string
  }
  tui: {
    title: string
    commandDescription: string
    refresh: string
    refreshDescription: string
    status: string
    statusDescription: string
    pause: string
    pauseDescription: string
    resume: string
    resumeDescription: string
    cancel: string
    cancelDescription: string
    refreshPrompt: string
    statusPrompt: string
    pausePrompt: string
    resumePrompt: string
    cancelPrompt: string
    openSession: string
    noProject: string
    project: string
    phase: string
    integrity: string
    milestoneProgress: string
    tracks: string
    time: string
    tokens: string
    tokensRemaining: string
    latestUpdate: string
    completed: string
    cancelled: string
    paused: string
  }
}

const EN_MESSAGES: TeamworkMessages = {
  commands: {
    teamworkDescription: "Start a Teamwork project: scoping interview, then an autonomous multi-agent build",
    approveDescription: "Approve the reviewed prompt artifact and start Phase 2 execution",
    reviseDescription: "Apply revision instructions to the prompt artifact and wait for approval again",
    statusDescription: "Show the current Teamwork project status",
    pauseDescription: "Pause the running Teamwork team",
    resumeDescription: "Resume the paused Teamwork team",
    cancelDescription: "Cancel the Teamwork project for this session",
  },
  tools: {
    createProject:
      "Commit the Phase 1 scoping interview results as a Teamwork project. Call this only after the interview has " +
      "converged: the user has confirmed objectives, requirements, independent verification, acceptance criteria, " +
      "the working directory, and an integrity mode. This persists the prompt artifact, records the project state, " +
      "and returns the artifact paths for the user to review.",
    submitReport:
      "Submit the structured final report for the currently assigned teamwork task. Required before the task " +
      "session ends: a session that finishes without submitting this report is treated as having failed the task.",
    getProject:
      "Get the current Teamwork project for this OpenCode session, including phase, integrity mode, milestone " +
      "progress, active tracks, budgets, and the latest Sentinel update.",
    projectName: "Short project slug used for the artifact directory (kebab-case).",
    brief: "Project objectives and scope: what to build, its purpose, and the audience.",
    requirements: "Requirement blocks covering what the user actually cares about.",
    verification: "Independent verification method per requirement: test suites, benchmarks, or rubric-judged review.",
    acceptanceCriteria: "Clear, testable criteria for considering the project complete.",
    integrityMode: "Verification strictness: development (default), demo, or benchmark.",
    artifactLocale: "Language for the artifacts: en, zh-TW, or zh-CN.",
    role: "The reporting role: explorer, worker, critic, challenger, auditor, orchestrator, or successAuditor.",
    verdict: "The role's verdict: pass, fail, or blocked.",
    findings: "Concrete findings from this role's pass.",
    evidence: "Concrete evidence: command output, test results, file references.",
    blockers: "Anything blocking this task from proceeding.",
    artifactsWritten: "Paths of files this role created or modified, if any.",
    tokenBudget: "Optional positive token budget for the whole team (all role sessions combined).",
    maxAutoTurns: "Optional cap on the number of role sessions the team may spawn.",
    maxDurationSeconds: "Optional wall-clock limit for the whole project.",
  },
  notices: {
    planModeCreate:
      "Project recorded while the session is in Plan mode, so execution is paused. Do not start implementation " +
      "work now. Ask the user to switch to Build mode and resume the project (for example with " +
      '"/teamwork resume") to begin execution.',
    duplicateProject:
      "This non-closed project already exists. Do not call teamwork_create_project again. Review the existing " +
      "prompt artifact and use /teamwork-revise or /teamwork-approve instead.",
    noProject:
      "This session has no Teamwork project. Start one with \"/teamwork <prompt>\" before using this command.",
    notAwaitingApproval: "The project is not awaiting approval. /teamwork-approve only works after the Phase 1 " +
      "interview has produced a prompt artifact.",
    notExecuting: "The project is not currently executing. Pause and resume only apply during Phase 2.",
    closedProject: "This project is already closed. Start a new project with \"/teamwork <prompt>\".",
    budgetLimitedProject:
      "Safety limit reached. Do not start or continue substantive work for this project. Summarize useful " +
      "progress, remaining work, and blockers, then wait for the user to resume the project.",
  },
  reports: {
    noProject: "No Teamwork project is set for this session.",
    timeUsed: "Time used",
    tokenUsage: "Token usage",
    milestone: "Milestone",
    integrityMode: "Integrity mode",
    evidence: "Evidence",
    blocker: "Blocker",
    seconds: "seconds",
    activeTracks: "Active tracks",
    latestUpdate: "Latest Sentinel update",
  },
  tui: {
    title: "Teamwork",
    commandDescription: "View, pause, resume, or cancel the Teamwork project",
    refresh: "Refresh",
    refreshDescription: "Ask the agent to read the current project state",
    status: "Status",
    statusDescription: "Ask the agent to show detailed project status",
    pause: "Pause",
    pauseDescription: "Pause the running team",
    resume: "Resume",
    resumeDescription: "Resume the paused team",
    cancel: "Cancel",
    cancelDescription: "Cancel this session's project",
    refreshPrompt: "Call teamwork_get_project for this session and report the current project state briefly.",
    statusPrompt: "Call teamwork_get_project for this session and report detailed project status, including all milestones and tracks.",
    pausePrompt: 'Pause the current session project by calling teamwork_pause. Report the result briefly.',
    resumePrompt: 'Resume the current session project by calling teamwork_resume, then the team continues autonomously. Report the result briefly.',
    cancelPrompt: "Cancel the current session project by calling teamwork_cancel. Report whether a project was cancelled.",
    openSession: "Open a session before viewing project state.",
    noProject: "No recent Teamwork project state found in this session.",
    project: "Project",
    phase: "Phase",
    integrity: "Integrity",
    milestoneProgress: "Milestones",
    tracks: "Active tracks",
    time: "Time",
    tokens: "Tokens",
    tokensRemaining: "Tokens remaining",
    latestUpdate: "Latest update",
    completed: "Project completed",
    cancelled: "Project cancelled",
    paused: "Project paused",
  },
}

const ZH_TW_MESSAGES: TeamworkMessages = {
  commands: {
    teamworkDescription: "啟動 Teamwork 專案：先進行範疇面談，再由多代理團隊自主執行",
    approveDescription: "批准已審閱的 prompt artifact，開始第二階段執行",
    reviseDescription: "將修改指示套用到 prompt artifact，重新等待批准",
    statusDescription: "顯示目前 Teamwork 專案狀態",
    pauseDescription: "暫停執行中的 Teamwork 團隊",
    resumeDescription: "恢復已暫停的 Teamwork 團隊",
    cancelDescription: "取消此 session 的 Teamwork 專案",
  },
  tools: {
    createProject:
      "將第一階段面談結果提交為 Teamwork 專案。只在面談收斂後呼叫：使用者已確認目標、需求、獨立驗證方式、" +
      "驗收標準、工作目錄與 integrity mode。此工具會寫入 prompt artifact、記錄專案狀態，並回傳 artifact 路徑供使用者審閱。",
    submitReport:
      "提交目前所指派 teamwork 任務的結構化最終報告。必須在任務 session 結束前呼叫：未提交報告就結束的 " +
      "session 會被視為任務失敗。",
    getProject:
      "取得此 OpenCode session 目前的 Teamwork 專案，包括 phase、integrity mode、里程碑進度、活躍 track、" +
      "預算與最新的 Sentinel 更新。",
    projectName: "專案簡短代號，用於 artifact 目錄（kebab-case）。",
    brief: "專案目標與範疇：要建什麼、其目的與受眾。",
    requirements: "需求區塊，只涵蓋使用者真正在意的內容。",
    verification: "每項需求的獨立驗證方式：測試套件、效能基準，或依明確 rubric 評審的獨立代理。",
    acceptanceCriteria: "判定專案完成的明確、可測試的標準。",
    integrityMode: "驗證嚴格度：development（預設）、demo 或 benchmark。",
    artifactLocale: "Artifact 語言：en、zh-TW 或 zh-CN。",
    role: "回報角色：explorer、worker、critic、challenger、auditor、orchestrator 或 successAuditor。",
    verdict: "該角色的判定：pass、fail 或 blocked。",
    findings: "該角色審查後的具體發現。",
    evidence: "具體證據：指令輸出、測試結果、檔案參照。",
    blockers: "阻礙此任務繼續的事項。",
    artifactsWritten: "該角色建立或修改的檔案路徑（若有的話）。",
    tokenBudget: "整個團隊（所有角色 session 合計）的選填 token 預算。",
    maxAutoTurns: "團隊可建立的角色 session 數量上限（選填）。",
    maxDurationSeconds: "整個專案的時間上限（選填）。",
  },
  notices: {
    planModeCreate:
      "專案已在 Plan 模式下記錄，因此執行被暫停。現在不要開始實作工作。請讓使用者切換到 Build 模式並恢復專案" +
      '（例如使用「/teamwork resume」）後再開始執行。',
    duplicateProject:
      "這個未關閉的專案已經存在。不要再次呼叫 teamwork_create_project。請審閱現有的 prompt artifact，" +
      "並改用 /teamwork-revise 或 /teamwork-approve。",
    noProject: "此 session 沒有 Teamwork 專案。請先用「/teamwork <prompt>」啟動專案。",
    notAwaitingApproval: "專案目前不在等待批准狀態。/teamwork-approve 只能在第一階段面談產出 prompt artifact 後使用。",
    notExecuting: "專案目前沒有在執行。暫停與恢復只在第二階段有效。",
    closedProject: "此專案已關閉。請用「/teamwork <prompt>」啟動新專案。",
    budgetLimitedProject:
      "已達到安全限制。不要開始或繼續此專案的實質工作。請總結已有進展、剩餘工作與阻塞項，然後等待使用者恢復專案。",
  },
  reports: {
    noProject: "此 session 沒有設定 Teamwork 專案。",
    timeUsed: "已用時間",
    tokenUsage: "Token 用量",
    milestone: "里程碑",
    integrityMode: "完整性模式",
    evidence: "證據",
    blocker: "阻塞原因",
    seconds: "秒",
    activeTracks: "活躍 track",
    latestUpdate: "最新 Sentinel 更新",
  },
  tui: {
    title: "Teamwork",
    commandDescription: "查看、暫停、恢復或取消 Teamwork 專案",
    refresh: "重新整理",
    refreshDescription: "讓代理讀取目前專案狀態",
    status: "狀態",
    statusDescription: "讓代理顯示詳細專案狀態",
    pause: "暫停",
    pauseDescription: "暫停執行中的團隊",
    resume: "恢復",
    resumeDescription: "恢復已暫停的團隊",
    cancel: "取消",
    cancelDescription: "取消此 session 的專案",
    refreshPrompt: "呼叫 teamwork_get_project 取得此 session 的目前專案，並用繁體中文簡要回報專案狀態。",
    statusPrompt: "呼叫 teamwork_get_project 取得此 session 的專案，並用繁體中文詳細回報所有里程碑與 track 狀態。",
    pausePrompt: "呼叫 teamwork_pause 暫停此 session 的專案。用繁體中文簡要回報結果。",
    resumePrompt: "呼叫 teamwork_resume 恢復此 session 的專案，團隊會自動繼續執行。用繁體中文簡要回報結果。",
    cancelPrompt: "呼叫 teamwork_cancel 取消此 session 的專案。用繁體中文回報是否成功取消。",
    openSession: "請先開啟一個 session，再查看專案狀態。",
    noProject: "此 session 中沒有最近的 Teamwork 專案狀態。",
    project: "專案",
    phase: "階段",
    integrity: "完整性",
    milestoneProgress: "里程碑",
    tracks: "活躍 track",
    time: "時間",
    tokens: "Token",
    tokensRemaining: "剩餘 Token",
    latestUpdate: "最新更新",
    completed: "專案已完成",
    cancelled: "專案已取消",
    paused: "專案已暫停",
  },
}

const ZH_CN_MESSAGES: TeamworkMessages = {
  commands: {
    teamworkDescription: "启动 Teamwork 项目：先进行范畴面谈，再由多智能体团队自主执行",
    approveDescription: "批准已审阅的 prompt artifact，开始第二阶段执行",
    reviseDescription: "将修改指示套用到 prompt artifact，重新等待批准",
    statusDescription: "显示当前 Teamwork 项目状态",
    pauseDescription: "暂停执行中的 Teamwork 团队",
    resumeDescription: "恢复已暂停的 Teamwork 团队",
    cancelDescription: "取消此 session 的 Teamwork 项目",
  },
  tools: {
    createProject:
      "将第一阶段面谈结果提交为 Teamwork 项目。只在面谈收敛后调用：用户已确认目标、需求、独立验证方式、" +
      "验收标准、工作目录与 integrity mode。此工具会写入 prompt artifact、记录项目状态，并返回 artifact 路径供用户审阅。",
    submitReport:
      "提交当前所指派 teamwork 任务的结构化最终报告。必须在任务 session 结束前调用：未提交报告就结束的 " +
      "session 会被视为任务失败。",
    getProject:
      "获取此 OpenCode session 当前的 Teamwork 项目，包括 phase、integrity mode、里程碑进度、活跃 track、" +
      "预算与最新的 Sentinel 更新。",
    projectName: "项目简短代号，用于 artifact 目录（kebab-case）。",
    brief: "项目目标与范畴：要建什么、其目的与受众。",
    requirements: "需求区块，只涵盖用户真正在意的内容。",
    verification: "每项需求的独立验证方式：测试套件、性能基准，或依明确 rubric 评审的独立智能体。",
    acceptanceCriteria: "判定项目完成的明确、可测试的标准。",
    integrityMode: "验证严格度：development（默认）、demo 或 benchmark。",
    artifactLocale: "Artifact 语言：en、zh-TW 或 zh-CN。",
    role: "回报角色：explorer、worker、critic、challenger、auditor、orchestrator 或 successAuditor。",
    verdict: "该角色的判定：pass、fail 或 blocked。",
    findings: "该角色审查后的具体发现。",
    evidence: "具体证据：命令输出、测试结果、文件参照。",
    blockers: "阻碍此任务继续的事项。",
    artifactsWritten: "该角色创建或修改的文件路径（如果有的话）。",
    tokenBudget: "整个团队（所有角色 session 合计）的选填 token 预算。",
    maxAutoTurns: "团队可创建的角色 session 数量上限（选填）。",
    maxDurationSeconds: "整个项目的时间上限（选填）。",
  },
  notices: {
    planModeCreate:
      "项目已在 Plan 模式下记录，因此执行被暂停。现在不要开始实现工作。请让用户切换到 Build 模式并恢复项目" +
      "（例如使用「/teamwork resume」）后再开始执行。",
    duplicateProject:
      "这个未关闭的项目已经存在。不要再次调用 teamwork_create_project。请审阅现有的 prompt artifact，" +
      "并改用 /teamwork-revise 或 /teamwork-approve。",
    noProject: "此 session 没有 Teamwork 项目。请先用「/teamwork <prompt>」启动项目。",
    notAwaitingApproval: "项目当前不在等待批准状态。/teamwork-approve 只能在第一阶段面谈产出 prompt artifact 后使用。",
    notExecuting: "项目当前没有在执行。暂停与恢复只在第二阶段有效。",
    closedProject: "此项目已关闭。请用「/teamwork <prompt>」启动新项目。",
    budgetLimitedProject:
      "已达到安全限制。不要开始或继续此项目的实质性工作。请总结已有进展、剩余工作与阻塞项，然后等待用户恢复项目。",
  },
  reports: {
    noProject: "此 session 没有设定 Teamwork 项目。",
    timeUsed: "已用时间",
    tokenUsage: "Token 用量",
    milestone: "里程碑",
    integrityMode: "完整性模式",
    evidence: "证据",
    blocker: "阻塞原因",
    seconds: "秒",
    activeTracks: "活跃 track",
    latestUpdate: "最新 Sentinel 更新",
  },
  tui: {
    title: "Teamwork",
    commandDescription: "查看、暂停、恢复或取消 Teamwork 项目",
    refresh: "刷新",
    refreshDescription: "让智能体读取当前项目状态",
    status: "状态",
    statusDescription: "让智能体显示详细项目状态",
    pause: "暂停",
    pauseDescription: "暂停执行中的团队",
    resume: "恢复",
    resumeDescription: "恢复已暂停的团队",
    cancel: "取消",
    cancelDescription: "取消此 session 的项目",
    refreshPrompt: "调用 teamwork_get_project 获取此 session 的当前项目，并用简体中文简要报告项目状态。",
    statusPrompt: "调用 teamwork_get_project 获取此 session 的项目，并用简体中文详细报告所有里程碑与 track 状态。",
    pausePrompt: "调用 teamwork_pause 暂停此 session 的项目。用简体中文简要报告结果。",
    resumePrompt: "调用 teamwork_resume 恢复此 session 的项目，团队会自动继续执行。用简体中文简要报告结果。",
    cancelPrompt: "调用 teamwork_cancel 取消此 session 的项目。用简体中文报告是否成功取消。",
    openSession: "请先打开一个 session，再查看项目状态。",
    noProject: "此 session 中没有最近的 Teamwork 项目状态。",
    project: "项目",
    phase: "阶段",
    integrity: "完整性",
    milestoneProgress: "里程碑",
    tracks: "活跃 track",
    time: "时间",
    tokens: "Token",
    tokensRemaining: "剩余 Token",
    latestUpdate: "最新更新",
    completed: "项目已完成",
    cancelled: "项目已取消",
    paused: "项目已暂停",
  },
}

type LocaleEnvironment = {
  LC_ALL?: string
  LANG?: string
}

function normalizeLocaleCandidate(value: string | null | undefined): TeamworkLocale | null {
  if (!value?.trim()) return null
  const normalized = value.trim().replaceAll("_", "-").split(".")[0]!.split("@")[0]!.toLowerCase()
  if (normalized === "c" || normalized === "posix") return null
  if (normalized === "zh-tw" || normalized === "zh-hant" || normalized === "zh-hant-tw") return "zh-TW"
  if (normalized === "zh-hans" || normalized === "zh-hans-cn") return "zh-CN"
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN"
  if (normalized === "en" || normalized.startsWith("en-")) return "en"
  return null
}

function processEnvironment(): LocaleEnvironment {
  if (typeof process === "undefined") return {}
  return {
    LC_ALL: process.env.LC_ALL,
    LANG: process.env.LANG,
  }
}

function systemLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return undefined
  }
}

export function resolveLocale(
  explicit?: string | null,
  environment: LocaleEnvironment = processEnvironment(),
  osLocale: string | undefined = systemLocale(),
): TeamworkLocale {
  const configured = explicit?.trim()
  if (!configured) return "en"
  if (configured.toLowerCase() !== "auto") return normalizeLocaleCandidate(configured) ?? "en"

  for (const candidate of [environment.LC_ALL, environment.LANG, osLocale]) {
    const locale = normalizeLocaleCandidate(candidate)
    if (locale) return locale
  }
  return "en"
}

export function isTeamworkLocale(value: string | null | undefined): value is TeamworkLocale {
  return value === "en" || value === "zh-TW" || value === "zh-CN"
}

export function messagesFor(locale: TeamworkLocale): TeamworkMessages {
  if (locale === "zh-TW") return ZH_TW_MESSAGES
  if (locale === "zh-CN") return ZH_CN_MESSAGES
  return EN_MESSAGES
}

const PHASE_PRESENTATIONS: Record<TeamworkLocale, Record<Phase, string>> = {
  en: {
    interview: "scoping interview",
    awaitingApproval: "awaiting approval",
    executing: "executing",
    paused: "paused",
    budgetLimited: "budget limited",
    complete: "complete",
    cancelled: "cancelled",
  },
  "zh-TW": {
    interview: "範疇面談中",
    awaitingApproval: "等待批准",
    executing: "執行中",
    paused: "已暫停",
    budgetLimited: "預算已達上限",
    complete: "已完成",
    cancelled: "已取消",
  },
  "zh-CN": {
    interview: "范畴面谈中",
    awaitingApproval: "等待批准",
    executing: "执行中",
    paused: "已暂停",
    budgetLimited: "预算已达上限",
    complete: "已完成",
    cancelled: "已取消",
  },
}

/** Formats protocol phase values only at user-facing presentation boundaries. */
export function presentPhase(phase: string, locale: TeamworkLocale): string {
  return PHASE_PRESENTATIONS[locale][phase as Phase] ?? phase
}

const INTEGRITY_PRESENTATIONS: Record<TeamworkLocale, Record<IntegrityMode, string>> = {
  en: {
    development: "development",
    demo: "demo",
    benchmark: "benchmark",
  },
  "zh-TW": {
    development: "開發模式",
    demo: "展示模式",
    benchmark: "評測模式",
  },
  "zh-CN": {
    development: "开发模式",
    demo: "展示模式",
    benchmark: "评测模式",
  },
}

export function presentIntegrityMode(mode: string, locale: TeamworkLocale): string {
  return INTEGRITY_PRESENTATIONS[locale][mode as IntegrityMode] ?? mode
}

const ROLE_PRESENTATIONS: Record<TeamworkLocale, Record<string, string>> = {
  en: {
    sentinel: "Sentinel",
    orchestrator: "Project Orchestrator",
    explorer: "Explorer",
    worker: "Worker",
    critic: "Critic",
    challenger: "Challenger",
    auditor: "Auditor",
    successAuditor: "Success Auditor",
  },
  "zh-TW": {
    sentinel: "Sentinel",
    orchestrator: "專案協調者",
    explorer: "探索者",
    worker: "實作工人",
    critic: "審查者",
    challenger: "挑戰者",
    auditor: "稽核者",
    successAuditor: "成功稽核者",
  },
  "zh-CN": {
    sentinel: "Sentinel",
    orchestrator: "项目协调者",
    explorer: "探索者",
    worker: "实现工人",
    critic: "审查者",
    challenger: "挑战者",
    auditor: "稽核者",
    successAuditor: "成功稽核者",
  },
}

export function presentRole(role: string, locale: TeamworkLocale): string {
  return ROLE_PRESENTATIONS[locale][role] ?? role
}

const HISTORY_TYPE_PRESENTATIONS: Record<TeamworkLocale, Record<string, string>> = {
  en: {},
  "zh-TW": {
    created: "已建立",
    updated: "已更新",
    artifact: "Artifact",
    approved: "已批准",
    paused: "已暫停",
    resumed: "已恢復",
    milestone: "里程碑",
    verification: "驗證",
    completed: "已完成",
    cancelled: "已取消",
    warning: "警告",
    limited: "已受限",
    error: "錯誤",
  },
  "zh-CN": {
    created: "已创建",
    updated: "已更新",
    artifact: "Artifact",
    approved: "已批准",
    paused: "已暂停",
    resumed: "已恢复",
    milestone: "里程碑",
    verification: "验证",
    completed: "已完成",
    cancelled: "已取消",
    warning: "警告",
    limited: "已受限",
    error: "错误",
  },
}

export function presentHistoryType(type: string, locale: TeamworkLocale): string {
  return HISTORY_TYPE_PRESENTATIONS[locale][type] ?? type
}

export type PresentableProjectHistory = {
  history: Array<{ type: string; detail: string; timestamp: number }>
}

export function formatProjectHistory(project: PresentableProjectHistory | null, locale: TeamworkLocale): string {
  if (!project) {
    return locale === "en" ? "No project history is available for this session." : "此 session 沒有可用的專案歷史。"
  }
  if (project.history.length === 0) {
    return locale === "en" ? "No project history recorded yet." : "尚未記錄專案歷史。"
  }
  return project.history
    .map((entry) => {
      const timestamp = new Date(entry.timestamp * 1000).toISOString()
      const type = presentHistoryType(entry.type, locale)
      return `- [${timestamp}] ${type}: ${entry.detail}`
    })
    .join("\n")
}
