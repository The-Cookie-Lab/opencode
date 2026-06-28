import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "@/provider/provider"
import { LocalModelServerMemory } from "@/memory/local-model-server"
import { Log } from "@opencode-ai/core/util/log"

const originalFetch = globalThis.fetch
const localProviderID = ProviderV2.ID.make("local-model-server")
const memoryLogger = Log.create({ service: "local-model-server.memory" })
let restoreWarnings: (() => void) | undefined

const providerLayer = Layer.succeed(
  Provider.Service,
  Provider.Service.of({
    list: () =>
      Effect.succeed({
        [localProviderID]: {
          id: localProviderID,
          name: "Local Model Server",
          source: "config" as const,
          env: [],
          key: undefined,
          options: { baseURL: "http://model.test/v1" },
          models: {},
        },
      }),
    getProvider: () =>
      Effect.succeed({
        id: localProviderID,
        name: "Local Model Server",
        source: "config" as const,
        env: [],
        key: undefined,
        options: { baseURL: "http://model.test/v1" },
        models: {},
      }),
    getModel: () => Effect.die("unused"),
    getLanguage: () => Effect.die("unused"),
    closest: () => Effect.succeed(undefined),
    getSmallModel: () => Effect.succeed(undefined),
    defaultModel: () => Effect.succeed({ providerID: localProviderID, modelID: ModelV2.ID.make("test") }),
  }),
)

const layer = Layer.mergeAll(LocalModelServerMemory.layer, providerLayer)

afterEach(() => {
  globalThis.fetch = originalFetch
  restoreWarnings?.()
  restoreWarnings = undefined
})

function captureWarnings() {
  restoreWarnings?.()
  const warn = spyOn(memoryLogger, "warn").mockImplementation(() => {})
  restoreWarnings = () => warn.mockRestore()
  return warn
}

function expectWarning(
  warn: ReturnType<typeof captureWarnings>,
  message: string,
  expected: Record<string, unknown>,
) {
  expect(warn).toHaveBeenCalledTimes(1)
  const [actualMessage, actualDetails] = warn.mock.calls[0] ?? []
  expect(actualMessage).toBe(message)
  const details = actualDetails as Record<string, unknown>
  for (const [key, value] of Object.entries(expected)) {
    expect(details[key]).toEqual(value)
  }
  return JSON.stringify(warn.mock.calls)
}

