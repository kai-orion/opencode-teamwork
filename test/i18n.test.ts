import { expect, test } from "bun:test"
import { messagesFor, presentHistoryType, presentIntegrityMode, presentPhase, presentRole, resolveLocale } from "../src/i18n"
import type { TeamworkMessages } from "../src/i18n"

test("resolveLocale maps explicit and auto locales to en / zh-TW / zh-CN", () => {
  expect(resolveLocale("en")).toBe("en")
  expect(resolveLocale("en-US")).toBe("en")
  expect(resolveLocale("zh-TW")).toBe("zh-TW")
  expect(resolveLocale("zh_TW.UTF-8")).toBe("zh-TW")
  expect(resolveLocale("zh-Hant")).toBe("zh-TW")
  expect(resolveLocale("zh-CN")).toBe("zh-CN")
  expect(resolveLocale("zh-Hans")).toBe("zh-CN")
  expect(resolveLocale("zh")).toBe("zh-CN")
  expect(resolveLocale(undefined)).toBe("en")
  expect(resolveLocale("fr")).toBe("en")
})

test("every locale provides a complete message set (structural parity)", () => {
  const locales = ["en", "zh-TW", "zh-CN"] as const
  const shape = (messages: TeamworkMessages): string =>
    JSON.stringify({
      commands: Object.keys(messages.commands).sort(),
      tools: Object.keys(messages.tools).sort(),
      notices: Object.keys(messages.notices).sort(),
      reports: Object.keys(messages.reports).sort(),
      tui: Object.keys(messages.tui).sort(),
    })
  const baseline = shape(messagesFor("en"))
  for (const locale of locales) {
    expect(shape(messagesFor(locale))).toBe(baseline)
  }
})

test("every message string is non-empty in all locales", () => {
  for (const locale of ["en", "zh-TW", "zh-CN"] as const) {
    const messages = messagesFor(locale)
    const sections = [messages.commands, messages.tools, messages.notices, messages.reports, messages.tui]
    for (const section of sections) {
      for (const [key, value] of Object.entries(section)) {
        expect(typeof value === "string" && value.length > 0, `${locale}.${key}`).toBe(true)
      }
    }
  }
})

test("phase and integrity presentations cover all protocol values", () => {
  for (const locale of ["en", "zh-TW", "zh-CN"] as const) {
    for (const phase of ["interview", "awaitingApproval", "executing", "paused", "budgetLimited", "complete", "cancelled"]) {
      expect(presentPhase(phase, locale)).not.toBe(phase === "awaitingApproval" ? "awaitingApproval" : phase === "budgetLimited" ? "budgetLimited" : undefined)
      expect(typeof presentPhase(phase, locale)).toBe("string")
    }
    expect(presentIntegrityMode("development", locale)).toBeString()
    expect(presentIntegrityMode("demo", locale)).toBeString()
    expect(presentIntegrityMode("benchmark", locale)).toBeString()
    expect(presentIntegrityMode("unknown-mode", locale)).toBe("unknown-mode")
  }
})

test("role and history presentations preserve unknown values verbatim", () => {
  expect(presentRole("worker", "zh-TW")).toBe("實作工人")
  expect(presentRole("mystery", "en")).toBe("mystery")
  expect(presentHistoryType("milestone", "zh-CN")).toBe("里程碑")
  expect(presentHistoryType("mystery", "en")).toBe("mystery")
})
