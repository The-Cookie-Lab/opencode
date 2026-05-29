import { describe, expect, it } from "bun:test"
import {
  estimateSessionContextBreakdown,
  estimateToolDefinitionTokens,
  estimateDetailedContextBreakdown,
} from "./session-context-breakdown"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import type { ServerPromptTokensDetails } from "./session-context-breakdown"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeMsg = (overrides: Partial<Message> & { role: "user" | "assistant" }): Message =>
  ({ id: `msg-${overrides.role}-${Math.random().toString(36).slice(2, 8)}`, ...overrides }) as Message

const textPart = (text: string): Part =>
  ({ id: "p1", sessionID: "s", messageID: "m", type: "text", text } as Part)

const filePart = (value: string): Part =>
  ({
    id: "p1", sessionID: "s", messageID: "m", type: "file", mime: "text/plain", url: "",
    source: { text: { value, start: 0, end: value.length }, type: "file", path: "/f" },
  } as Part)

const agentPart = (value: string): Part =>
  ({
    id: "p1", sessionID: "s", messageID: "m", type: "agent", name: "a",
    source: { value, start: 0, end: value.length },
  } as Part)

const reasoningPart = (text: string): Part =>
  ({ id: "p1", sessionID: "s", messageID: "m", type: "reasoning", text } as Part)

const toolPart = (status: "pending" | "completed" | "error", rawOrOutput: string, keys = 2): Part =>
  ({
    id: "p1", sessionID: "s", messageID: "m", type: "tool", callID: "c", tool: "t",
    state: {
      status,
      input: Object.fromEntries(Array.from({ length: keys }, (_, i) => [String(i), `val${i}`])),
      ...(status === "pending" ? { raw: rawOrOutput } : {}),
      ...(status === "completed" ? { output: rawOrOutput, title: "t", metadata: {}, time: { start: 0, end: 0 } } : {}),
      ...(status === "error" ? { error: rawOrOutput, metadata: {}, time: { start: 0, end: 0 } } : {}),
    },
  } as Part)

// ---------------------------------------------------------------------------
// TOOL_SCHEMA_ESTIMATES
// ---------------------------------------------------------------------------
describe("TOOL_SCHEMA_ESTIMATES", () => {
  it("covers every built-in tool key used in estimateToolDefinitionTokens", () => {
    // If a new built-in tool is added without a schema estimate entry
    // the function falls back to DEFAULT_SCHEMA_CHARS=700 (175 tokens).
    // This test protects the known set with exact token values.
    const known: Record<string, number> = {
      shell: 500, bash: 500, read: 225, write: 200, edit: 350, patch: 300,
      grep: 275, glob: 175, task: 425, webfetch: 225, websearch: 225, todowrite: 375,
      question: 325, semanticsearch: 200, skill: 150, lsp: 400, repoclone: 175,
      repooverview: 150, projectdossier: 125, viewoutline: 200, planexit: 75,
      applypatch: 175, invalid: 50,
    }
    for (const [name, expected] of Object.entries(known)) {
      expect(estimateToolDefinitionTokens({ [name]: true })).toBe(expected)
    }
  })
})

