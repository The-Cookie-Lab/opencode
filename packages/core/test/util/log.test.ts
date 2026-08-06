import { describe, expect, test } from "bun:test"
import { Log } from "@opencode-ai/core/util/log"

describe("core util log", () => {
  test("suppresses log output when OPENCODE_PRINT_LOGS is disabled", () => {
    const previousPrintLogs = process.env.OPENCODE_PRINT_LOGS
    const originalWrite = process.stderr.write
    let calls = 0

    process.stderr.write = ((chunk: string | Uint8Array) => {
      calls += String(chunk).length
      return true
    }) as typeof process.stderr.write

    try {
      delete process.env.OPENCODE_PRINT_LOGS
      const logger = Log.create({ service: "core.util.log.suppressed" })
      logger.info("hidden")
      expect(calls).toBe(0)

      process.env.OPENCODE_PRINT_LOGS = "1"
      logger.info("visible")
      expect(calls).toBeGreaterThan(0)
    } finally {
      process.stderr.write = originalWrite
      if (previousPrintLogs === undefined) {
        delete process.env.OPENCODE_PRINT_LOGS
      } else {
        process.env.OPENCODE_PRINT_LOGS = previousPrintLogs
      }
    }
  })
})
