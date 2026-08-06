import { describe, expect, test } from "bun:test"

describe("opencode index middleware", () => {
  test("clears OPENCODE_PRINT_LOGS unless print-logs is enabled", async () => {
    const source = await Bun.file(new URL("../../src/index.ts", import.meta.url)).text()

    expect(source).toMatch(
      /if \(opts\.printLogs\) \{\n\s*process\.env\.OPENCODE_PRINT_LOGS = "1"\n\s*\}\s*else \{\n\s*delete process\.env\.OPENCODE_PRINT_LOGS\n\s*\}/,
    )
  })
})
