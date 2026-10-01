import type { TuiCommand, TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Plugin as TuiPluginV2 } from "@opencode/plugin/tui"
import { createElement, insert, setProp } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { getProjectSync } from "./state"
import type { ProjectSnapshot } from "./state"

/**
 * The Teamwork sidebar reads the shared project state file directly
 * (`getProjectSync`). State writes are atomic (temp file + rename), so every
 * read observes the old or the new valid state, never a torn one — no message
 * scanning required. A 1-second poll keeps the live clock and track counts
 * fresh while the project executes.
 */

const TUI_COPY = {
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
  pausePrompt: "Pause the current session project by calling teamwork_pause. Report the result briefly.",
  resumePrompt: "Resume the current session project by calling teamwork_resume, then the team continues autonomously. Report the result briefly.",
  cancelPrompt: "Cancel the current session project by calling teamwork_cancel. Report whether a project was cancelled.",
  openSession: "Open a session before viewing project state.",
  noProject: "No recent Teamwork project state found in this session.",
  project: "Project",
  phase: "Phase",
  path: "Path",
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
  blocker: "Blocker",
}

type ElementChild = string | number | boolean | null | undefined | object | (() => ElementChild)

function element(tag: string, props: Record<string, unknown>, children: ElementChild[] = []) {
  const node = createElement(tag)
  for (const [key, value] of Object.entries(props)) if (value !== undefined) setProp(node, key, value)
  for (const child of children) if (child !== null && child !== undefined && child !== false) insert(node, child)
  return node
}

function text(props: Record<string, unknown>, children: ElementChild[]) {
  return element("text", props, children)
}

function box(props: Record<string, unknown>, children: ElementChild[] = []) {
  return element("box", props, children)
}

type SlotRender = (props: { sessionID: string }) => unknown
type SlotDispose = () => void

const noopDispose: SlotDispose = () => {}

/**
 * Registers a V2 TUI slot across both plugin-context generations.
 *
 * Early V2 previews exposed `ui.slot(name, render)`. Current previews expose a
 * single options argument, `ui.slot({ append, render })`, and silently register
 * nothing when handed the positional pair — which is how the goal sidebar and
 * the palette keymap layer both disappeared. Branch on the callback arity so
 * either host works, and tolerate hosts that return no disposer.
 */
export function registerSlotV2(context: TuiPluginV2.Context, name: string, render: SlotRender): SlotDispose {
  const slot = context.ui.slot as unknown as (...args: unknown[]) => unknown
  const dispose = slot.length <= 1 ? slot({ append: name, render }) : slot(name, render)
  return typeof dispose === "function" ? (dispose as SlotDispose) : noopDispose
}

/**
 * Reads a theme color by trying each candidate path in order, descending into a
 * `default` leaf when the resolved node is a color group.
 */
export function themeColorV2(theme: unknown, ...paths: readonly (readonly string[])[]): unknown {
  for (const path of paths) {
    let cursor: unknown = theme
    for (const key of path) {
      if (cursor === null || typeof cursor !== "object") {
        cursor = undefined
        break
      }
      cursor = (cursor as Record<string, unknown>)[key]
    }
    if (cursor !== null && typeof cursor === "object" && "default" in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>).default
    }
    if (cursor !== undefined && cursor !== null) return cursor
  }
  return undefined
}

