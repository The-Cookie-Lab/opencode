import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ContextPlanner, LARGE_TOOL_OUTPUT_TOKENS, LEDGER_LIMIT } from "@/session/context-planner"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const sessionID = SessionID.make("session")
const run = testEffect(
  ContextPlanner.layer.pipe(
    Layer.provide(TestConfig.layer({})),
    Layer.provide(RuntimeFlags.layer({ outputTokenMax: 100 })),
  ),
)

describe("context planner", () => {
  run.effect("computes ratio decisions and hysteresis", () =>
    Effect.gen(function* () {
      const planner = yield* ContextPlanner.Service
      const messages = [user("001", "x".repeat(4_000))]
      const first = yield* planner.evaluate({ sessionID, messages, model: model(1_000), agent: agent(), now: 1 })
      const repeat = yield* planner.evaluate({ sessionID, messages, model: model(1_000), agent: agent(), now: 2 })
      const nextUser = yield* planner.evaluate({
        sessionID,
        messages: [...messages, user("002", "still high")],
        model: model(1_000),
        agent: agent(),
        now: 3,
      })

      expect(first.decision).toBe("shadow")
      expect(first.trigger).toBe("overflow-risk")
      expect(repeat.decision).toBe("none")
      expect(repeat.trigger).toBe("overflow-risk")
      expect(nextUser.decision).toBe("shadow")
    }),
  )

  run.effect("returns no trigger when usable context is zero", () =>
    Effect.gen(function* () {
      const planner = yield* ContextPlanner.Service
      const plan = yield* planner.evaluate({
        sessionID,
        messages: [user("010", "hello")],
        model: model(0),
        agent: agent(),
        now: 1,
      })

      expect(plan.ratio).toBe(0)
      expect(plan.trigger).toBe("none")
      expect(plan.decision).toBe("none")
    }),
  )

  run.effect("selects ledger actions for stale, duplicate, and large outputs", () =>
    Effect.gen(function* () {
      const planner = yield* ContextPlanner.Service
      const large = "x".repeat(LARGE_TOOL_OUTPUT_TOKENS * 4)
      const messages = [
        user("020", "start"),
        assistant("021", [tool("021-read", "read", { input: { filePath: "src/a.ts" }, output: "old" })]),
        user("022", "next"),
        user("023", "next"),
        user("024", "next"),
        assistant("025", [
          tool("025-read", "read", { input: { filePath: "src/a.ts" }, output: "new" }),
          tool("025-bash", "bash", { output: large }),
        ]),
      ]
      const plan = yield* planner.evaluate({ sessionID, messages, model: model(200_000), agent: agent(), now: 1 })

      expect(plan.ledger.some((item) => item.action === "drop" && item.source.path === "src/a.ts")).toBe(true)
      expect(plan.ledger.some((item) => item.action === "externalize" && item.source.partID === "prt_025-bash")).toBe(
        true,
      )
      expect(plan.projectedSavingsTokens).toBeGreaterThan(0)
    }),
  )

  run.effect("caps ledger size and leaves input messages unchanged", () =>
    Effect.gen(function* () {
      const planner = yield* ContextPlanner.Service
      const messages = [
        user("100", "start"),
        ...Array.from({ length: LEDGER_LIMIT + 5 }, (_, index) =>
          assistant(String(101 + index), [
            tool(`${101 + index}-read`, "read", { input: { filePath: `src/${index}.ts` }, output: "content" }),
          ]),
        ),
      ]
      const before = JSON.stringify(messages)
      const plan = yield* planner.evaluate({ sessionID, messages, model: model(200_000), agent: agent(), now: 1 })

      expect(plan.ledger.length).toBe(LEDGER_LIMIT)
      expect(JSON.stringify(messages)).toBe(before)
    }),
  )
})

function user(id: string, text: string): SessionV1.WithParts {
  const messageID = MessageID.make(`msg_${id}`)
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: Number(id) },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    } as SessionV1.User,
    parts: [
      {
        id: PartID.make(`prt_${id}-text`),
        sessionID,
        messageID,
        type: "text",
        text,
      },
    ],
  }
}

function assistant(id: string, parts: SessionV1.Part[]): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.make(`msg_${id}`),
      sessionID,
      role: "assistant",
      time: { created: Number(id) },
      parentID: MessageID.make("msg_parent"),
      modelID: "test",
      providerID: "test",
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    } as SessionV1.Assistant,
    parts,
  }
}

function tool(
  id: string,
  name: string,
  input: { input?: Record<string, unknown>; output?: string; compacted?: boolean } = {},
): SessionV1.ToolPart {
  return {
    id: PartID.make(`prt_${id}`),
    sessionID,
    messageID: MessageID.make("msg_tool"),
    type: "tool",
    callID: `call_${id}`,
    tool: name,
    state: {
      status: "completed",
      input: input.input ?? {},
      output: input.output ?? "",
      title: name,
      metadata: {},
      time: { start: 1_000, end: 1_100, compacted: input.compacted ? 1_050 : undefined },
    },
  }
}

function model(context: number): Provider.Model {
  return {
    id: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    api: { id: "test", url: "http://localhost", npm: "@ai-sdk/openai-compatible" },
    name: "test",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context, output: 100 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  } as Provider.Model
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    description: "test",
    permission: [],
    tools: {},
    options: {},
  } as Agent.Info
}
