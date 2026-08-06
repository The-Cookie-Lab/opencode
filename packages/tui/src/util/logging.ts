export function isPrintLogsEnabled() {
  return process.env.OPENCODE_PRINT_LOGS === "1"
}

function logIfEnabled(level: keyof Pick<Console, "debug" | "error" | "info" | "warn">, args: unknown[]) {
  if (!isPrintLogsEnabled()) return
  console[level](...args)
}

export const logDebug = (...args: unknown[]) => logIfEnabled("debug", args)
export const logError = (...args: unknown[]) => logIfEnabled("error", args)
export const logWarn = (...args: unknown[]) => logIfEnabled("warn", args)
export const logInfo = (...args: unknown[]) => logIfEnabled("info", args)
