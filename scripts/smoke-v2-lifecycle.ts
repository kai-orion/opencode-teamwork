// Runs the installed OpenCode V2 binary against a deterministic local model.
// No real provider credentials, shared service, or user project state are used.
//
// The fixture model scripts the full /teamwork lifecycle:
//   /teamwork          -> teamwork_create_project
//   /teamwork-approve  -> teamwork_approve (the plugin state machine takes over)
//   orchestrator       -> teamwork_submit_plan
//   explorer/worker/critic/challenger/auditor/successAuditor -> teamwork_report (pass)
// and the smoke asserts the project reaches phase "complete" with artifacts
// written on disk.
import assert from "node:assert/strict"
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const root = await mkdtemp(join(tmpdir(), "teamwork-v2-smoke-"))
const project = join(root, "project")
await mkdir(project)
// OpenCode resolves project locations through git; a non-git directory falls
// back to the "global" project and its command/plugin lists come back empty.
await Bun.spawnSync(["git", "init", "-q", project])
const target = process.argv[2] ?? "."
const registryPackage = target.startsWith("@")
const packagePath = registryPackage ? target : resolve(target)
let modelCalls = 0

const ROLE_MARKERS: Array<[string, string]> = [
  ["You are the Project Orchestrator", "orchestrator"],
  ["You are an Explorer", "explorer"],
  ["You are a Worker", "worker"],
  ["You are the Critic", "critic"],
  ["You are the Challenger", "challenger"],
  ["You are the Auditor", "auditor"],
  ["You are a Prover", "prover"],
  ["You are the Falsifier", "falsifier"],
  ["You are the Verifier", "verifier"],
  ["You are a Reviewer", "reviewer"],
  ["You are the Synthesizer", "synthesizer"],
  ["You are the Success Auditor", "successAuditor"],
]

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in (part as Record<string, unknown>)
        ? String((part as Record<string, unknown>).text ?? "")
        : ""))
      .join("\n")
  }
  return ""
}

function roleFromMessages(messages: Array<{ role: string; content?: unknown }>): string | null {
  const system = messages.filter((message) => message.role === "system").map((message) => textOf(message.content)).join("\n")
  for (const [marker, role] of ROLE_MARKERS) {
    if (system.includes(marker)) return role
  }
  // When the host could not register named agents, the role identity rides
  // the task prompt (a user message) instead of the system prompt.
  const user = messages.filter((message) => message.role === "user").map((message) => textOf(message.content)).join("\n")
  for (const [marker, role] of ROLE_MARKERS) {
    if (user.includes(marker)) return role
  }
  return null
}

const PLAN = {
  milestones: [
    {
      title: "Survey the codebase",
      description: "Map the existing REST routes and produce a migration map.",
      tracks: [{ title: "Route survey", role: "explorer", assigned_files: [] }],
    },
    {
      title: "Port the server to Fastify",
      description: "Port every handler and pass the full test suite.",
      tracks: [
        { title: "Port handlers", role: "worker", assigned_files: ["src/server.ts"] },
        { title: "Review the port", role: "critic", assigned_files: [] },
        { title: "Audit the port", role: "auditor", assigned_files: [] },
      ],
    },
  ],
}

function reportArgs(role: string) {
  return {
    role,
    verdict: "pass",
    findings: [`The ${role} pass completed its assignment against the request artifact.`],
    evidence: ["fixture: npm test -> 42 passing"],
    blockers: [],
    artifacts_written: [],
  }
}

