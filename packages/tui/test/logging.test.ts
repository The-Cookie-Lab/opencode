import { describe, expect, test } from "bun:test"
import { isPrintLogsEnabled, logDebug, logError, logWarn } from "../src/util/logging"

function withConsoleStub(method: keyof Pick<Console, "debug" | "error" | "warn">, fn: () => void) {
  const original = console[method] as typeof console.debug
  let called = 0
  console[method] = (() => {
    called += 1
    return true
  }) as typeof console.debug
  try {
    fn()
    return called
  } finally {
    console[method] = original
  }
}

describe("tui logging", () => {
  test("defaults to no-op when OPENCODE_PRINT_LOGS is not set", () => {
    const previous = process.env.OPENCODE_PRINT_LOGS
    try {
      delete process.env.OPENCODE_PRINT_LOGS
      expect(isPrintLogsEnabled()).toBe(false)

      expect(withConsoleStub("debug", () => logDebug("debug message"))).toBe(0)
      expect(withConsoleStub("error", () => logError("error message"))).toBe(0)
      expect(withConsoleStub("warn", () => logWarn("warn message"))).toBe(0)
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCODE_PRINT_LOGS
      } else {
        process.env.OPENCODE_PRINT_LOGS = previous
      }
    }
  })

  test("emits logs when OPENCODE_PRINT_LOGS=1", () => {
    const previous = process.env.OPENCODE_PRINT_LOGS
    try {
      process.env.OPENCODE_PRINT_LOGS = "1"
      expect(isPrintLogsEnabled()).toBe(true)

      expect(withConsoleStub("debug", () => logDebug("debug message"))).toBe(1)
      expect(withConsoleStub("error", () => logError("error message"))).toBe(1)
      expect(withConsoleStub("warn", () => logWarn("warn message"))).toBe(1)
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCODE_PRINT_LOGS
      } else {
        process.env.OPENCODE_PRINT_LOGS = previous
      }
    }
  })
})
