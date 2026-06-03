import { describe, expect, it } from "bun:test"
import { Session as SessionNs } from "@/session/session"

// Simulates what the server sends back: an OpenAI-compatible usage object
// enriched by the model-server gateway with prompt_tokens_details.
const SERVER_USAGE_WITH_TOOLS = {
  prompt_tokens: 321,
  completion_tokens: 10,
  total_tokens: 331,
  prompt_tokens_details: {
    messages: [
      { role: "system", tokens: 6, cached: 0 },
      { role: "user", tokens: 2, cached: 0 },
    ],
    tools: [
      { name: "read", tokens: 36 },
      { name: "write", tokens: 45 },
    ],
    agent_instructions: [{ tokens: 22, cached: 0 }],
    template_overhead: 0,
    image_tokens: 0,
  },
}

const SERVER_USAGE_NO_TOOLS = {
  prompt_tokens: 12,
  completion_tokens: 10,
  total_tokens: 22,
  prompt_tokens_details: {
    messages: [{ role: "user", tokens: 2, cached: 0 }],
    tools: [],
    template_overhead: 0,
    image_tokens: 0,
  },
}

const FAKE_MODEL = {
  id: "qwen3.6-27b-unsloth",
  providerID: "openai-compatible",
  name: "Qwen",
  limit: { context: 128_000, output: 8_192 },
  cost: { input: 0, output: 0 },
  capabilities: {
    toolcall: true,
    attachment: false,
    reasoning: true,
    temperature: true,
    input: { text: true, image: false, audio: false, video: false },
    output: { text: true, image: false, audio: false, video: false },
  },
  api: { npm: "@ai-sdk/openai-compatible" },
  options: {},
} as const

describe("getUsage promptTokensDetails integration", () => {
  it("extracts promptTokensDetails from server-enriched usage with tools", () => {
    // Simulate what the protocol's mapUsage does: wrap raw usage in providerMetadata
    const usageObj = {
      inputTokens: SERVER_USAGE_WITH_TOOLS.prompt_tokens,
      outputTokens: SERVER_USAGE_WITH_TOOLS.completion_tokens,
      totalTokens: SERVER_USAGE_WITH_TOOLS.total_tokens,
      providerMetadata: { openai: SERVER_USAGE_WITH_TOOLS },
    }

    // Simulate what the step-finish event carries
    const result = SessionNs.getUsage({
      model: FAKE_MODEL as never,
      usage: usageObj as never,
      metadata: usageObj.providerMetadata as never,
    })

    expect(result.promptTokensDetails).toBeDefined()
    expect(result.promptTokensDetails!.messages).toHaveLength(2)
    expect(result.promptTokensDetails!.tools).toHaveLength(2)
    expect(result.promptTokensDetails!.agent_instructions).toHaveLength(1)
    expect(result.promptTokensDetails!.agent_instructions[0]!.tokens).toBe(22)
    expect(result.promptTokensDetails!.template_overhead).toBe(0)
    expect(result.promptTokensDetails!.image_tokens).toBe(0)
  })

  it("extracts promptTokensDetails from server-enriched usage without tools", () => {
    const usageObj = {
      inputTokens: SERVER_USAGE_NO_TOOLS.prompt_tokens,
      outputTokens: SERVER_USAGE_NO_TOOLS.completion_tokens,
      totalTokens: SERVER_USAGE_NO_TOOLS.total_tokens,
      providerMetadata: { openai: SERVER_USAGE_NO_TOOLS },
    }

    const result = SessionNs.getUsage({
      model: FAKE_MODEL as never,
      usage: usageObj as never,
      metadata: usageObj.providerMetadata as never,
    })

    expect(result.promptTokensDetails).toBeDefined()
    expect(result.promptTokensDetails!.messages).toHaveLength(1)
    expect(result.promptTokensDetails!.tools).toHaveLength(0)
  })

  it("falls back to usage.providerMetadata when metadata is missing", () => {
    const usageObj = {
      inputTokens: SERVER_USAGE_WITH_TOOLS.prompt_tokens,
      outputTokens: SERVER_USAGE_WITH_TOOLS.completion_tokens,
      totalTokens: SERVER_USAGE_WITH_TOOLS.total_tokens,
      providerMetadata: { openai: SERVER_USAGE_WITH_TOOLS },
    }

    // metadata is undefined → should fall back to usage.providerMetadata
    const result = SessionNs.getUsage({
      model: FAKE_MODEL as never,
      usage: usageObj as never,
      metadata: undefined,
    })

    expect(result.promptTokensDetails).toBeDefined()
    expect(result.promptTokensDetails!.messages).toHaveLength(2)
  })

  it("returns undefined promptTokensDetails when no breakdown data exists", () => {
    const usageObj = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      providerMetadata: {
        openai: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          // No prompt_tokens_details at all
        },
      },
    }

    const result = SessionNs.getUsage({
      model: FAKE_MODEL as never,
      usage: usageObj as never,
      metadata: usageObj.providerMetadata as never,
    })

    expect(result.promptTokensDetails).toBeUndefined()
  })

  it("returns undefined when openai providerMetadata is absent", () => {
    const usageObj = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      providerMetadata: { anthropic: {} },
    }

    const result = SessionNs.getUsage({
      model: FAKE_MODEL as never,
      usage: usageObj as never,
      metadata: usageObj.providerMetadata as never,
    })

    expect(result.promptTokensDetails).toBeUndefined()
  })
})