function projectColorsV2(theme: unknown) {
  return {
    text: themeColorV2(theme, ["text", "default"], ["text"]),
    muted: themeColorV2(theme, ["text", "subdued"], ["textMuted"]),
    success: themeColorV2(theme, ["text", "feedback", "success"], ["primary"], ["text", "default"], ["text"]),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Structural guard for snapshots read back from the shared state file. */
export function isProjectSnapshot(value: unknown): value is ProjectSnapshot {
  if (!isRecord(value)) return false
  if (typeof value.sessionID !== "string") return false
  if (typeof value.slug !== "string") return false
  if (!isRecord(value.brief)) return false
  if (typeof value.phase !== "string") return false
  if (
    !["interview", "awaitingApproval", "executing", "paused", "budgetLimited", "complete", "cancelled"].includes(
      String(value.phase),
    )
  ) {
    return false
  }
  if (typeof value.tokensUsed !== "number") return false
  if (typeof value.timeUsedSeconds !== "number") return false
  if (!Array.isArray(value.milestones)) return false
  if (typeof value.sampledAt !== "number") return false
  return true
}

function currentEpochSeconds() {
  return Math.floor(Date.now() / 1000)
}

export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const paddedSecs = String(secs).padStart(2, "0")
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSecs}`
  return `${minutes}:${paddedSecs}`
}

export function liveTimeUsedSeconds(project: ProjectSnapshot, nowSeconds = currentEpochSeconds()) {
  const baseSeconds = Math.max(0, Math.floor(project.timeUsedSeconds))
  if (project.phase !== "executing") return baseSeconds
  if (typeof project.sampledAt !== "number") return baseSeconds
  return baseSeconds + Math.max(0, Math.floor(nowSeconds - project.sampledAt))
}

export function activeTrackCount(project: ProjectSnapshot) {
  return project.milestones.reduce(
    (sum, milestone) => sum + milestone.tracks.filter((track) => track.status === "running").length,
    0,
  )
}

export function milestoneProgress(project: ProjectSnapshot) {
  const passed = project.milestones.filter((milestone) => milestone.status === "passed").length
  return `${passed}/${project.milestones.length}`
}

export function formatProjectSummary(project: ProjectSnapshot | null) {
  if (!project) return TUI_COPY.noProject
  const team = project.brief.teamScale ?? "default"
  const lines = [
    `${TUI_COPY.project}: ${project.slug}`,
    `${TUI_COPY.phase}: ${project.phase}`,
    `${TUI_COPY.path}: ${project.brief.executionPath} | ${TUI_COPY.integrity}: ${project.brief.integrityMode}`,
    `Speed: workers=${project.maxParallelWorkers}, team=${team}, deep=${project.brief.deep ? "on" : "off"}`,
    `${TUI_COPY.milestoneProgress}: ${milestoneProgress(project)}${
      project.activeMilestoneIndex >= 0 ? ` (m${project.activeMilestoneIndex + 1})` : ""
    }`,
    `${TUI_COPY.tracks}: ${activeTrackCount(project)}`,
    `${TUI_COPY.time}: ${formatDuration(liveTimeUsedSeconds(project))}`,
    `${TUI_COPY.tokens}: ${project.tokensUsed}${project.tokenBudget == null ? "" : `/${project.tokenBudget}`}`,
  ]
  if (project.remainingTokens != null) lines.push(`${TUI_COPY.tokensRemaining}: ${project.remainingTokens}`)
  if (project.sentinelUpdate) lines.push(`${TUI_COPY.latestUpdate}: ${project.sentinelUpdate.message}`)
  return lines.join("\n")
}

/** Reads the current project snapshot from the shared state file. */
export function projectForSession(sessionID: string): ProjectSnapshot | null {
  try {
    const project = getProjectSync(sessionID)
    return project && isProjectSnapshot(project) ? project : null
  } catch {
    return null
  }
}

function ProjectSidebar(_api: TuiPluginApi, sessionID: string) {
  const theme = _api.theme.current
  const [tick, setTick] = createSignal(currentEpochSeconds())
  const timer = setInterval(() => setTick(currentEpochSeconds()), 1000)
  onCleanup(() => clearInterval(timer))
  const project = createMemo(() => {
    void tick()
    return projectForSession(sessionID)
  })
  return box({}, [
    () => {
      const snapshot = project()
      if (!snapshot) return null
      if (snapshot.phase === "complete") {
        return text({ fg: theme.primary }, [`${TUI_COPY.completed} (${formatDuration(snapshot.timeUsedSeconds)})`])
      }
      if (snapshot.phase === "cancelled") {
        return text({ fg: theme.textMuted }, [`${TUI_COPY.cancelled} (${formatDuration(snapshot.timeUsedSeconds)})`])
      }
      return box({}, [
        text({ fg: theme.text }, [`${TUI_COPY.title}: ${snapshot.slug}`]),
        text({ fg: theme.textMuted }, [`${TUI_COPY.phase}: ${snapshot.phase}`]),
        text({ fg: theme.textMuted }, [
          () => `${TUI_COPY.time}: ${formatDuration(liveTimeUsedSeconds(snapshot, tick()))}`,
        ]),
        text({ fg: theme.textMuted }, [
          `${TUI_COPY.tokens}: ${snapshot.tokensUsed}${snapshot.tokenBudget == null ? "" : `/${snapshot.tokenBudget}`}`,
        ]),
        text({ fg: theme.textMuted }, [`${TUI_COPY.path}: ${snapshot.brief.executionPath}`]),
        text({ fg: theme.textMuted }, [`${TUI_COPY.integrity}: ${snapshot.brief.integrityMode}`]),
        text({ fg: theme.textMuted }, [
          `${TUI_COPY.milestoneProgress}: ${milestoneProgress(snapshot)}${
            snapshot.activeMilestoneIndex >= 0 ? ` (m${snapshot.activeMilestoneIndex + 1})` : ""
          }`,
        ]),
        text({ fg: theme.textMuted }, [`${TUI_COPY.tracks}: ${activeTrackCount(snapshot)}`]),
        ...(snapshot.sentinelUpdate
          ? [text({ fg: theme.textMuted }, [`${TUI_COPY.latestUpdate}: ${snapshot.sentinelUpdate.message}`])]
          : []),
        ...(snapshot.lastStatus ? [text({ fg: theme.textMuted }, [snapshot.lastStatus])] : []),
        ...(snapshot.blocker ? [text({ fg: theme.textMuted }, [`${TUI_COPY.blocker}: ${snapshot.blocker}`])] : []),
      ])
    },
  ])
}

// --- Palette command ---------------------------------------------------------

type ModernTuiApi = TuiPluginApi & {
  keymap?: {
    registerLayer?: (layer: {
      commands: {
        namespace: string
        name: string
        title: string
        desc?: string
        category?: string
        run?: () => void
      }[]
      bindings?: unknown[]
    }) => () => void
  }
}

function currentSessionID(api: TuiPluginApi) {
  const route = api.route.current
  if (route.name !== "session") return undefined
  const sessionID = route.params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function toast(api: TuiPluginApi, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
  api.ui.toast({ title: TUI_COPY.title, message, variant, duration: 2500 })
}

async function sendProjectPrompt(api: TuiPluginApi, sessionID: string, prompt: string) {
  await api.client.session.promptAsync({
    sessionID,
    parts: [{ type: "text", text: prompt }],
  })
}

function actionOption(
  api: TuiPluginApi,
  sessionID: string,
  title: string,
  value: string,
  description: string,
  prompt: string,
) {
  return {
    title,
    value,
    description,
    onSelect: () => {
      void sendProjectPrompt(api, sessionID, prompt)
        .then(() => api.ui.dialog.clear())
        .catch((error) => toast(api, error instanceof Error ? error.message : String(error), "error"))
    },
  }
}

function showProjectDialog(api: TuiPluginApi, sessionID: string) {
  const DialogSelect = api.ui.DialogSelect
  const project = projectForSession(sessionID)
  const options = [
    actionOption(api, sessionID, TUI_COPY.refresh, "refresh", TUI_COPY.refreshDescription, TUI_COPY.refreshPrompt),
    actionOption(api, sessionID, TUI_COPY.status, "status", TUI_COPY.statusDescription, TUI_COPY.statusPrompt),
    ...(project?.phase === "executing"
      ? [actionOption(api, sessionID, TUI_COPY.pause, "pause", TUI_COPY.pauseDescription, TUI_COPY.pausePrompt)]
      : []),
    ...(project?.phase === "paused"
      ? [actionOption(api, sessionID, TUI_COPY.resume, "resume", TUI_COPY.resumeDescription, TUI_COPY.resumePrompt)]
      : []),
    ...(project && project.phase !== "complete" && project.phase !== "cancelled"
      ? [actionOption(api, sessionID, TUI_COPY.cancel, "cancel", TUI_COPY.cancelDescription, TUI_COPY.cancelPrompt)]
      : []),
  ]
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() =>
    DialogSelect({
      title: TUI_COPY.title,
      placeholder: formatProjectSummary(project),
      options,
      onSelect(option) {
        option.onSelect?.()
      },
    }),
  )
}

function registerProjectCommand(api: TuiPluginApi, command: TuiCommand) {
  const modern = api as ModernTuiApi
  if (modern.keymap?.registerLayer) {
    modern.keymap.registerLayer({
      commands: [
        {
          namespace: "palette",
          name: command.value,
          title: command.title,
          desc: command.description,
          category: command.category,
          run: command.onSelect,
        },
      ],
      bindings: [],
    })
    return
  }
  api.command?.register(() => [command])
}

// --- V1 TUI plugin -----------------------------------------------------------

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 125,
    slots: {
      sidebar_content(_ctx, props) {
        return ProjectSidebar(api, props.session_id)
      },
    },
  })

  registerProjectCommand(api, {
    title: TUI_COPY.title,
    value: "teamwork.show",
    category: TUI_COPY.title,
    description: TUI_COPY.commandDescription,
    onSelect: () => {
      const sessionID = currentSessionID(api)
      if (!sessionID) {
        toast(api, TUI_COPY.openSession, "warning")
        return
      }
      showProjectDialog(api, sessionID)
    },
  })
}

// --- V2 TUI plugin -----------------------------------------------------------

function currentSessionIDV2(api: TuiPluginV2.Context) {
  const route = api.ui.router.current()
  if (route.type !== "session") return undefined
  return route.sessionID
}

function toastV2(api: TuiPluginV2.Context, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
  api.ui.toast.show({ title: TUI_COPY.title, message, variant, duration: 2500 })
}

async function showProjectDialogV2(api: TuiPluginV2.Context, sessionID: string) {
  const project = projectForSession(sessionID)
  const options = [
    { title: TUI_COPY.refresh, value: "refresh", description: TUI_COPY.refreshDescription },
    { title: TUI_COPY.status, value: "status", description: TUI_COPY.statusDescription },
    ...(project?.phase === "executing"
      ? [{ title: TUI_COPY.pause, value: "pause", description: TUI_COPY.pauseDescription }]
      : []),
    ...(project?.phase === "paused"
      ? [{ title: TUI_COPY.resume, value: "resume", description: TUI_COPY.resumeDescription }]
      : []),
    ...(project && project.phase !== "complete" && project.phase !== "cancelled"
      ? [{ title: TUI_COPY.cancel, value: "cancel", description: TUI_COPY.cancelDescription }]
      : []),
  ]
  api.ui.dialog.set({ size: "large" })
  const selected = await api.ui.dialog.select({
    title: TUI_COPY.title,
    placeholder: formatProjectSummary(project),
    options,
  })
  const prompt =
    selected === "refresh" ? TUI_COPY.refreshPrompt
    : selected === "status" ? TUI_COPY.statusPrompt
    : selected === "pause" ? TUI_COPY.pausePrompt
    : selected === "resume" ? TUI_COPY.resumePrompt
    : selected === "cancel" ? TUI_COPY.cancelPrompt
    : undefined
  if (!prompt) return
  try {
    await api.client.session.prompt({ sessionID, text: prompt })
  } catch (error) {
    toastV2(api, error instanceof Error ? error.message : String(error), "error")
  }
}

function ProjectSidebarV2(api: TuiPluginV2.Context, sessionID: string) {
  const colors = projectColorsV2(api.theme)
  const [tick, setTick] = createSignal(currentEpochSeconds())
  createEffect(() => {
    const timer = setInterval(() => setTick(currentEpochSeconds()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const project = createMemo(() => {
    void tick()
    return projectForSession(sessionID)
  })
  return box({}, [
    () => {
      const snapshot = project()
      if (!snapshot) return null
      if (snapshot.phase === "complete") {
        return text({ fg: colors.success }, [`${TUI_COPY.completed} (${formatDuration(snapshot.timeUsedSeconds)})`])
      }
      if (snapshot.phase === "cancelled") {
        return text({ fg: colors.muted }, [`${TUI_COPY.cancelled} (${formatDuration(snapshot.timeUsedSeconds)})`])
      }
      return box({}, [
        text({ fg: colors.text }, [`${TUI_COPY.title}: ${snapshot.slug}`]),
        text({ fg: colors.muted }, [`${TUI_COPY.phase}: ${snapshot.phase}`]),
        text({ fg: colors.muted }, [`${TUI_COPY.path}: ${snapshot.brief.executionPath}`]),
        text({ fg: colors.muted }, [`${TUI_COPY.integrity}: ${snapshot.brief.integrityMode}`]),
        text({ fg: colors.muted }, [() => `${TUI_COPY.time}: ${formatDuration(liveTimeUsedSeconds(snapshot, tick()))}`]),
        text({ fg: colors.muted }, [
          `${TUI_COPY.tokens}: ${snapshot.tokensUsed}${snapshot.tokenBudget == null ? "" : `/${snapshot.tokenBudget}`}`,
        ]),
        text({ fg: colors.muted }, [
          `${TUI_COPY.milestoneProgress}: ${milestoneProgress(snapshot)}${
            snapshot.activeMilestoneIndex >= 0 ? ` (m${snapshot.activeMilestoneIndex + 1})` : ""
          }`,
        ]),
        text({ fg: colors.muted }, [`${TUI_COPY.tracks}: ${activeTrackCount(snapshot)}`]),
        ...(snapshot.sentinelUpdate
          ? [text({ fg: colors.muted }, [`${TUI_COPY.latestUpdate}: ${snapshot.sentinelUpdate.message}`])]
          : []),
        ...(snapshot.lastStatus ? [text({ fg: colors.muted }, [snapshot.lastStatus])] : []),
        ...(snapshot.blocker ? [text({ fg: colors.muted }, [`${TUI_COPY.blocker}: ${snapshot.blocker}`])] : []),
      ])
    },
  ])
}

function ProjectKeymapLayerV2(api: TuiPluginV2.Context) {
  api.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "teamwork.show",
        title: TUI_COPY.title,
        description: TUI_COPY.commandDescription,
        group: TUI_COPY.title,
        palette: true,
        run: () => {
          const sessionID = currentSessionIDV2(api)
          if (!sessionID) {
            toastV2(api, TUI_COPY.openSession, "warning")
            return
          }
          void showProjectDialogV2(api, sessionID)
        },
      },
    ],
  }))
  return null
}

/**
 * V2 TUI setup: registers the project sidebar via `ui.slot` and a palette
 * command through a keymap layer mounted from the global `app` slot.
 */
export function setupTuiV2(context: TuiPluginV2.Context): TuiPluginV2.Cleanup {
  const offSidebar = registerSlotV2(context, "sidebar.content", (props) =>
    ProjectSidebarV2(context, props.sessionID),
  )
  const offApp = registerSlotV2(context, "app", () => ProjectKeymapLayerV2(context))
  return () => {
    offSidebar()
    offApp()
  }
}

const plugin: TuiPluginModule & TuiPluginV2.Definition = {
  id: "local.teamwork.tui",
  tui,
  setup: setupTuiV2,
}

export default plugin