// ---------------------------------------------------------------------------
// estimateToolDefinitionTokens
// ---------------------------------------------------------------------------
describe("estimateToolDefinitionTokens", () => {
  it("returns 0 for undefined tools", () => {
    expect(estimateToolDefinitionTokens(undefined)).toBe(0)
  })

  it("returns 0 for empty tools object", () => {
    expect(estimateToolDefinitionTokens({})).toBe(0)
  })

  it("skips disabled tools (false values)", () => {
    expect(estimateToolDefinitionTokens({ shell: false, read: false })).toBe(0)
  })

  it("estimates known tools using schema size constants", () => {
    // shell = 2000 chars, read = 900 chars → 2900 chars → ceil(2900/4) = 725
    expect(estimateToolDefinitionTokens({ shell: true, read: true })).toBe(725)
  })

  it("uses DEFAULT_SCHEMA_CHARS (700) for unknown tools", () => {
    // unknown-tool → 700 chars → ceil(700/4) = 175
    expect(estimateToolDefinitionTokens({ "unknown-custom-tool": true })).toBe(175)
  })

  it("matches tools case-insensitively", () => {
    // SHELL → 2000 chars → ceil(2000/4) = 500
    expect(estimateToolDefinitionTokens({ SHELL: true })).toBe(500)
  })

  it("sums mixed known and unknown tools correctly", () => {
    // shell=2000 + unknown=700 → 2700 → ceil(2700/4)=675
    expect(estimateToolDefinitionTokens({ shell: true, "custom-thing": true })).toBe(675)
  })

  it("handles a realistic set of tools", () => {
    // shell=2000 + read=900 + write=800 + edit=1400 + grep=1100 + glob=700 + task=1700
    // total = 8600 chars → ceil(8600/4) = 2150
    expect(estimateToolDefinitionTokens({
      shell: true, read: true, write: true,
      edit: true, grep: true, glob: true, task: true,
    })).toBe(2150)
  })
})

