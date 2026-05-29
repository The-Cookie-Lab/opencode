import type { Message, Part } from "@opencode-ai/sdk/v2/client"

export type SessionContextBreakdownKey = "system" | "user" | "assistant" | "tool" | "other"

export type SessionContextBreakdownSegment = {
  key: SessionContextBreakdownKey
  tokens: number
  width: number
  percent: number
}

export type DetailedBreakdownKey =
  | "system_prompt"
  | "tool_definitions"
  | "user_messages"
  | "assistant_messages"
  | "tool_results"
  | "overhead"

export type DetailedBreakdownSegment = {
  key: DetailedBreakdownKey
  tokens: number
  percent: number
}

const estimateTokens = (chars: number) => Math.ceil(chars / 4)
const toPercent = (tokens: number, input: number) => (tokens / input) * 100
const toPercentLabel = (tokens: number, input: number) => Math.round(toPercent(tokens, input) * 10) / 10

/** Approximate JSON schema character counts for built-in tools.
 *  Used to estimate token consumption of tool definitions sent to the LLM. */
const TOOL_SCHEMA_ESTIMATES: Record<string, number> = {
  shell: 2000,
  bash: 2000,
  read: 900,
  write: 800,
  edit: 1400,
  patch: 1200,
  grep: 1100,
  glob: 700,
  task: 1700,
  webfetch: 900,
  websearch: 900,
  todowrite: 1500,
  question: 1300,
  semanticsearch: 800,
  skill: 600,
  lsp: 1600,
  repoclone: 700,
  repooverview: 600,
  projectdossier: 500,
  viewoutline: 800,
  planexit: 300,
  applypatch: 700,
  invalid: 200,
}
const DEFAULT_SCHEMA_CHARS = 700

const charsFromUserPart = (part: Part) => {
  if (part.type === "text") return part.text.length
  if (part.type === "file") return part.source?.text.value.length ?? 0
  if (part.type === "agent") return part.source?.value.length ?? 0
  return 0
}

const charsFromAssistantPart = (part: Part) => {
  if (part.type === "text") return { assistant: part.text.length, tool: 0 }
  if (part.type === "reasoning") return { assistant: part.text.length, tool: 0 }
  if (part.type !== "tool") return { assistant: 0, tool: 0 }

  const input = Object.keys(part.state.input).length * 16
  if (part.state.status === "pending") return { assistant: 0, tool: input + part.state.raw.length }
  if (part.state.status === "completed") return { assistant: 0, tool: input + part.state.output.length }
  if (part.state.status === "error") return { assistant: 0, tool: input + part.state.error.length }
  return { assistant: 0, tool: input }
}

const build = (
  tokens: { system: number; user: number; assistant: number; tool: number; other: number },
  input: number,
) => {
  return [
    {
      key: "system",
      tokens: tokens.system,
    },
    {
      key: "user",
      tokens: tokens.user,
    },
    {
      key: "assistant",
      tokens: tokens.assistant,
    },
    {
      key: "tool",
      tokens: tokens.tool,
    },
    {
      key: "other",
      tokens: tokens.other,
    },
  ]
    .filter((x) => x.tokens > 0)
    .map((x) => ({
      key: x.key,
      tokens: x.tokens,
      width: toPercent(x.tokens, input),
      percent: toPercentLabel(x.tokens, input),
    })) as SessionContextBreakdownSegment[]
}

