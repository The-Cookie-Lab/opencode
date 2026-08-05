import { expect, test } from "bun:test"
import { type CliRenderer } from "@opentui/core"
import { getRuntimeLifecycleRendererConfig, shutdownRenderer } from "@/cli/cmd/run/runtime.lifecycle"

void test("uses console-overlay with captured stdout for runtime lifecycle renderer", () => {
  expect(getRuntimeLifecycleRendererConfig()).toMatchObject({
    externalOutputMode: "capture-stdout",
    consoleMode: "console-overlay",
  })
})

void test("tears down runtime renderer by dropping external capture before removing split-footer", () => {
  const events: string[] = []
  let externalOutputMode: "capture-stdout" | "passthrough" = "capture-stdout"
  let screenMode: "split-footer" | "main-screen" = "split-footer"
  let isDestroyed = false
  const renderer = {
    get externalOutputMode() {
      return externalOutputMode
    },
    set externalOutputMode(value: "capture-stdout" | "passthrough") {
      events.push("externalOutputMode")
      externalOutputMode = value
    },
    get screenMode() {
      return screenMode
    },
    set screenMode(value: "split-footer" | "main-screen") {
      events.push("screenMode")
      screenMode = value
    },
    get isDestroyed() {
      return isDestroyed
    },
    destroy() {
      events.push("destroy")
      isDestroyed = true
    },
  } as CliRenderer & { isDestroyed: boolean }

  shutdownRenderer(renderer)

  expect(renderer.externalOutputMode).toBe("passthrough")
  expect(renderer.screenMode).toBe("main-screen")
  expect(renderer.isDestroyed).toBe(true)
  expect(events).toEqual(["externalOutputMode", "screenMode", "destroy"])
})
