import type { Part } from "@opencode-ai/sdk/v2"
import { Locale } from "@/util/locale"

type StepFinishPart = Extract<Part, { type: "step-finish" }>

export type PromptTokensDetails = {
  messages?: readonly {
    tokens?: number
    cached?: number
  }[]
  tools?: readonly {
    tokens?: number
  }[]
  agent_instructions?: readonly {
    tokens?: number
    cached?: number
  }[]
  template_overhead?: number
  image_tokens?: number
}

export type EnrichedStepFinishPart = StepFinishPart & {
  promptTokensDetails?: PromptTokensDetails
}

export type ContextTokenDetails = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  cachedPrompt: number
  tools: number
  instructions: number
  overhead: number
  images: number
  hasPromptDetails: boolean
}

export type ContextDetailRow = {
  label: string
  value: string
}

export function latestStepFinish(parts: readonly Part[]) {
  return parts.findLast((part): part is EnrichedStepFinishPart => part.type === "step-finish")
}

export function contextTokenDetails(part: EnrichedStepFinishPart | undefined): ContextTokenDetails | undefined {
  if (!part) return

  const prompt = part.promptTokensDetails
  const cachedMessages = prompt?.messages?.reduce((sum, item) => sum + (item.cached ?? 0), 0) ?? 0
  const cachedInstructions = prompt?.agent_instructions?.reduce((sum, item) => sum + (item.cached ?? 0), 0) ?? 0
  const tools = prompt?.tools?.reduce((sum, item) => sum + (item.tokens ?? 0), 0) ?? 0
  const instructions = prompt?.agent_instructions?.reduce((sum, item) => sum + (item.tokens ?? 0), 0) ?? 0
  const cacheRead = part.tokens.cache.read
  const cacheWrite = part.tokens.cache.write

  return {
    input: part.tokens.input,
    output: part.tokens.output,
    reasoning: part.tokens.reasoning,
    cacheRead,
    cacheWrite,
    total: part.tokens.total ?? part.tokens.input + part.tokens.output + part.tokens.reasoning + cacheRead + cacheWrite,
    cachedPrompt: cachedMessages + cachedInstructions,
    tools,
    instructions,
    overhead: prompt?.template_overhead ?? 0,
    images: prompt?.image_tokens ?? 0,
    hasPromptDetails: prompt !== undefined,
  }
}

export function assistantContextDetailSegments(details: ContextTokenDetails | undefined) {
  if (!details) return []

  const segments = [`input ${Locale.number(details.input)}↑`, `output ${Locale.number(details.output)}↓`]
  if (details.reasoning > 0) segments.push(`reasoning ${Locale.number(details.reasoning)}⊕`)
  if (details.cacheRead > 0 || details.cacheWrite > 0) {
    segments.push(`cache ${Locale.number(details.cacheRead)}/${Locale.number(details.cacheWrite)}`)
  }
  if (details.cachedPrompt > 0) segments.push(`cached ${Locale.number(details.cachedPrompt)}Δ`)
  if (details.tools > 0) segments.push(`tools ${Locale.number(details.tools)}`)
  if (details.instructions > 0) segments.push(`instructions ${Locale.number(details.instructions)}`)
  if (details.overhead > 0) segments.push(`overhead ${Locale.number(details.overhead)}`)
  if (details.images > 0) segments.push(`images ${Locale.number(details.images)}`)
  return segments
}

export function sidebarContextDetailRows(details: ContextTokenDetails | undefined): ContextDetailRow[] {
  if (!details?.hasPromptDetails) return []

  const rows = [
    { label: "input", value: details.input.toLocaleString() },
    { label: "output", value: details.output.toLocaleString() },
  ]
  if (details.reasoning > 0) rows.push({ label: "reasoning", value: details.reasoning.toLocaleString() })
  if (details.cacheRead > 0 || details.cacheWrite > 0) {
    rows.push({
      label: "cache",
      value: `${details.cacheRead.toLocaleString()} / ${details.cacheWrite.toLocaleString()}`,
    })
  }
  if (details.cachedPrompt > 0) rows.push({ label: "cached", value: details.cachedPrompt.toLocaleString() })
  if (details.tools > 0) rows.push({ label: "tools", value: details.tools.toLocaleString() })
  if (details.instructions > 0) rows.push({ label: "instructions", value: details.instructions.toLocaleString() })
  if (details.overhead > 0) rows.push({ label: "overhead", value: details.overhead.toLocaleString() })
  if (details.images > 0) rows.push({ label: "images", value: details.images.toLocaleString() })
  return rows
}
