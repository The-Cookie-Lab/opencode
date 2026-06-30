import { describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { RgTool } from "../../src/tool/rg"
import { TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Ripgrep } from "@opencode-ai/core/filesystem/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { testEffect } from "../lib/effect"
import { Reference } from "@/reference/reference"
import { RepositoryCache } from "@/reference/repository-cache"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Git } from "@/git"
import type * as Tool from "../../src/tool/tool"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"

const layer = LayerNode.compile(
  LayerNode.group([Agent.node, FSUtil.node, Git.node, RepositoryCache.node, Reference.node, Ripgrep.node, Truncate.node]),
  [[RuntimeFlags.node, RuntimeFlags.layer({})]],
)

const it = testEffect(layer)

const ctx = {
  sessionID: SessionID.make("ses_test-rg-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const init = Effect.fn("RgToolTest.init")(function* () {
  const info = yield* RgTool
  return yield* info.init()
})

const run = Effect.fn("RgToolTest.run")(function* (
  args: Tool.InferParameters<typeof RgTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    } satisfies Tool.Context,
  }
}

describe("tool.rg", () => {
  it.instance("searches file contents", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "src", "index.ts")
      yield* Effect.promise(() => Bun.write(filepath, "export const needle = true\n"))

      const result = yield* run({ pattern: "needle", path: test.directory, glob: "*.ts" })

      expect(result.metadata.count).toBe(1)
      expect(result.metadata.mode).toBe("content")
      expect(result.output).toContain(filepath)
      expect(result.output).toContain("Line 1: export const needle = true")
    }),
  )

  it.instance("supports exact file paths", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "notes.txt")
      yield* Effect.promise(() => Bun.write(filepath, "alpha\nneedle\nomega\n"))

      const result = yield* run({ pattern: "needle", path: filepath })

      expect(result.metadata.count).toBe(1)
      expect(result.output).toContain(filepath)
      expect(result.output).toContain("Line 2: needle")
    }),
  )

  it.instance("lists files in files mode", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "a.ts"), "export const a = 1\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "b.txt"), "hello\n"))

      const result = yield* run({ pattern: "*.ts", path: test.directory, mode: "files" })

      expect(result.metadata.count).toBe(1)
      expect(result.metadata.mode).toBe("files")
      expect(result.output).toContain(path.join(test.directory, "a.ts"))
      expect(result.output).not.toContain(path.join(test.directory, "b.txt"))
    }),
  )

  it.instance("supports literal content searches", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "literal.txt"), "a.b\nacb\n"))

      const result = yield* run({ pattern: "a.b", path: test.directory, literal: true })

      expect(result.metadata.count).toBe(1)
      expect(result.output).toContain("Line 1: a.b")
      expect(result.output).not.toContain("Line 2: acb")
    }),
  )

  it.instance("can exclude hidden files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "visible.txt"), "needle\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, ".hidden.txt"), "needle\n"))

      const result = yield* run({ pattern: "needle", path: test.directory, hidden: false })

      expect(result.metadata.count).toBe(1)
      expect(result.output).toContain("visible.txt")
      expect(result.output).not.toContain(".hidden.txt")
    }),
  )

  it.instance("uses grep permission for content and glob permission for files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "a.ts"), "needle\n"))
      const content = asks()
      const files = asks()

      yield* run({ pattern: "needle", path: test.directory }, content.next)
      yield* run({ pattern: "*.ts", path: test.directory, mode: "files" }, files.next)

      expect(content.items.map((item) => item.permission)).toContain("grep")
      expect(files.items.map((item) => item.permission)).toContain("glob")
    }),
  )
})