// ---------------------------------------------------------------------------
// estimateDetailedContextBreakdown
// ---------------------------------------------------------------------------
describe("estimateDetailedContextBreakdown", () => {
  // --- empty / zero input ---

  it("returns empty array when input is 0", () => {
    expect(estimateDetailedContextBreakdown({ messages: [], parts: {}, input: 0 })).toEqual([])
  })

  it("returns empty array when input is negative", () => {
    expect(estimateDetailedContextBreakdown({ messages: [], parts: {}, input: -1 })).toEqual([])
  })

  // --- system_prompt ---

  it("estimates system_prompt tokens", () => {
    const prompt = "a".repeat(400) // 400 chars → ceil(400/4) = 100 tokens
    const result = estimateDetailedContextBreakdown({
      messages: [], parts: {}, input: 200, systemPrompt: prompt,
    })
    const seg = result.find(s => s.key === "system_prompt")
    expect(seg).toBeDefined()
    expect(seg!.tokens).toBe(100)
  })

  it("excludes system_prompt when not provided", () => {
    const result = estimateDetailedContextBreakdown({ messages: [], parts: {}, input: 100 })
    expect(result.find(s => s.key === "system_prompt")).toBeUndefined()
  })

  // --- tool_definitions ---

  it("estimates tool_definitions tokens", () => {
    // shell=2000 → ceil(2000/4)=500
    const result = estimateDetailedContextBreakdown({
      messages: [], parts: {}, input: 600, tools: { shell: true },
    })
    const seg = result.find(s => s.key === "tool_definitions")
    expect(seg).toBeDefined()
    expect(seg!.tokens).toBe(500)
  })

  it("excludes tool_definitions when tools not provided", () => {
    const result = estimateDetailedContextBreakdown({ messages: [], parts: {}, input: 100 })
    expect(result.find(s => s.key === "tool_definitions")).toBeUndefined()
  })

  // --- user_messages ---

  it("estimates user_messages from text parts", () => {
    const msg = makeMsg({ role: "user" })
    const result = estimateDetailedContextBreakdown({
      messages: [msg], parts: { [msg.id]: [textPart("hello world")] }, input: 10,
    })
    expect(result.find(s => s.key === "user_messages")!.tokens).toBe(3) // 11 chars
  })

  it("estimates user_messages from file parts", () => {
    const content = "file content here" // 17 chars → ceil(17/4)=5
    const msg = makeMsg({ role: "user" })
    const result = estimateDetailedContextBreakdown({
      messages: [msg], parts: { [msg.id]: [filePart(content)] }, input: 10,
    })
    expect(result.find(s => s.key === "user_messages")!.tokens).toBe(5)
  })

  it("estimates user_messages from agent parts", () => {
    const content = "agent message" // 13 chars → ceil(13/4)=4
    const msg = makeMsg({ role: "user" })
    const result = estimateDetailedContextBreakdown({
      messages: [msg], parts: { [msg.id]: [agentPart(content)] }, input: 10,
    })
    expect(result.find(s => s.key === "user_messages")!.tokens).toBe(4)
  })

  it("sums user_messages across multiple parts", () => {
    const msg = makeMsg({ role: "user" })
    // "hi"(2) + "there"(5) = 7 chars → ceil(7/4)=2
    const result = estimateDetailedContextBreakdown({
      messages: [msg], parts: { [msg.id]: [textPart("hi"), textPart("there")] }, input: 10,
    })
    expect(result.find(s => s.key === "user_messages")!.tokens).toBe(2)
  })

  it("handles messages with no parts gracefully", () => {
    const msg = makeMsg({ role: "user" })
    const result = estimateDetailedContextBreakdown({
      messages: [msg], parts: {}, input: 100,
    })
    expect(result.find(s => s.key === "user_messages")).toBeUndefined()
  })

  // --- assistant_messages ---

  it("estimates assistant_messages from text parts", () => {
    const msg = makeMsg({ role: "assistant" })
    const result = estimateDetailedContextBreakdown({
      messages: [msg], parts: { [msg.id]: [textPart("assistant response text")] }, input: 20,
    })
    // 22 chars → ceil(22/4)=6
    expect(result.find(s => s.key === "assistant_messages")!.tokens).toBe(6)
  })

  it("estimates assistant_messages from reasoning parts", () => {
    const msg = makeMsg({ role: "assistant" })
    const result = estimateDetailedContextBreakdown({
      messages: [msg], parts: { [msg.id]: [reasoningPart("thinking...")] }, input: 20,
    })
    // "thinking..." = 11 chars → ceil(11/4)=3
    expect(result.find(s => s.key === "assistant_messages")!.tokens).toBe(3)
  })

  // --- tool_results ---

  it("estimates tool_results from pending tool parts", () => {
    const msg = makeMsg({ role: "assistant" })
    // 2 keys × 16 = 32 + raw("tool call raw text"=19) = 51 → ceil(51/4)=13
    const result = estimateDetailedContextBreakdown({
      messages: [msg], parts: { [msg.id]: [toolPart("pending", "tool call raw text", 2)] }, input: 50,
    })
    expect(result.find(s => s.key === "tool_results")!.tokens).toBe(13)
  })

  it("estimates tool_results from completed tool parts", () => {
    const msg = makeMsg({ role: "assistant" })
    // 3 keys × 16 = 48 + output("tool output"=10) = 58 → ceil(58/4)=15
    const result = estimateDetailedContextBreakdown({
      messages: [msg], parts: { [msg.id]: [toolPart("completed", "tool output", 3)] }, input: 50,
    })
    expect(result.find(s => s.key === "tool_results")!.tokens).toBe(15)
  })

  it("estimates tool_results from error tool parts", () => {
    const msg = makeMsg({ role: "assistant" })
    // 1 key × 16 = 16 + error("tool error occurred"=19) = 35 → ceil(35/4)=9
    const result = estimateDetailedContextBreakdown({
      messages: [msg], parts: { [msg.id]: [toolPart("error", "tool error occurred", 1)] }, input: 50,
    })
    expect(result.find(s => s.key === "tool_results")!.tokens).toBe(9)
  })

  it("separates assistant_messages from tool_results in same message", () => {
    const msg = makeMsg({ role: "assistant" })
    const result = estimateDetailedContextBreakdown({
      messages: [msg],
      parts: { [msg.id]: [textPart("hello world"), toolPart("completed", "done", 1)] },
      input: 50,
    })
    expect(result.find(s => s.key === "assistant_messages")!.tokens).toBe(3)
    expect(result.find(s => s.key === "tool_results")!.tokens).toBe(5)
  })

  // --- overhead ---

  it("computes overhead as input minus allocated tokens", () => {
    const result = estimateDetailedContextBreakdown({ messages: [], parts: {}, input: 100 })
    expect(result.find(s => s.key === "overhead")!.tokens).toBe(100)
  })

  it("overhead is absent when allocated matches input exactly", () => {
    const prompt = "x".repeat(400) // 100 tokens
    const result = estimateDetailedContextBreakdown({
      messages: [], parts: {}, input: 100, systemPrompt: prompt,
    })
    // overhead = 0, so filtered out (tokens > 0 filter)
    expect(result.find(s => s.key === "overhead")).toBeUndefined()
  })

  it("overhead is absent when allocated exceeds input", () => {
    const prompt = "x".repeat(800) // 200 tokens
    const result = estimateDetailedContextBreakdown({
      messages: [], parts: {}, input: 100, systemPrompt: prompt,
    })
    // allocated > input → overhead = 0 → filtered out
    expect(result.find(s => s.key === "overhead")).toBeUndefined()
  })

  // --- percentages ---

  it("computes correct percentages for each segment", () => {
    const prompt = "x".repeat(800) // 200 tokens
    const result = estimateDetailedContextBreakdown({
      messages: [], parts: {}, input: 400, systemPrompt: prompt,
    })
    expect(result.find(s => s.key === "system_prompt")!.percent).toBe(50)
    expect(result.find(s => s.key === "overhead")!.percent).toBe(50)
  })

  it("percent sum is 100 when overhead is present", () => {
    const prompt = "x".repeat(200) // 50 tokens
    const msg = makeMsg({ role: "user" })
    const result = estimateDetailedContextBreakdown({
      messages: [msg], parts: { [msg.id]: [textPart("hello")] }, input: 100, systemPrompt: prompt,
    })
    // system=50, user=2, overhead=48 → sum=100
    const sum = result.reduce((s, r) => s + r.percent, 0)
    expect(sum).toBe(100)
  })

  // --- full integration ---

  it("produces all five meaningful segment types for a realistic scenario", () => {
    const prompt = "x".repeat(1600) // 400 tokens
    const userMsg = makeMsg({ role: "user" })
    const asstMsg = makeMsg({ role: "assistant" })

    const result = estimateDetailedContextBreakdown({
      messages: [userMsg, asstMsg],
      parts: {
        [userMsg.id]: [textPart("query text here")], // 16 chars → 4 tokens
        [asstMsg.id]: [textPart("response"), toolPart("completed", "output", 2)],
      },
      input: 600,
      systemPrompt: prompt,
      tools: { shell: true, read: true },
    })

    const keys = result.map(s => s.key).sort()
    // allocated(1141) > input(600) → overhead=0 → filtered out
    expect(keys).toEqual([
      "assistant_messages",
      "system_prompt",
      "tool_definitions",
      "tool_results",
      "user_messages",
    ])

    expect(result.find(s => s.key === "system_prompt")!.tokens).toBe(400)
    expect(result.find(s => s.key === "tool_definitions")!.tokens).toBe(725)
  })

  it("filters out zero-token segments", () => {
    const result = estimateDetailedContextBreakdown({
      messages: [], parts: {}, input: 100, systemPrompt: "", tools: {},
    })
    expect(result).toHaveLength(1)
    expect(result[0].key).toBe("overhead")
  })

  it("has correct return type shape", () => {
    const result = estimateDetailedContextBreakdown({ messages: [], parts: {}, input: 100 })
    for (const seg of result) {
      expect(seg).toHaveProperty("key")
      expect(seg).toHaveProperty("tokens")
      expect(seg).toHaveProperty("percent")
      expect(typeof seg.key).toBe("string")
      expect(typeof seg.tokens).toBe("number")
      expect(typeof seg.percent).toBe("number")
    }
  })
})