export function estimateSessionContextBreakdown(args: {
  messages: Message[]
  parts: Record<string, Part[] | undefined>
  input: number
  systemPrompt?: string
}) {
  if (!args.input) return []

  const counts = args.messages.reduce(
    (acc, msg) => {
      const parts = args.parts[msg.id] ?? []
      if (msg.role === "user") {
        const user = parts.reduce((sum, part) => sum + charsFromUserPart(part), 0)
        return { ...acc, user: acc.user + user }
      }

      if (msg.role !== "assistant") return acc
      const assistant = parts.reduce(
        (sum, part) => {
          const next = charsFromAssistantPart(part)
          return {
            assistant: sum.assistant + next.assistant,
            tool: sum.tool + next.tool,
          }
        },
        { assistant: 0, tool: 0 },
      )
      return {
        ...acc,
        assistant: acc.assistant + assistant.assistant,
        tool: acc.tool + assistant.tool,
      }
    },
    {
      system: args.systemPrompt?.length ?? 0,
      user: 0,
      assistant: 0,
      tool: 0,
    },
  )

  const tokens = {
    system: estimateTokens(counts.system),
    user: estimateTokens(counts.user),
    assistant: estimateTokens(counts.assistant),
    tool: estimateTokens(counts.tool),
  }
  const estimated = tokens.system + tokens.user + tokens.assistant + tokens.tool

  if (estimated <= args.input) {
    return build({ ...tokens, other: args.input - estimated }, args.input)
  }

  const scale = args.input / estimated
  const scaled = {
    system: Math.floor(tokens.system * scale),
    user: Math.floor(tokens.user * scale),
    assistant: Math.floor(tokens.assistant * scale),
    tool: Math.floor(tokens.tool * scale),
  }
  const total = scaled.system + scaled.user + scaled.assistant + scaled.tool
  return build({ ...scaled, other: Math.max(0, args.input - total) }, args.input)
}

export function estimateToolDefinitionTokens(tools: Record<string, boolean> | undefined): number {
  if (!tools) return 0
  let chars = 0
  for (const [name, enabled] of Object.entries(tools)) {
    if (!enabled) continue
    chars += TOOL_SCHEMA_ESTIMATES[name.toLowerCase()] ?? DEFAULT_SCHEMA_CHARS
  }
  return estimateTokens(chars)
}

export function estimateDetailedContextBreakdown(args: {
  messages: Message[]
  parts: Record<string, Part[] | undefined>
  input: number
  systemPrompt?: string
  tools?: Record<string, boolean>
}): DetailedBreakdownSegment[] {
  if (!args.input) return []

  const systemPromptTokens = estimateTokens(args.systemPrompt?.length ?? 0)
  const toolDefTokens = estimateToolDefinitionTokens(args.tools)

  let userChars = 0
  let assistantChars = 0
  let toolResultChars = 0

  for (const msg of args.messages) {
    const parts = args.parts[msg.id] ?? []
    if (msg.role === "user") {
      userChars += parts.reduce((sum, p) => sum + charsFromUserPart(p), 0)
    } else if (msg.role === "assistant") {
      for (const part of parts) {
        const counts = charsFromAssistantPart(part)
        assistantChars += counts.assistant
        toolResultChars += counts.tool
      }
    }
  }

  const userTokens = estimateTokens(userChars)
  const assistantTokens = estimateTokens(assistantChars)
  const toolResultTokens = estimateTokens(toolResultChars)

  const allocated = systemPromptTokens + toolDefTokens + userTokens + assistantTokens + toolResultTokens
  const overhead = Math.max(0, args.input - allocated)

  const segments: DetailedBreakdownSegment[] = ([
    { key: "system_prompt", tokens: systemPromptTokens, percent: toPercentLabel(systemPromptTokens, args.input) },
    { key: "tool_definitions", tokens: toolDefTokens, percent: toPercentLabel(toolDefTokens, args.input) },
    { key: "user_messages", tokens: userTokens, percent: toPercentLabel(userTokens, args.input) },
    { key: "assistant_messages", tokens: assistantTokens, percent: toPercentLabel(assistantTokens, args.input) },
    { key: "tool_results", tokens: toolResultTokens, percent: toPercentLabel(toolResultTokens, args.input) },
    { key: "overhead", tokens: overhead, percent: toPercentLabel(overhead, args.input) },
  ] satisfies DetailedBreakdownSegment[]).filter((s) => s.tokens > 0)

  return segments
}