const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = await request.json() as {
      messages: Array<{ role: string; content?: unknown }>
      tools?: Array<{ function: { name: string } }>
      stream?: boolean
    }
    modelCalls++
    await writeFile(join(root, `model-request-${modelCalls}.json`), JSON.stringify(body))
    const messages = body.messages
    const userText = messages
      .filter((message): message is { role: string; content?: unknown } => message.role === "user")
      .map((message) => textOf(message.content))
      .pop() ?? ""
    const role = roleFromMessages(messages)
    // When the last message is a tool result the action already ran —
    // acknowledge with text. Otherwise classify by the newest user prompt.
    const lastMessage = messages.at(-1)
    const lastIsToolResult = lastMessage?.role === "tool"

    let toolName: string | null = null
    let args: unknown = {}
    if (!lastIsToolResult) {
      if (role !== null) {
        toolName = role === "orchestrator" ? "teamwork_submit_plan" : "teamwork_report"
        args = role === "orchestrator" ? PLAN : reportArgs(role)
      } else if (userText.includes("call the teamwork_create_project tool")) {
        toolName = "teamwork_create_project"
        args = {
          name: "fastify-migration",
          objectives: "Migrate the REST API service from Express to Fastify.",
          requirements: "All existing routes keep their behavior; TypeScript throughout.",
          verification: "The migrated server must pass the full integration test suite.",
          acceptance_criteria: "npm test passes with zero failures on the Fastify server.",
          integrity_mode: "development",
          execution_path: "general",
          team_scale: null,
          deep: true,
          max_parallel_workers: 5,
        }
      } else if (userText.includes("teamwork_approve")) {
        toolName = "teamwork_approve"
      } else if (userText.includes("teamwork_get_project")) {
        toolName = "teamwork_get_project"
      }
    }

    const tool = toolName ? body.tools?.find((entry) => entry.function.name === toolName) : undefined
    const delta = tool
      ? {
          role: "assistant",
          tool_calls: [{ index: 0, id: `call_${modelCalls}`, type: "function", function: { name: tool.function.name, arguments: JSON.stringify(args) } }],
        }
      : { role: "assistant", content: `Fixture acknowledgment ${modelCalls}: no further tool call needed.` }
    const finish = tool ? "tool_calls" : "stop"
    const chunk = (choices: unknown[], usage?: unknown) => ({ id: `chatcmpl_${modelCalls}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "fixture", choices, ...(usage ? { usage } : {}) })
    const usage = { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 }
    if (!body.stream) {
      return Response.json({ ...chunk([]), object: "chat.completion", choices: [{ index: 0, message: delta, finish_reason: finish }], usage })
    }
    return new Response([
      chunk([{ index: 0, delta, finish_reason: null }]),
      chunk([{ index: 0, delta: {}, finish_reason: finish }], usage),
    ].map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    })
  },
})

await mkdir(join(root, "config/opencode"), { recursive: true })
if (!registryPackage) {
  // Local plugin files cannot resolve external imports (effect, zod) — there
  // is no node_modules to walk up to. Build a fully-bundled server (no
  // externals) for the smoke; npm-installed packages keep their dependencies
  // and need the normal externalizing build.
  const standalone = join(root, "standalone")
  const built = await Bun.build({
    entrypoints: [join(packagePath, "src/server.ts")],
    outdir: standalone,
    target: "bun",
  })
  if (!built.success) {
    console.error(built.logs)
    throw new Error("Standalone smoke bundle failed")
  }
  await mkdir(join(root, "config/opencode/plugins"))
  await writeFile(join(root, "config/opencode/plugins/teamwork.ts"), `export { default } from ${JSON.stringify(pathToFileURL(join(standalone, "server.js")).href)}\n`)
}
await writeFile(join(root, "config/opencode/opencode.json"), JSON.stringify({
  model: "fixture/fixture",
  snapshots: false,
  providers: {
    fixture: {
      env: ["FIXTURE_API_KEY"],
      package: "@opencode-ai/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${model.port}/v1` },
      models: { fixture: { name: "Local fixture", limit: { context: 100000, output: 1000 } } },
    },
  },
}))