// ---------------------------------------------------------------------------
// estimateSessionContextBreakdown (existing function – regression protection)
// ---------------------------------------------------------------------------
describe("estimateSessionContextBreakdown", () => {
  it("returns empty array when input is 0", () => {
    expect(estimateSessionContextBreakdown({ messages: [], parts: {}, input: 0 })).toEqual([])
  })

  it("produces system/user/assistant/tool/other breakdown", () => {
    const userMsg = { id: "u1", role: "user" } as Message
    const asstMsg = { id: "a1", role: "assistant" } as Message
    const result = estimateSessionContextBreakdown({
      messages: [userMsg, asstMsg],
      parts: {
        u1: [{ id: "p1", sessionID: "s", messageID: "u1", type: "text", text: "hello" } as Part],
        a1: [{ id: "p2", sessionID: "s", messageID: "a1", type: "text", text: "world" } as Part],
      },
      input: 50,
      systemPrompt: "system prompt text here", // 22 chars → 6 tokens
    })

    const find = (key: string) => result.find(s => s.key === key)
    expect(find("system")?.tokens).toBe(6)   // ceil(22/4)
    expect(find("user")?.tokens).toBe(2)      // ceil(5/4)
    expect(find("assistant")?.tokens).toBe(2) // ceil(5/4)
    expect(find("tool")).toBeUndefined()
    expect(find("other")?.tokens).toBe(40)    // 50 - (6 + 2 + 2)

    for (const seg of result) {
      expect(seg).toHaveProperty("width")
      expect(typeof seg.width).toBe("number")
      expect(seg).toHaveProperty("percent")
      expect(typeof seg.percent).toBe("number")
    }
  })

  it("scales tokens when estimated exceeds input", () => {
    const prompt = "x".repeat(4000) // 1000 tokens worth of chars
    const result = estimateSessionContextBreakdown({
      messages: [], parts: {}, input: 500, systemPrompt: prompt,
    })
    const system = result.find(s => s.key === "system")!
    expect(system.tokens).toBeLessThanOrEqual(500)
    expect(system.tokens).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// estimateDetailedContextBreakdown — server-provided breakdown
// ---------------------------------------------------------------------------
describe("estimateDetailedContextBreakdown — serverBreakdown", () => {
  const emptyMessages: Message[] = []
  const emptyParts: Record<string, Part[]> = {}

  const makeServerBreakdown = (
    overrides: Partial<ServerPromptTokensDetails> = {},
  ): ServerPromptTokensDetails => ({
    messages: [],
    tools: [],
    template_overhead: 0,
    image_tokens: 0,
    ...overrides,
  })

  // --- fallback: no server data → use heuristic ---

  it("falls back to heuristic when serverBreakdown is undefined", () => {
    const msg = makeMsg({ role: "user" })
    const result = estimateDetailedContextBreakdown({
      messages: [msg], parts: { [msg.id]: [textPart("hello world")] }, input: 10,
    })
    // ceil(11/4) = 3
    expect(result.find(s => s.key === "user_messages")!.tokens).toBe(3)
  })

  it("falls back to heuristic when serverBreakdown.messages is empty array", () => {
    const msg = makeMsg({ role: "user" })
    const result = estimateDetailedContextBreakdown({
      messages: [msg],
      parts: { [msg.id]: [textPart("hello world")] },
      input: 10,
      serverBreakdown: { messages: [], tools: [], template_overhead: 0, image_tokens: 0 },
    })
    // empty messages → fallback to heuristic
    expect(result.find(s => s.key === "user_messages")!.tokens).toBe(3)
  })

  // --- system_prompt from server ---

  it("maps server system-role messages to system_prompt", () => {
    const sb = makeServerBreakdown({
      messages: [{ role: "system", tokens: 150, cached: 0 }],
      template_overhead: 10,
    })
    const result = estimateDetailedContextBreakdown({
      messages: emptyMessages, parts: emptyParts, input: 200, serverBreakdown: sb,
    })
    expect(result.find(s => s.key === "system_prompt")!.tokens).toBe(150)
  })

  // --- user_messages from server ---

  it("maps server user-role messages to user_messages", () => {
    const sb = makeServerBreakdown({
      messages: [
        { role: "user", tokens: 25, cached: 0 },
        { role: "user", tokens: 35, cached: 0 },
      ],
      template_overhead: 10,
    })
    const result = estimateDetailedContextBreakdown({
      messages: emptyMessages, parts: emptyParts, input: 100, serverBreakdown: sb,
    })
    expect(result.find(s => s.key === "user_messages")!.tokens).toBe(60)
  })

  // --- assistant_messages from server ---

  it("maps server assistant-role messages to assistant_messages", () => {
    const sb = makeServerBreakdown({
      messages: [{ role: "assistant", tokens: 80, cached: 0 }],
      template_overhead: 5,
    })
    const result = estimateDetailedContextBreakdown({
      messages: emptyMessages, parts: emptyParts, input: 100, serverBreakdown: sb,
    })
    expect(result.find(s => s.key === "assistant_messages")!.tokens).toBe(80)
  })

  // --- tool_results from server ---

  it("maps server tool-role messages to tool_results", () => {
    const sb = makeServerBreakdown({
      messages: [{ role: "tool", tokens: 42, cached: 0 }],
      template_overhead: 8,
    })
    const result = estimateDetailedContextBreakdown({
      messages: emptyMessages, parts: emptyParts, input: 60, serverBreakdown: sb,
    })
    expect(result.find(s => s.key === "tool_results")!.tokens).toBe(42)
  })

  // --- tool_definitions from server ---

  it("maps server tools array to tool_definitions", () => {
    const sb = makeServerBreakdown({
      tools: [
        { name: "shell", tokens: 500 },
        { name: "read", tokens: 225 },
      ],
      template_overhead: 10,
    })
    const result = estimateDetailedContextBreakdown({
      messages: emptyMessages, parts: emptyParts, input: 800, serverBreakdown: sb,
    })
    expect(result.find(s => s.key === "tool_definitions")!.tokens).toBe(725)
  })

  it("excludes tool_definitions when server tools array is empty", () => {
    const sb = makeServerBreakdown({ template_overhead: 10 })
    const result = estimateDetailedContextBreakdown({
      messages: emptyMessages, parts: emptyParts, input: 50, serverBreakdown: sb,
    })
    expect(result.find(s => s.key === "tool_definitions")).toBeUndefined()
  })

  // --- overhead from server (template_overhead) ---

  it("maps server template_overhead to overhead", () => {
    const sb = makeServerBreakdown({ template_overhead: 45 })
    const result = estimateDetailedContextBreakdown({
      messages: emptyMessages, parts: emptyParts, input: 100, serverBreakdown: sb,
    })
    expect(result.find(s => s.key === "overhead")!.tokens).toBe(45)
  })

  it("excludes overhead when template_overhead is 0", () => {
    // Server path with messages but no template overhead → overhead excluded
    const sb = makeServerBreakdown({
      messages: [{ role: "user", tokens: 40, cached: 0 }],
      template_overhead: 0,
    })
    const result = estimateDetailedContextBreakdown({
      messages: emptyMessages, parts: emptyParts, input: 60, serverBreakdown: sb,
    })
    expect(result.find(s => s.key === "overhead")).toBeUndefined()
  })

  // --- cached messages (not broken out, just ensures they don't break mapping) ---

  it("handles server messages with cached > 0 correctly", () => {
    const sb = makeServerBreakdown({
      messages: [
        { role: "system", tokens: 200, cached: 200 },
        { role: "user", tokens: 50, cached: 0 },
      ],
      template_overhead: 30,
    })
    const result = estimateDetailedContextBreakdown({
      messages: emptyMessages, parts: emptyParts, input: 300, serverBreakdown: sb,
    })
    expect(result.find(s => s.key === "system_prompt")!.tokens).toBe(200)
    expect(result.find(s => s.key === "user_messages")!.tokens).toBe(50)
    expect(result.find(s => s.key === "overhead")!.tokens).toBe(30)
  })

  // --- percentages ---

  it("computes correct percentages from server data", () => {
    const sb = makeServerBreakdown({
      messages: [
        { role: "system", tokens: 100, cached: 0 },
        { role: "user", tokens: 50, cached: 0 },
        { role: "assistant", tokens: 30, cached: 0 },
      ],
      template_overhead: 20,
    })
    const result = estimateDetailedContextBreakdown({
      messages: emptyMessages, parts: emptyParts, input: 200, serverBreakdown: sb,
    })
    expect(result.find(s => s.key === "system_prompt")!.percent).toBe(50)
    expect(result.find(s => s.key === "user_messages")!.percent).toBe(25)
    expect(result.find(s => s.key === "assistant_messages")!.percent).toBe(15)
    expect(result.find(s => s.key === "overhead")!.percent).toBe(10)
  })

  // --- image_tokens (allocated to user_messages) ---

  it("includes image_tokens in user_messages when server reports them", () => {
    const sb = makeServerBreakdown({
      messages: [
        { role: "user", tokens: 30, cached: 0 },
      ],
      image_tokens: 512,
      template_overhead: 20,
    })
    const result = estimateDetailedContextBreakdown({
      messages: emptyMessages, parts: emptyParts, input: 600, serverBreakdown: sb,
    })
    // user_messages should be 30 + 512 = 542
    expect(result.find(s => s.key === "user_messages")!.tokens).toBe(542)
  })

  it("distributes image_tokens proportionally across user messages when multiple", () => {
    const sb = makeServerBreakdown({
      messages: [
        { role: "user", tokens: 10, cached: 0 },
        { role: "user", tokens: 30, cached: 0 },
      ],
      image_tokens: 200,
      template_overhead: 15,
    })
    const result = estimateDetailedContextBreakdown({
      messages: emptyMessages, parts: emptyParts, input: 300, serverBreakdown: sb,
    })
    // image_tokens = 200 distributed proportionally: 10/40*200=50, 30/40*200=150
    // user_messages total = 10+50+30+150 = 240
    expect(result.find(s => s.key === "user_messages")!.tokens).toBe(240)
  })

  it("zero image_tokens does not affect output segments", () => {
    const sb = makeServerBreakdown({
      messages: [{ role: "user", tokens: 40, cached: 0 }],
      image_tokens: 0,
      template_overhead: 10,
    })
    const result = estimateDetailedContextBreakdown({
      messages: emptyMessages, parts: emptyParts, input: 60, serverBreakdown: sb,
    })
    expect(result.find(s => s.key === "user_messages")!.tokens).toBe(40)
    expect(result).toHaveLength(2) // user_messages + overhead
  })

  // --- edge cases ---

  it("handles server data where sum exceeds input (non-negative overhead)", () => {
    const sb = makeServerBreakdown({
      messages: [
        { role: "system", tokens: 200, cached: 0 },
      ],
      template_overhead: 50,
    })
    const result = estimateDetailedContextBreakdown({
      messages: emptyMessages, parts: emptyParts, input: 100, serverBreakdown: sb,
    })
    // allocated=250 > input=100 → overhead clamped to 0 → excluded
    expect(result.find(s => s.key === "system_prompt")!.tokens).toBe(200)
    expect(result.find(s => s.key === "overhead")).toBeUndefined()
  })

  it("returns empty array when input is 0 even with server data", () => {
    const sb = makeServerBreakdown({
      messages: [{ role: "user", tokens: 10, cached: 0 }],
    })
    const result = estimateDetailedContextBreakdown({
      messages: emptyMessages, parts: emptyParts, input: 0, serverBreakdown: sb,
    })
    expect(result).toEqual([])
  })

  it("filters out zero-token segments from server data", () => {
    const sb = makeServerBreakdown({
      messages: [
        { role: "user", tokens: 10, cached: 0 },
        { role: "tool", tokens: 0, cached: 0 },
      ],
      template_overhead: 10,
    })
    const result = estimateDetailedContextBreakdown({
      messages: emptyMessages, parts: emptyParts, input: 30, serverBreakdown: sb,
    })
    expect(result.find(s => s.key === "tool_results")).toBeUndefined()
    expect(result).toHaveLength(2) // user_messages + overhead
  })
})

