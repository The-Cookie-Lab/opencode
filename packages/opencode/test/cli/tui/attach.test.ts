import { describe, expect, test } from "bun:test"

describe("tui attach", () => {
  test("loads the TUI integration lazily", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/attach.ts", import.meta.url)).text()

    expect(source).toContain('await import("../tui/layer")')
    expect(source).toMatch(/await import\(["']@\/plugin\/tui\/runtime["']\)/)
    expect(source).not.toContain('import("./app")')
  })

  test("validates mini attach sessions before runtime redirection", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/attach.ts", import.meta.url)).text()
    const miniMarker = "if (args.mini) {"
    const miniEndMarker = "const restoreTuiIO = redirectTuiWorkerIO()"
    const miniMarkerIndex = source.indexOf(miniMarker)
    const miniEndMarkerIndex = source.indexOf(miniEndMarker, miniMarkerIndex)
    const miniBlock = source.slice(miniMarkerIndex, miniEndMarkerIndex)

    expect(miniMarkerIndex).toBeGreaterThan(-1)
    expect(miniBlock).not.toContain("const restoreTuiIO = redirectTuiWorkerIO()")
    expect(miniBlock).toContain('const { runMini } = await import("./run")')
  })

  test("re-routes stderr to stdout during full attach sessions", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/attach.ts", import.meta.url)).text()
    const fullAttachMarker = "const { TuiConfig } = await import(\"@/config/tui\")"
    const restoreMarker = "const restoreTuiIO = redirectTuiWorkerIO()"
    const restoreIndex = source.indexOf(restoreMarker)
    const fullAttachIndex = source.indexOf(fullAttachMarker)

    expect(restoreIndex).toBeGreaterThan(-1)
    expect(fullAttachIndex).toBeGreaterThan(restoreIndex)
    expect(source.slice(fullAttachIndex)).toContain("finally")
    expect(source.slice(fullAttachIndex)).toContain("restoreTuiIO?.()")
  })
})
