import { describe, expect, test } from "bun:test"

describe("opencode run command", () => {
  test("runs mini invocations through run command mode", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/run.ts", import.meta.url)).text()

    expect(source).toContain("const interactive = args.mini")
    expect(source).toContain("const restoreTuiIO = interactive ? redirectTuiWorkerIO() : undefined")
    expect(source).toContain("mini: true")
    expect(source).toContain("replay: input.replay ?? true")
  })
})
