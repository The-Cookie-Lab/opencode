export const OPENCODE_TUI = "OPENCODE_TUI"

export type RestoreStderr = () => void

export function shouldIsolateTuiSubprocessIO(): boolean {
  return process.env[OPENCODE_TUI] === "1" && process.env.OPENCODE_PRINT_LOGS !== "1"
}

export function normalizeTuiSubprocessStdio<T>(stdio: T): T {
  if (!shouldIsolateTuiSubprocessIO()) return stdio
  if (stdio !== "inherit") return stdio
  return "ignore" as T
}

export function redirectStderrToStdout(): RestoreStderr | undefined {
  if (process.env.OPENCODE_PRINT_LOGS === "1") {
    return
  }

  const originalWrite = process.stderr.write
  process.stderr.write = ((chunk, encoding, callback) => process.stdout.write(chunk, encoding, callback)) as typeof process.stderr.write

  return () => {
    process.stderr.write = originalWrite
  }
}

export function redirectTuiWorkerIO(): RestoreStderr | undefined {
  if (!shouldIsolateTuiSubprocessIO()) {
    return
  }

  const noopWrite = ((_, __, callback) => {
    callback?.()
    return true
  }) as typeof process.stdout.write

  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write

  process.stdout.write = noopWrite
  process.stderr.write = noopWrite

  return () => {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
  }
}