describe("LocalModelServerMemory", () => {
  test("posts memsearch requests to the model-server OpenViking facade", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ status: "ok", mode: "deep", result: [{ uri: "viking://memory" }] }), {
        status: 200,
      })
    }) as unknown as typeof fetch

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const memory = yield* LocalModelServerMemory.Service
        return yield* memory.search({
          sessionID: "oc-session-1",
          providerID: localProviderID,
          query: "prior decision",
          target_uri: "viking://resources/codex-memories",
          mode: "deep",
          limit: 4,
          score_threshold: 0.3,
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(result.status).toBe("ok")
    expect(calls).toEqual([
      {
        url: "http://model.test/v1/openviking/search",
        body: {
          opencode_session_id: "oc-session-1",
          query: "prior decision",
          target_uri: "viking://resources/codex-memories",
          mode: "deep",
          limit: 4,
          score_threshold: 0.3,
        },
      },
    ])
  })

  test("posts memread requests to the model-server OpenViking facade", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ status: "ok", level: "overview", result: { text: "memory" } }), {
        status: 200,
      })
    }) as unknown as typeof fetch

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const memory = yield* LocalModelServerMemory.Service
        return yield* memory.read({
          providerID: localProviderID,
          uri: "viking://resources/skills-library",
          level: "auto",
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(result.level).toBe("overview")
    expect(calls).toEqual([
      {
        url: "http://model.test/v1/openviking/read",
        body: {
          uri: "viking://resources/skills-library",
          level: "auto",
        },
      },
    ])
  })

  test("captureMessage fails open when model-server is unavailable", async () => {
    const warn = captureWarnings()
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      throw new Error("offline")
    }) as unknown as typeof fetch

    await Effect.runPromise(
      Effect.gen(function* () {
        const memory = yield* LocalModelServerMemory.Service
        yield* memory.captureMessage({
          sessionID: "oc-session-1",
          messageID: "msg-1",
          providerID: localProviderID,
          role: "user",
          content: "remember this",
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(calls).toBe(1)
    const logged = expectWarning(warn, "capture failed", {
      sessionID: "oc-session-1",
      messageID: "msg-1",
      role: "user",
      contentChars: 13,
      error: "offline",
    })
    expect(logged).not.toContain("remember this")
  })

  test("captureMessageParts posts structured parts to the OpenViking facade", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 })
    }) as unknown as typeof fetch

    await Effect.runPromise(
      Effect.gen(function* () {
        const memory = yield* LocalModelServerMemory.Service
        yield* memory.captureMessageParts({
          sessionID: "oc-session-1",
          messageID: "msg-2",
          providerID: localProviderID,
          role: "assistant",
          content: "assistant text",
          parts: [
            { type: "text", text: "assistant text" },
            {
              type: "tool",
              tool_id: "call-1",
              tool_name: "memsearch",
              tool_input: { query: "prior decision" },
              tool_output: "{}",
              tool_status: "completed",
              duration_ms: 12,
              prompt_tokens: 3,
              completion_tokens: 1,
            },
          ],
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(calls).toEqual([
      {
        url: "http://model.test/v1/openviking/sessions/oc-session-1/messages",
        body: {
          message_id: "msg-2",
          role: "assistant",
          content: "assistant text",
          parts: [
            { type: "text", text: "assistant text" },
            {
              type: "tool",
              tool_id: "call-1",
              tool_name: "memsearch",
              tool_input: { query: "prior decision" },
              tool_output: "{}",
              tool_status: "completed",
              duration_ms: 12,
              prompt_tokens: 3,
              completion_tokens: 1,
            },
          ],
        },
      },
    ])
  })

  test("captureMessageParts encodes session IDs and fails open without logging payloads", async () => {
    const warn = captureWarnings()
    let calls = 0
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls++
      expect(String(input)).toBe("http://model.test/v1/openviking/sessions/oc%2Fsession%201/messages")
      throw new Error("offline")
    }) as unknown as typeof fetch

    await Effect.runPromise(
      Effect.gen(function* () {
        const memory = yield* LocalModelServerMemory.Service
        yield* memory.captureMessageParts({
          sessionID: "oc/session 1",
          messageID: "msg-2",
          providerID: localProviderID,
          role: "assistant",
          content: "assistant text",
          parts: [{ type: "tool", tool_id: "call-1", tool_output: "secret output" }],
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(calls).toBe(1)
    const logged = expectWarning(warn, "structured capture failed", {
      sessionID: "oc/session 1",
      messageID: "msg-2",
      role: "assistant",
      contentChars: 14,
      partsCount: 1,
      error: "offline",
    })
    expect(logged).not.toContain("assistant text")
    expect(logged).not.toContain("secret output")
  })

  test("search logs and surfaces model-server exceptions", async () => {
    const warn = captureWarnings()
    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const memory = yield* LocalModelServerMemory.Service
          yield* memory.search({
            sessionID: "oc-session-1",
            providerID: localProviderID,
            query: "prior decision",
            mode: "auto",
          })
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("offline")

    const logged = expectWarning(warn, "search failed", {
      sessionID: "oc-session-1",
      queryChars: 14,
      mode: "auto",
      error: "offline",
    })
    expect(logged).not.toContain("prior decision")
  })

  test("read logs and surfaces model-server exceptions", async () => {
    const warn = captureWarnings()
    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const memory = yield* LocalModelServerMemory.Service
          yield* memory.read({
            providerID: localProviderID,
            uri: "viking://resources/skills-library",
            level: "auto",
          })
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("offline")

    const logged = expectWarning(warn, "read failed", {
      uriChars: 33,
      level: "auto",
      error: "offline",
    })
    expect(logged).not.toContain("viking://resources/skills-library")
  })

  test("captureMessage ignores non-local providers without posting", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    await Effect.runPromise(
      Effect.gen(function* () {
        const memory = yield* LocalModelServerMemory.Service
        yield* memory.captureMessage({
          sessionID: "oc-session-1",
          messageID: "msg-1",
          providerID: ProviderV2.ID.opencode,
          role: "user",
          content: "remember this",
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(calls).toBe(0)
  })

  test("captureMessageParts ignores non-local providers without posting", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    await Effect.runPromise(
      Effect.gen(function* () {
        const memory = yield* LocalModelServerMemory.Service
        yield* memory.captureMessageParts({
          sessionID: "oc-session-1",
          messageID: "msg-1",
          providerID: ProviderV2.ID.opencode,
          role: "assistant",
          parts: [{ type: "tool", tool_id: "call-1" }],
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(calls).toBe(0)
  })
})
