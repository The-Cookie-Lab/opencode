import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import {
  aggregateContextIntelligence,
  collectTurnSample,
  renderContextIntelligenceSummary,
} from "@/quality/context-intelligence"

const sessionID = SessionID.make("session")

describe("context intelligence burn-in aggregation", () => {
  test("classifies macro and control turns with prompt pressure and shadow data", () => {
    const userOne = user("001", "Investigate the project")
    const macro = assistant("002", [
      stepStart("002-a", {
        contextPlan: {
          mode: "shadow",
          decision: "shadow",
          trigger: "ratio",
          ratio: 0.58,
          threshold: 0.5,
          projectedSavingsTokens: 900,
          ledger: [
            {
              kind: "file_observation",
              source: { sessionID, messageID: "msg_002", partID: "prt_002-tool", path: "src/old.ts" },
              tokens: 1_000,
              importance: 0.8,
              freshness: "stale",
              action: "drop",
              reason: "newer duplicate",
            },
          ],
        },
      }),
      tool("002-tool", "project_dossier", {
        output: "summary",
        metadata: {
          telemetry: { time_to_first_edit_ms: 120, time_to_first_test_ms: 400 },
        },
      }),
      tool("002-read", "read", { input: { filePath: "src/old.ts" }, output: "old" }),
      tool("002-skill", "skill", { input: { name: "openai-docs" }, output: "loaded" }),
      tool("002-memsearch", "memsearch", {
        input: { query: "prior decision" },
        output: JSON.stringify({
          status: "ok",
          result: [{ uri: "viking://resources/codex-memories/MEMORY.md" }],
        }),
      }),
      tool("002-memread", "memread", {
        input: { uri: "viking://resources/codex-memories/MEMORY.md" },
        output: JSON.stringify({
          status: "ok",
          uri: "viking://resources/codex-memories/MEMORY.md",
          result: { text: "memory" },
        }),
      }),
      finish("002-finish", {
        messages: [{ role: "user", tokens: 100, cached: 20 }],
        tools: [{ name: "project_dossier", tokens: 30 }],
        agent_instructions: [{ tokens: 10, cached: 5 }],
        template_overhead: 7,
        image_tokens: 0,
      }),
    ])
    const userTwo = user("003", "Use primitives")
    const control = assistant("004", [
      tool("004-read", "read", { input: { filePath: "src/old.ts" }, output: "reread" }),
      tool("004-grep", "grep", { output: "match" }),
    ])

    const samples = [
      collectTurnSample({ message: macro, previous: userOne }),
      collectTurnSample({ message: control, previous: userTwo }),
    ].filter((sample) => sample !== undefined)
    const report = aggregateContextIntelligence(samples)

    expect(report.turns).toBe(2)
    expect(report.macroTurns).toBe(1)
    expect(report.macroFirstRate).toBe(1)
    expect(report.controlPrimitiveDiscoveryAvg).toBe(2)
    expect(report.macroPrimitiveDiscoveryAvg).toBe(1)
    expect(report.readGrepReductionRate).toBe(0.5)
    expect(report.promptPressure.input).toBe(100)
    expect(report.promptPressure.cached).toBe(25)
    expect(report.tools.calls).toBe(7)
    expect(report.tools.successRate).toBe(1)
    expect(report.tools.schemaTokenFootprint).toEqual([{ tool: "project_dossier", tokens: 30 }])
    expect(report.skills.calls).toBe(1)
    expect(report.skills.unique).toBe(1)
    expect(report.memory.searchCount).toBe(1)
    expect(report.memory.readCount).toBe(1)
    expect(report.memory.returnedUriCount).toBe(1)
    expect(report.memory.readAfterSearchUtilizationRate).toBe(1)
    expect(report.memory.sourceKindMix).toEqual([{ kind: "resource", count: 2 }])
    expect(report.shadow.candidateCount).toBe(1)
    expect(report.shadow.projectedSavingsTokens).toBe(900)
    expect(report.shadow.rereadAfterDropCount).toBe(1)
    expect(report.dataGaps).toEqual(["promptTokensDetails", "contextPlan", "sinkHealth"])
  })

  test("detects semantic cold fallback and warm indexes", () => {
    const cold = assistant("010", [
      tool("010-search", "semantic_search", {
        metadata: { mode: "lexical", indexed: false, scheduled: true },
      }),
    ])
    const warm = assistant("011", [
      tool("011-search", "semantic_search", {
        metadata: { mode: "semantic", indexed: true, scheduled: false },
      }),
    ])
    const report = aggregateContextIntelligence(
      [collectTurnSample({ message: cold }), collectTurnSample({ message: warm })].filter(
        (sample) => sample !== undefined,
      ),
    )

    expect(report.semanticColdFallbackRate).toBe(0.5)
    expect(report.semanticWarmIndexRate).toBe(0.5)
  })

  test("renders zero-data reports without failing", () => {
    const text = renderContextIntelligenceSummary(aggregateContextIntelligence([]))

    expect(text).toContain("CONTEXT INTELLIGENCE BURN-IN")
    expect(text).toContain("Turns sampled: 0")
    expect(text).toContain("Data gaps: none")
  })
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

function stepStart(id: string, metadata: NonNullable<SessionV1.StepStartPart["metadata"]>): SessionV1.StepStartPart {
  return {
    id: PartID.make(`prt_${id}`),
    sessionID,
    messageID: MessageID.make("msg_002"),
    type: "step-start",
    metadata,
  }
}

function finish(
  id: string,
  promptTokensDetails: NonNullable<SessionV1.StepFinishPart["promptTokensDetails"]>,
): SessionV1.StepFinishPart {
  return {
    id: PartID.make(`prt_${id}`),
    sessionID,
    messageID: MessageID.make("msg_002"),
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    promptTokensDetails,
  }
}

function tool(
  id: string,
  name: string,
  input: {
    input?: Record<string, unknown>
    output?: string
    metadata?: Record<string, unknown>
  } = {},
): SessionV1.ToolPart {
  return {
    id: PartID.make(`prt_${id}`),
    sessionID,
    messageID: MessageID.make("msg_002"),
    type: "tool",
    callID: `call_${id}`,
    tool: name,
    state: {
      status: "completed",
      input: input.input ?? {},
      output: input.output ?? "",
      title: name,
      metadata: input.metadata ?? {},
      time: { start: 1_000, end: 1_100 },
    },
  }
}