// Use a clean environment, not a spread of process.env (which may carry a live
// OPENCODE_DB, server connection settings, provider credentials, or config).
// The cache dir is shared across runs on purpose: opencode installs the
// provider's npm package on first boot, which alone can take minutes on a
// cold cache.
const sharedCache = join(tmpdir(), "opencode-teamwork-smoke-cache")
await mkdir(sharedCache, { recursive: true })
const env: Record<string, string> = {
  PATH: process.env.PATH!,
  HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: sharedCache,
  OPENCODE_DB: join(root, "opencode.db"),
  OPENCODE_TEAMWORK_STATE_PATH: join(root, "projects.json"),
  OPENCODE_PASSWORD: crypto.randomUUID(),
  FIXTURE_API_KEY: "local-fixture-only",
  ...(process.env.OPENCODE_TEAMWORK_TRACE ? { OPENCODE_TEAMWORK_TRACE: process.env.OPENCODE_TEAMWORK_TRACE } : {}),
}
const binary = process.env.OPENCODE_V2_BIN ?? "opencode2"
if (registryPackage) {
  const install = Bun.spawn([binary, "plugin", "add", packagePath], { cwd: project, env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(install.stdout).text(), new Response(install.stderr).text(), install.exited])
  await writeFile(join(root, "install.log"), stdout + stderr)
  if (code !== 0) {
    model.stop(true)
    throw new Error(`Plugin installation failed; inspect ${root}/install.log`)
  }
}
const child = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: project, env, stdout: "pipe", stderr: "pipe",
})
let output = ""
const consume = async (stream: ReadableStream<Uint8Array>) => {
  for await (const chunk of stream) output += new TextDecoder().decode(chunk)
}
const readers = Promise.all([consume(child.stdout), consume(child.stderr)])
// Server boot includes a possible first-run provider install (cold cache can
// take minutes); the lifecycle stages after readiness get the shorter budget.
const readyDeadline = Date.now() + Number(process.env.OPENCODE_SMOKE_READY_TIMEOUT_MS ?? 300_000)
const lifecycleDeadlineBase = Date.now() + Number(process.env.OPENCODE_SMOKE_TIMEOUT_MS ?? 300_000)
let lastStage: string | undefined
const waitFor = async (stage: string, check: () => boolean | Promise<boolean>, diagnose?: () => string) => {
  lastStage = stage
  const deadline = stage === "server-ready" ? readyDeadline : lifecycleDeadlineBase
  while (Date.now() < deadline) {
    if (await check()) return
    if (child.exitCode != null) throw new Error(`Private V2 exited: ${output.slice(-4000)}`)
    await Bun.sleep(50)
  }
  const details = diagnose?.()
  const observed = `modelCalls=${modelCalls}${details ? `; ${details}` : ""}`
  throw new Error(`Smoke timeout at stage "${stage}"; ${observed}; logs=${root}/server.log`)
}
let passed = false
// Hard watchdog: never let a stuck server or child process wedge the smoke.
const watchdog = setTimeout(
  () => {
    try {
      writeFile(join(root, "watchdog-fired.txt"), `stage=${lastStage ?? "unknown"} modelCalls=${modelCalls}`).catch(() => undefined)
    } catch {
      // Diagnostics must never mask the watchdog exit.
    }
    console.error(`Smoke watchdog fired at stage "${lastStage ?? "unknown"}"`)
    process.exit(1)
  },
  (readyDeadline - Date.now()) + 420_000,
)
try {
  await waitFor("server-ready", () => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const base = output.match(/http:\/\/127\.0\.0\.1:\d+/)![0]
  const api = async (path: string, data?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${btoa(`opencode:${env.OPENCODE_PASSWORD}`)}` },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
    assert(response.ok, `${path}: ${response.status} ${await response.clone().text()}`)
    const text = await response.text()
    return text ? JSON.parse(text) : undefined
  }
  const created = await api("/api/session", { location: { directory: project }, title: "Teamwork lifecycle smoke", model: { providerID: "fixture", id: "fixture" }, agent: "build" }) as { data: { id: string } }
  const sessionID = created.data.id
  // Best-effort activation nudge: newer binaries may not expose this endpoint
  // (404 is fine — loading the project's plugins happens implicitly).
  const activation = await fetch(`${base}/api/plugin/await-activation?location%5Bdirectory%5D=${encodeURIComponent(project)}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${btoa(`opencode:${env.OPENCODE_PASSWORD}`)}` },
    body: "{}",
  }).catch(() => undefined)
  if (activation && !activation.ok) await writeFile(join(root, "await-activation.status"), String(activation.status))
  const plugins = await api(`/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(project)}`).catch(() => undefined) as { data: Array<{ id?: string; state?: { status: string; error?: string } }> } | undefined
  if (plugins) await writeFile(join(root, "plugins.json"), JSON.stringify(plugins))
  else await writeFile(join(root, "plugins.json"), "unavailable")
  const commands = await api(`/api/command?location%5Bdirectory%5D=${encodeURIComponent(project)}`) as { data: Array<{ name: string }> }
  const wanted = ["teamwork", "teamwork-approve", "teamwork-revise", "teamwork-status", "teamwork-pause", "teamwork-resume", "teamwork-cancel"]
  // The project-location plugin instance registers its commands asynchronously
  // after the first session activity; poll instead of asserting immediately.
  await waitFor("commands-registered", async () => {
    const current = await api(`/api/command?location%5Bdirectory%5D=${encodeURIComponent(project)}`) as { data: Array<{ name: string }> }
    return wanted.every((name) => current.data.some((command) => command.name === name))
  }, () => `commands=${commands.data.map((command) => command.name).join(",") || "none"}`)

  // Phase 1: the scoping interview commits the prompt artifact.
  const stateFile = env.OPENCODE_TEAMWORK_STATE_PATH!
  await api(`/api/session/${sessionID}/command`, {
    name: "teamwork",
    text: "Migrate our REST API service from Express to Fastify, including full test coverage.",
  })
  await waitFor("project-created", async () => {
    try {
      const state = JSON.parse(await readFile(stateFile, "utf8")) as { projects?: Record<string, { phase: string }> }
      return state.projects?.[sessionID]?.phase === "awaitingApproval"
    } catch {
      return false
    }
  })
  const briefArtifact = join(project, ".teamwork", "brief.md")
  const requestArtifact = join(project, ".teamwork", "request.md")
  await waitFor("request-artifact", async () => {
    try {
      const brief = await readFile(briefArtifact, "utf8")
      const request = await readFile(requestArtifact, "utf8")
      return brief.includes("fastify-migration") && request.includes("fastify-migration")
    } catch {
      return false
    }
  })

  // Phase 2: approval hands the project to the plugin state machine, which
  // drives orchestrator -> explorer/worker -> critic/auditor -> success audit.
  await api(`/api/session/${sessionID}/command`, {
    name: "teamwork-approve",
    text: "",
  })
  let phase: string | undefined
  let lastStop: string | undefined
  await waitFor("project-complete", async () => {
    try {
      const state = JSON.parse(await readFile(stateFile, "utf8")) as {
        projects?: Record<string, { phase: string; stopReason?: string; completionEvidence?: string }>
      }
      const current = state.projects?.[sessionID]
      phase = current?.phase
      lastStop = current?.stopReason
      return current?.phase === "complete"
    } catch {
      return false
    }
  }, () => `phase=${phase ?? "unknown"}, stopReason=${lastStop ?? "none"}`)
  const finalState = JSON.parse(await readFile(stateFile, "utf8")) as {
    projects?: Record<string, { completionEvidence?: string; milestones: Array<{ status: string; tracks: Array<{ sessionID?: string | null }> }> }>
  }
  const finished = finalState.projects![sessionID]!
  assert(finished.completionEvidence && finished.completionEvidence.length > 0, "completion evidence missing")
  assert(finished.milestones.every((milestone) => milestone.status === "passed"), "not every milestone passed")
  assert(modelCalls >= 8, `too few model calls for the full lifecycle: ${modelCalls}`)

  // Session hygiene: after completion every role session must be either gone
  // from the list or, when the host does not expose session removal, renamed
  // with the [teamwork done] marker. The [teamwork] creation prefix is covered
  // by the engine unit tests.
  const roleSessionIDs = finished.milestones
    .flatMap((milestone) => milestone.tracks)
    .filter((track) => typeof track.sessionID === "string" && track.sessionID)
    .map((track) => track.sessionID!)
  assert(roleSessionIDs.length > 0, "no role session IDs recorded in state")
  // Cleanup runs shortly after the phase flips to complete: poll until every
  // role session is gone or marked.
  const hygieneDeadline = Date.now() + 30_000
  let leftovers: Array<{ id: string; title?: string }> = []
  for (;;) {
    const current = await api(`/api/session?limit=200&directory=${encodeURIComponent(project)}`) as {
      data: Array<{ id: string; title?: string }>
    }
    leftovers = current.data.filter((session) => roleSessionIDs.includes(session.id))
    if (leftovers.every((session) => String(session.title ?? "").includes("[teamwork done]"))) break
    if (Date.now() > hygieneDeadline) break
    await Bun.sleep(100)
  }
  const unmarked = leftovers.filter((session) => !String(session.title ?? "").includes("[teamwork done]"))
  assert(
    unmarked.length === 0,
    `role sessions were neither removed nor marked finished: ${unmarked.map((session) => `${session.id}:${session.title ?? "?"}`).join(",")}`,
  )

  const summary = {
    result: "PASS",
    packagePath,
    sessionID,
    modelCalls,
    roleSessionIDs: roleSessionIDs.length,
    phase,
    milestones: finished.milestones.length,
    artifacts: root,
  }
  console.log(JSON.stringify(summary, null, 2))
  passed = true
} finally {
  clearTimeout(watchdog)
  // Persist diagnostics BEFORE waiting on the child: on Windows a killed
  // server may not surface its exit promptly, and a hang here must not cost
  // us the logs.
  await writeFile(join(root, "server.log"), output).catch(() => undefined)
  if (!passed) {
    try {
      const summary = {
        failed: true,
        stage: lastStage ?? "unknown",
        modelCalls,
        deadlineAtMs: lifecycleDeadlineBase,
        finishedAt: Date.now(),
      }
      await writeFile(join(root, "failure-summary.json"), JSON.stringify(summary))
      const artifactsDir = process.env.OPENCODE_SMOKE_ARTIFACTS_DIR
      if (artifactsDir) {
        await mkdir(artifactsDir, { recursive: true })
        await cp(root, artifactsDir, { recursive: true })
      }
    } catch (error) {
      // Artifact preservation must never mask the original failure.
      console.error(`Failed to preserve smoke artifacts: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  child.kill()
  await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 2_000))])
  // On Windows the killed server can survive as a detached tree; force-kill it.
  if (child.pid) {
    Bun.spawnSync(["taskkill", "/PID", String(child.pid), "/T", "/F"])
  }
  await Promise.race([readers, new Promise((resolve) => setTimeout(resolve, 2_000))]).catch(() => undefined)
  model.stop(true)
  process.exit(passed ? 0 : 1)
}
