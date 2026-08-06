import { describe, expect, test } from "bun:test"
import {
  normalizeTuiSubprocessStdio,
  OPENCODE_TUI,
  redirectTuiWorkerIO,
  redirectStderrToStdout,
  shouldIsolateTuiSubprocessIO,
} from "../../../src/cli/tui/stdio"

describe("redirectStderrToStdout", () => {
  test("no-ops when OPENCODE_PRINT_LOGS is enabled", () => {
    const previousValue = process.env.OPENCODE_PRINT_LOGS
    const originalWrite = process.stderr.write
    process.env.OPENCODE_PRINT_LOGS = "1"
    const previousRestore = redirectStderrToStdout()

    expect(previousRestore).toBeUndefined()
    expect(process.stderr.write).toBe(originalWrite)

    if (previousValue === undefined) {
      delete process.env.OPENCODE_PRINT_LOGS
    } else {
      process.env.OPENCODE_PRINT_LOGS = previousValue
    }
  })

  test("reroutes stderr writes to stdout when OPENCODE_PRINT_LOGS is disabled", () => {
    const previousValue = process.env.OPENCODE_PRINT_LOGS
    const originalWrite = process.stderr.write
    const originalStdoutWrite = process.stdout.write
    delete process.env.OPENCODE_PRINT_LOGS

    let stdout = ""
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk)
      return true
    }) as typeof process.stdout.write

    const restore = redirectStderrToStdout()

    try {
      expect(restore).toBeDefined()
      expect(process.stderr.write).not.toBe(originalWrite)

      process.stderr.write("legacy stderr")
      expect(stdout).toContain("legacy stderr")
      restore?.()
      expect(process.stderr.write).toBe(originalWrite)
    } finally {
      process.stdout.write = originalStdoutWrite
      if (previousValue === undefined) {
        delete process.env.OPENCODE_PRINT_LOGS
      } else {
        process.env.OPENCODE_PRINT_LOGS = previousValue
      }
    }
  })

  test("shouldIsolateTuiSubprocessIO enables isolation when in TUI mode without log passthrough", () => {
    const previousValue = process.env[OPENCODE_TUI]
    const previousLogsValue = process.env.OPENCODE_PRINT_LOGS

    process.env[OPENCODE_TUI] = "1"
    delete process.env.OPENCODE_PRINT_LOGS

    try {
      expect(shouldIsolateTuiSubprocessIO()).toBe(true)
    } finally {
      if (previousValue === undefined) {
        delete process.env[OPENCODE_TUI]
      } else {
        process.env[OPENCODE_TUI] = previousValue
      }
      if (previousLogsValue === undefined) {
        delete process.env.OPENCODE_PRINT_LOGS
      } else {
        process.env.OPENCODE_PRINT_LOGS = previousLogsValue
      }
    }
  })

  test("normalizeTuiSubprocessStdio maps inherit to ignore when isolating", () => {
    const previousValue = process.env[OPENCODE_TUI]
    const previousLogsValue = process.env.OPENCODE_PRINT_LOGS

    process.env[OPENCODE_TUI] = "1"
    delete process.env.OPENCODE_PRINT_LOGS

    try {
      expect(normalizeTuiSubprocessStdio("inherit")).toBe("ignore")
      expect(normalizeTuiSubprocessStdio("pipe")).toBe("pipe")
      expect(normalizeTuiSubprocessStdio("ignore")).toBe("ignore")
    } finally {
      if (previousValue === undefined) {
        delete process.env[OPENCODE_TUI]
      } else {
        process.env[OPENCODE_TUI] = previousValue
      }
      if (previousLogsValue === undefined) {
        delete process.env.OPENCODE_PRINT_LOGS
      } else {
        process.env.OPENCODE_PRINT_LOGS = previousLogsValue
      }
    }
  })

  test("normalizeTuiSubprocessStdio respects print-logs bypass mode", () => {
    const previousValue = process.env[OPENCODE_TUI]
    const previousLogsValue = process.env.OPENCODE_PRINT_LOGS

    process.env[OPENCODE_TUI] = "1"
    process.env.OPENCODE_PRINT_LOGS = "1"

    try {
      expect(shouldIsolateTuiSubprocessIO()).toBe(false)
      expect(normalizeTuiSubprocessStdio("inherit")).toBe("inherit")
    } finally {
      if (previousValue === undefined) {
        delete process.env[OPENCODE_TUI]
      } else {
        process.env[OPENCODE_TUI] = previousValue
      }
      if (previousLogsValue === undefined) {
        delete process.env.OPENCODE_PRINT_LOGS
      } else {
        process.env.OPENCODE_PRINT_LOGS = previousLogsValue
      }
    }
  })

  test("worker entrypoint installs stderr isolation before loading runtime modules", async () => {
    const source = await Bun.file(new URL("../../../src/cli/tui/worker.ts", import.meta.url)).text()
    const staticImports = source.match(/^import .* from .*$/gm) ?? []
    expect(staticImports).toHaveLength(1)
    expect(staticImports[0]).toContain('from "./stdio"')

    const redirectIndex = source.indexOf("redirectTuiWorkerIO()")
    const firstDynamicImport = source.indexOf('await import("')
    expect(redirectIndex).toBeGreaterThan(-1)
    expect(firstDynamicImport).toBeGreaterThan(redirectIndex)
  })

  test("redirectTuiWorkerIO silences stdout and stderr while TUI isolation is active", () => {
    const previousTuiValue = process.env[OPENCODE_TUI]
    const previousLogsValue = process.env.OPENCODE_PRINT_LOGS

    process.env[OPENCODE_TUI] = "1"
    delete process.env.OPENCODE_PRINT_LOGS

    const originalStdoutWrite = process.stdout.write
    const originalStderrWrite = process.stderr.write
    let stdoutWrites = 0
    let stderrWrites = 0

    process.stdout.write = ((_chunk: string | Uint8Array) => {
      stdoutWrites += 1
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((_chunk: string | Uint8Array) => {
      stderrWrites += 1
      return true
    }) as typeof process.stderr.write

    const restore = redirectTuiWorkerIO()

    try {
      expect(restore).toBeDefined()
      expect(process.stdout.write).not.toBe(originalStdoutWrite)
      expect(process.stderr.write).not.toBe(originalStderrWrite)

      process.stdout.write("worker stdout")
      process.stderr.write("worker stderr")

      expect(stdoutWrites).toBe(0)
      expect(stderrWrites).toBe(0)
      restore?.()
      process.stdout.write("after worker shutdown")
      process.stderr.write("after worker shutdown")

      expect(stdoutWrites).toBe(1)
      expect(stderrWrites).toBe(1)
    } finally {
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
      if (previousTuiValue === undefined) {
        delete process.env[OPENCODE_TUI]
      } else {
        process.env[OPENCODE_TUI] = previousTuiValue
      }
      if (previousLogsValue === undefined) {
        delete process.env.OPENCODE_PRINT_LOGS
      } else {
        process.env.OPENCODE_PRINT_LOGS = previousLogsValue
      }
    }
  })
})
