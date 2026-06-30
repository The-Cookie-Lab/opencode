import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { WritePatchTool } from "../../src/tool/write_patch"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-write-patch-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(LayerNode.group([LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node]))

const it = testEffect(layer)

const init = Effect.fn("WritePatchToolTest.init")(function* () {
  const info = yield* WritePatchTool
  return yield* info.init()
})

const run = Effect.fn("WritePatchToolTest.run")(function* (
  args: Tool.InferParameters<typeof WritePatchTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const fail = Effect.fn("WritePatchToolTest.fail")(function* (args: Tool.InferParameters<typeof WritePatchTool>) {
  const exit = yield* run(args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected write_patch to fail")
})

const put = Effect.fn("WritePatchToolTest.put")(function* (p: string, content: string) {
  const appfs = yield* FSUtil.Service
  yield* appfs.writeWithDirs(p, content)
})

const load = Effect.fn("WritePatchToolTest.load")(function* (p: string) {
  const appfs = yield* FSUtil.Service
  return yield* appfs.readFileString(p)
})

const loadRaw = Effect.fn("WritePatchToolTest.loadRaw")(function* (p: string) {
  return yield* Effect.promise(() => fs.readFile(p, "utf-8"))
})

describe("tool.write_patch", () => {
  it.instance("creates new files when old is empty", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "new", "file.txt")
      const result = yield* run({ path: filepath, old: "", new: "new content" })

      expect(result.output).toContain("Patch applied")
      expect(result.metadata.diff).toContain("new content")
      expect(yield* load(filepath)).toBe("new content")
    }),
  )

  it.instance("replaces exactly one occurrence by default", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "existing.txt")
      yield* put(filepath, "alpha beta gamma")

      yield* run({ path: filepath, old: "beta", new: "delta" })

      expect(yield* load(filepath)).toBe("alpha delta gamma")
    }),
  )

  it.instance("replaces all occurrences when count matches", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "existing.txt")
      yield* put(filepath, "foo bar foo")

      yield* run({ path: filepath, old: "foo", new: "baz", count: 2 })

      expect(yield* load(filepath)).toBe("baz bar baz")
    }),
  )

  it.instance("fails without mutating when occurrence count mismatches", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "existing.txt")
      yield* put(filepath, "foo bar foo")

      const error = yield* fail({ path: filepath, old: "foo", new: "baz" })

      expect(error.message).toContain("Expected 1 replacement")
      expect(error.message).toContain("found 2")
      expect(yield* load(filepath)).toBe("foo bar foo")
    }),
  )

  it.instance("reports nearest text when exact old text is missing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "existing.txt")
      yield* put(filepath, "alpha beta gamma")

      const error = yield* fail({ path: filepath, old: "alpha zeta gamma", new: "replacement" })

      expect(error.message).toContain("Expected 1 replacement")
      expect(error.message).toContain("Nearest match")
      expect(error.message).toContain("alpha beta gamma")
    }),
  )

  it.instance("preserves CRLF line endings", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "existing.txt")
      yield* put(filepath, "line1\r\nold\r\nline3")

      yield* run({ path: filepath, old: "old", new: "new" })

      expect(yield* loadRaw(filepath)).toBe("line1\r\nnew\r\nline3")
    }),
  )

  it.instance("throws when replacing in a missing file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const error = yield* fail({ path: path.join(test.directory, "missing.txt"), old: "old", new: "new" })

      expect(error.message).toContain("File not found")
    }),
  )
})
