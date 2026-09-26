import type { TuiCommand, TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Plugin as TuiPluginV2 } from "@opencode/plugin/tui"
import { createElement, insert, setProp } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { getProjectSync } from "./state"
import type { ProjectSnapshot } from "./state"
import type { TeamworkLocale, TeamworkMessages } from "./i18n"
import { messagesFor, presentIntegrityMode, presentPhase, resolveLocale } from "./i18n"

/**
 * The Teamwork sidebar reads the shared project state file directly
 * (`getProjectSync`). State writes are atomic (temp file + rename), so every
 * read observes the old or the new valid state, never a torn one — no message
 * scanning required. A 1-second poll keeps the live clock and track counts
 * fresh while the project executes.
 */

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

export function formatProjectSummary(project: ProjectSnapshot | null, messages: TeamworkMessages, locale: TeamworkLocale) {
  if (!project) return messages.tui.noProject
  const executor = (project as { executor?: string }).executor ?? "native"
  const lines = [
    `${messages.tui.project}: ${project.slug}`,
    `${messages.tui.phase}: ${presentPhase(project.phase, locale)}`,
    `${messages.tui.integrity}: ${presentIntegrityMode(project.brief.integrityMode, locale)}`,
    `Executor: ${executor} | workers: ${(project as { maxParallelWorkers?: number }).maxParallelWorkers ?? 5}`,
    `${messages.tui.milestoneProgress}: ${milestoneProgress(project)}${
      project.activeMilestoneIndex >= 0 ? ` (m${project.activeMilestoneIndex + 1})` : ""
    }`,
    `${messages.tui.tracks}: ${activeTrackCount(project)}`,
    `${messages.tui.time}: ${formatDuration(liveTimeUsedSeconds(project))}`,
    `${messages.tui.tokens}: ${project.tokensUsed}${project.tokenBudget == null ? "" : `/${project.tokenBudget}`}`,
  ]
  if (project.remainingTokens != null) lines.push(`${messages.tui.tokensRemaining}: ${project.remainingTokens}`)
  if (project.sentinelUpdate) lines.push(`${messages.tui.latestUpdate}: ${project.sentinelUpdate.message}`)
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

function ProjectSidebar(
  _api: TuiPluginApi,
  messages: TeamworkMessages,
  locale: TeamworkLocale,
  sessionID: string,
) {
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
        return text({ fg: theme.primary }, [`${messages.tui.completed} (${formatDuration(snapshot.timeUsedSeconds)})`])
      }
      if (snapshot.phase === "cancelled") {
        return text({ fg: theme.textMuted }, [`${messages.tui.cancelled} (${formatDuration(snapshot.timeUsedSeconds)})`])
      }
      return box({}, [
        text({ fg: theme.text }, [`${messages.tui.title}: ${snapshot.slug}`]),
        text({ fg: theme.textMuted }, [`${messages.tui.phase}: ${presentPhase(snapshot.phase, locale)}`]),
        text({ fg: theme.textMuted }, [
          () => `${messages.tui.time}: ${formatDuration(liveTimeUsedSeconds(snapshot, tick()))}`,
        ]),
        text({ fg: theme.textMuted }, [
          `${messages.tui.tokens}: ${snapshot.tokensUsed}${snapshot.tokenBudget == null ? "" : `/${snapshot.tokenBudget}`}`,
        ]),
        text({ fg: theme.textMuted }, [`${messages.tui.integrity}: ${presentIntegrityMode(snapshot.brief.integrityMode, locale)}`]),
        text({ fg: theme.textMuted }, [
          `${messages.tui.milestoneProgress}: ${milestoneProgress(snapshot)}${
            snapshot.activeMilestoneIndex >= 0 ? ` (m${snapshot.activeMilestoneIndex + 1})` : ""
          }`,
        ]),
        text({ fg: theme.textMuted }, [`${messages.tui.tracks}: ${activeTrackCount(snapshot)}`]),
        ...(snapshot.sentinelUpdate
          ? [text({ fg: theme.textMuted }, [`${messages.tui.latestUpdate}: ${snapshot.sentinelUpdate.message}`])]
          : []),
        ...(snapshot.lastStatus ? [text({ fg: theme.textMuted }, [snapshot.lastStatus])] : []),
        ...(snapshot.blocker ? [text({ fg: theme.textMuted }, [`${messages.reports.blocker}: ${snapshot.blocker}`])] : []),
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

function toast(api: TuiPluginApi, messages: TeamworkMessages, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
  api.ui.toast({ title: messages.tui.title, message, variant, duration: 2500 })
}

async function sendProjectPrompt(api: TuiPluginApi, sessionID: string, prompt: string) {
  await api.client.session.promptAsync({
    sessionID,
    parts: [{ type: "text", text: prompt }],
  })
}

function actionOption(
  api: TuiPluginApi,
  messages: TeamworkMessages,
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
        .catch((error) => toast(api, messages, error instanceof Error ? error.message : String(error), "error"))
    },
  }
}

function showProjectDialog(
  api: TuiPluginApi,
  messages: TeamworkMessages,
  locale: TeamworkLocale,
  sessionID: string,
) {
  const DialogSelect = api.ui.DialogSelect
  const project = projectForSession(sessionID)
  const options = [
    actionOption(api, messages, sessionID, messages.tui.refresh, "refresh", messages.tui.refreshDescription, messages.tui.refreshPrompt),
    actionOption(api, messages, sessionID, messages.tui.status, "status", messages.tui.statusDescription, messages.tui.statusPrompt),
    ...(project?.phase === "executing"
      ? [actionOption(api, messages, sessionID, messages.tui.pause, "pause", messages.tui.pauseDescription, messages.tui.pausePrompt)]
      : []),
    ...(project?.phase === "paused"
      ? [actionOption(api, messages, sessionID, messages.tui.resume, "resume", messages.tui.resumeDescription, messages.tui.resumePrompt)]
      : []),
    ...(project && project.phase !== "complete" && project.phase !== "cancelled"
      ? [actionOption(api, messages, sessionID, messages.tui.cancel, "cancel", messages.tui.cancelDescription, messages.tui.cancelPrompt)]
      : []),
  ]
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() =>
    DialogSelect({
      title: messages.tui.title,
      placeholder: formatProjectSummary(project, messages, locale),
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

const tui: TuiPlugin = async (api, options) => {
  const locale = resolveLocale(typeof options?.locale === "string" ? options.locale : undefined)
  const messages = messagesFor(locale)
  api.slots.register({
    order: 125,
    slots: {
      sidebar_content(_ctx, props) {
        return ProjectSidebar(api, messages, locale, props.session_id)
      },
    },
  })

  registerProjectCommand(api, {
    title: messages.tui.title,
    value: "teamwork.show",
    category: messages.tui.title,
    description: messages.tui.commandDescription,
    onSelect: () => {
      const sessionID = currentSessionID(api)
      if (!sessionID) {
        toast(api, messages, messages.tui.openSession, "warning")
        return
      }
      showProjectDialog(api, messages, locale, sessionID)
    },
  })
}

// --- V2 TUI plugin -----------------------------------------------------------

function currentSessionIDV2(api: TuiPluginV2.Context) {
  const route = api.ui.router.current()
  if (route.type !== "session") return undefined
  return route.sessionID
}

function toastV2(
  api: TuiPluginV2.Context,
  messages: TeamworkMessages,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
) {
  api.ui.toast.show({ title: messages.tui.title, message, variant, duration: 2500 })
}

async function showProjectDialogV2(
  api: TuiPluginV2.Context,
  messages: TeamworkMessages,
  locale: TeamworkLocale,
  sessionID: string,
) {
  const project = projectForSession(sessionID)
  const options = [
    { title: messages.tui.refresh, value: "refresh", description: messages.tui.refreshDescription },
    { title: messages.tui.status, value: "status", description: messages.tui.statusDescription },
    ...(project?.phase === "executing"
      ? [{ title: messages.tui.pause, value: "pause", description: messages.tui.pauseDescription }]
      : []),
    ...(project?.phase === "paused"
      ? [{ title: messages.tui.resume, value: "resume", description: messages.tui.resumeDescription }]
      : []),
    ...(project && project.phase !== "complete" && project.phase !== "cancelled"
      ? [{ title: messages.tui.cancel, value: "cancel", description: messages.tui.cancelDescription }]
      : []),
  ]
  api.ui.dialog.set({ size: "large" })
  const selected = await api.ui.dialog.select({
    title: messages.tui.title,
    placeholder: formatProjectSummary(project, messages, locale),
    options,
  })
  const prompt =
    selected === "refresh" ? messages.tui.refreshPrompt
    : selected === "status" ? messages.tui.statusPrompt
    : selected === "pause" ? messages.tui.pausePrompt
    : selected === "resume" ? messages.tui.resumePrompt
    : selected === "cancel" ? messages.tui.cancelPrompt
    : undefined
  if (!prompt) return
  try {
    await api.client.session.prompt({ sessionID, text: prompt })
  } catch (error) {
    toastV2(api, messages, error instanceof Error ? error.message : String(error), "error")
  }
}

function ProjectSidebarV2(
  api: TuiPluginV2.Context,
  messages: TeamworkMessages,
  locale: TeamworkLocale,
  sessionID: string,
) {
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
        return text({ fg: colors.success }, [
          `${messages.tui.completed} (${formatDuration(snapshot.timeUsedSeconds)})`,
        ])
      }
      if (snapshot.phase === "cancelled") {
        return text({ fg: colors.muted }, [`${messages.tui.cancelled} (${formatDuration(snapshot.timeUsedSeconds)})`])
      }
      return box({}, [
        text({ fg: colors.text }, [`${messages.tui.title}: ${snapshot.slug}`]),
        text({ fg: colors.muted }, [`${messages.tui.phase}: ${presentPhase(snapshot.phase, locale)}`]),
        text({ fg: colors.muted }, [`${messages.tui.integrity}: ${presentIntegrityMode(snapshot.brief.integrityMode, locale)}`]),
        text({ fg: colors.muted }, [() => `${messages.tui.time}: ${formatDuration(liveTimeUsedSeconds(snapshot, tick()))}`]),
        text({ fg: colors.muted }, [
          `${messages.tui.tokens}: ${snapshot.tokensUsed}${snapshot.tokenBudget == null ? "" : `/${snapshot.tokenBudget}`}`,
        ]),
        text({ fg: colors.muted }, [
          `${messages.tui.milestoneProgress}: ${milestoneProgress(snapshot)}${
            snapshot.activeMilestoneIndex >= 0 ? ` (m${snapshot.activeMilestoneIndex + 1})` : ""
          }`,
        ]),
        text({ fg: colors.muted }, [`${messages.tui.tracks}: ${activeTrackCount(snapshot)}`]),
        ...(snapshot.sentinelUpdate
          ? [text({ fg: colors.muted }, [`${messages.tui.latestUpdate}: ${snapshot.sentinelUpdate.message}`])]
          : []),
        ...(snapshot.lastStatus ? [text({ fg: colors.muted }, [snapshot.lastStatus])] : []),
        ...(snapshot.blocker ? [text({ fg: colors.muted }, [`${messages.reports.blocker}: ${snapshot.blocker}`])] : []),
      ])
    },
  ])
}

function ProjectKeymapLayerV2(api: TuiPluginV2.Context, messages: TeamworkMessages, locale: TeamworkLocale) {
  api.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "teamwork.show",
        title: messages.tui.title,
        description: messages.tui.commandDescription,
        group: messages.tui.title,
        palette: true,
        run: () => {
          const sessionID = currentSessionIDV2(api)
          if (!sessionID) {
            toastV2(api, messages, messages.tui.openSession, "warning")
            return
          }
          void showProjectDialogV2(api, messages, locale, sessionID)
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
  const locale = resolveLocale(typeof context.options?.locale === "string" ? context.options.locale : undefined)
  const messages = messagesFor(locale)
  const offSidebar = registerSlotV2(context, "sidebar.content", (props) =>
    ProjectSidebarV2(context, messages, locale, props.sessionID),
  )
  const offApp = registerSlotV2(context, "app", () => ProjectKeymapLayerV2(context, messages, locale))
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
