import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { ContextPlan } from "../session/context-planner"

const MACRO_TOOLS = new Set(["project_dossier", "view_outline", "semantic_search"])
const PRIMITIVE_DISCOVERY_TOOLS = new Set(["read", "grep", "glob", "rg"])
const MUTATION_TOOLS = new Set(["edit", "write", "apply_patch", "write_patch"])
const TEST_COMMAND_PATTERNS = [
  /\bbun\s+test\b/,
  /\bnpm\s+test\b/,
  /\bpnpm\s+test\b/,
  /\byarn\s+test\b/,
  /\bmvn\s+test\b/,
  /\bpytest\b/,
]

type PromptTokensDetails = NonNullable<SessionV1.StepFinishPart["promptTokensDetails"]>

export type TurnSample = {
  sessionID: string
  messageID: string
  previousMessageID?: string
  macroUsed: boolean
  macroFirst: boolean
  primitiveDiscoveryCount: number
  readCount: number
  grepCount: number
  semanticColdFallback: boolean
  semanticWarmIndex: boolean
  timeToFirstEditMs?: number
  timeToFirstTestMs?: number
  prompt?: PromptTokensDetails
  promptTokens: number
  assistantTokens: number
  contextPlan?: ContextPlan
  droppedPaths: string[]
  observedPaths: string[]
}

export type ContextIntelligenceReport = {
  turns: number
  macroTurns: number
  macroAdoptionRate: number
  macroFirstRate: number
  primitiveDiscoveryAvg: number
  controlPrimitiveDiscoveryAvg: number
  macroPrimitiveDiscoveryAvg: number
  readGrepReductionRate: number
  semanticColdFallbackRate: number
  semanticWarmIndexRate: number
  medianTimeToFirstEditMs?: number
  medianTimeToFirstTestMs?: number
  promptPressure: {
    input: number
    cached: number
    tools: number
    template: number
    image: number
    assistantFallback: number
  }
  shadow: {
    candidateCount: number
    averageRatio: number
    projectedSavingsTokens: number
    largestPressureSources: Array<{ source: string; tokens: number }>
    rereadAfterDropCount: number
    overflowProximityCount: number
    recommendedThreshold: number
  }
  dataGaps: string[]
}

export function collectTurnSample(input: {
  message: SessionV1.WithParts
  previous?: SessionV1.WithParts
}): TurnSample | undefined {
  if (input.message.info.role !== "assistant") return undefined
  const toolParts = input.message.parts.filter((part): part is SessionV1.ToolPart => part.type === "tool")
  const discoveryTools = toolParts.filter(
    (part) => MACRO_TOOLS.has(part.tool) || PRIMITIVE_DISCOVERY_TOOLS.has(part.tool),
  )
  const prompt = input.message.parts.find(
    (part): part is SessionV1.StepFinishPart =>
      part.type === "step-finish" && part.promptTokensDetails !== undefined,
  )?.promptTokensDetails
  const contextPlan = input.message.parts
    .filter((part): part is SessionV1.StepStartPart => part.type === "step-start")
    .map((part) => contextPlanFromMetadata(part.metadata))
    .find((plan): plan is ContextPlan => plan !== undefined)
  const telemetry = toolParts.map((part) => telemetryFromTool(part)).find((item) => item !== undefined)
  const firstEdit = firstToolStart(input.message, (part) => MUTATION_TOOLS.has(part.tool))
  const firstTest = firstToolStart(input.message, isTestTool)
  const baseline = input.previous?.info.time.created ?? input.message.info.time.created
  const observedPaths = toolParts.flatMap((part) =>
    PRIMITIVE_DISCOVERY_TOOLS.has(part.tool) || MACRO_TOOLS.has(part.tool) ? (pathFromTool(part) ?? []) : [],
  )
  return {
    sessionID: input.message.info.sessionID,
    messageID: input.message.info.id,
    previousMessageID: input.previous?.info.id,
    macroUsed: toolParts.some((part) => MACRO_TOOLS.has(part.tool)),
    macroFirst: MACRO_TOOLS.has(discoveryTools[0]?.tool ?? ""),
    primitiveDiscoveryCount: toolParts.filter((part) => PRIMITIVE_DISCOVERY_TOOLS.has(part.tool)).length,
    readCount: toolParts.filter((part) => part.tool === "read").length,
    grepCount: toolParts.filter((part) => part.tool === "grep" || part.tool === "rg").length,
    semanticColdFallback: toolParts.some(isSemanticColdFallback),
    semanticWarmIndex: toolParts.some(isSemanticWarmIndex),
    timeToFirstEditMs: telemetry?.time_to_first_edit_ms ?? elapsed(firstEdit, baseline),
    timeToFirstTestMs: telemetry?.time_to_first_test_ms ?? elapsed(firstTest, baseline),
    prompt,
    promptTokens: prompt ? promptTotal(prompt) : 0,
    assistantTokens: tokenTotal(input.message.info.tokens),
    contextPlan,
    droppedPaths:
      contextPlan?.ledger
        .filter((item) => item.action === "drop" && item.source.path)
        .map((item) => item.source.path!) ?? [],
    observedPaths,
  }
}

export function aggregateContextIntelligence(samples: TurnSample[]): ContextIntelligenceReport {
  const macroSamples = samples.filter((sample) => sample.macroUsed)
  const controlSamples = samples.filter((sample) => !sample.macroUsed)
  const pressureSources = pressureBySource(samples)
  const ratios = samples.flatMap((sample) => sample.contextPlan?.ratio ?? [])
  const shadowCandidates = samples.filter((sample) => sample.contextPlan?.decision === "shadow")
  return {
    turns: samples.length,
    macroTurns: macroSamples.length,
    macroAdoptionRate: rate(macroSamples.length, samples.length),
    macroFirstRate: rate(samples.filter((sample) => sample.macroFirst).length, macroSamples.length),
    primitiveDiscoveryAvg: average(samples.map((sample) => sample.primitiveDiscoveryCount)),
    controlPrimitiveDiscoveryAvg: average(controlSamples.map((sample) => sample.primitiveDiscoveryCount)),
    macroPrimitiveDiscoveryAvg: average(macroSamples.map((sample) => sample.primitiveDiscoveryCount)),
    readGrepReductionRate: reduction(
      controlSamples.map((sample) => sample.readCount + sample.grepCount),
      macroSamples.map((sample) => sample.readCount + sample.grepCount),
    ),
    semanticColdFallbackRate: rate(samples.filter((sample) => sample.semanticColdFallback).length, samples.length),
    semanticWarmIndexRate: rate(samples.filter((sample) => sample.semanticWarmIndex).length, samples.length),
    medianTimeToFirstEditMs: median(samples.flatMap((sample) => sample.timeToFirstEditMs ?? [])),
    medianTimeToFirstTestMs: median(samples.flatMap((sample) => sample.timeToFirstTestMs ?? [])),
    promptPressure: {
      input: samples.reduce(
        (total, sample) => total + (sample.prompt?.messages.reduce((sum, item) => sum + item.tokens, 0) ?? 0),
        0,
      ),
      cached: samples.reduce(
        (total, sample) =>
          total +
          (sample.prompt?.messages.reduce((sum, item) => sum + (item.cached ?? 0), 0) ?? 0) +
          (sample.prompt?.agent_instructions?.reduce((sum, item) => sum + (item.cached ?? 0), 0) ?? 0),
        0,
      ),
      tools: samples.reduce(
        (total, sample) => total + (sample.prompt?.tools.reduce((sum, item) => sum + item.tokens, 0) ?? 0),
        0,
      ),
      template: samples.reduce((total, sample) => total + (sample.prompt?.template_overhead ?? 0), 0),
      image: samples.reduce((total, sample) => total + (sample.prompt?.image_tokens ?? 0), 0),
      assistantFallback: samples.reduce((total, sample) => total + (sample.prompt ? 0 : sample.assistantTokens), 0),
    },
    shadow: {
      candidateCount: shadowCandidates.length,
      averageRatio: round(average(ratios)),
      projectedSavingsTokens: samples.reduce(
        (total, sample) => total + (sample.contextPlan?.projectedSavingsTokens ?? 0),
        0,
      ),
      largestPressureSources: Object.entries(pressureSources)
        .map(([source, tokens]) => ({ source, tokens }))
        .toSorted((a, b) => b.tokens - a.tokens || a.source.localeCompare(b.source))
        .slice(0, 5),
      rereadAfterDropCount: rereadAfterDrop(samples),
      overflowProximityCount: samples.filter((sample) => (sample.contextPlan?.ratio ?? 0) >= 0.85).length,
      recommendedThreshold: recommendedThreshold(ratios),
    },
    dataGaps: dataGaps(samples),
  }
}

export function renderContextIntelligenceSummary(report: ContextIntelligenceReport): string {
  const lines = [
    "CONTEXT INTELLIGENCE BURN-IN",
    `Turns sampled: ${report.turns}`,
    `Macro adoption: ${percent(report.macroAdoptionRate)} (${report.macroTurns}/${report.turns})`,
    `Macro-first rate: ${percent(report.macroFirstRate)}`,
    `Primitive discovery avg: ${format(report.primitiveDiscoveryAvg)} (macro ${format(report.macroPrimitiveDiscoveryAvg)}, control ${format(report.controlPrimitiveDiscoveryAvg)})`,
    `Read/grep reduction: ${percent(report.readGrepReductionRate)}`,
    `Semantic cold fallback: ${percent(report.semanticColdFallbackRate)}; warm index: ${percent(report.semanticWarmIndexRate)}`,
    `Median time to first edit/test: ${duration(report.medianTimeToFirstEditMs)} / ${duration(report.medianTimeToFirstTestMs)}`,
    `Prompt pressure: input ${tokens(report.promptPressure.input)}, cached ${tokens(report.promptPressure.cached)}, tools ${tokens(report.promptPressure.tools)}, template ${tokens(report.promptPressure.template)}, images ${tokens(report.promptPressure.image)}, fallback ${tokens(report.promptPressure.assistantFallback)}`,
    `Shadow candidates: ${report.shadow.candidateCount}; avg ratio ${format(report.shadow.averageRatio)}; projected savings ${tokens(report.shadow.projectedSavingsTokens)}`,
    `Overflow proximity: ${report.shadow.overflowProximityCount}; re-read-after-drop proxy: ${report.shadow.rereadAfterDropCount}`,
    `Recommended threshold: ${format(report.shadow.recommendedThreshold)}`,
    `Largest pressure sources: ${report.shadow.largestPressureSources.length ? report.shadow.largestPressureSources.map((item) => `${item.source} ${tokens(item.tokens)}`).join(", ") : "none"}`,
    `Data gaps: ${report.dataGaps.length ? report.dataGaps.join(", ") : "none"}`,
  ]
  return lines.join("\n")
}

function contextPlanFromMetadata(metadata: Record<string, unknown> | undefined) {
  const plan = metadata?.contextPlan
  if (!plan || typeof plan !== "object") return undefined
  const candidate = plan as Partial<ContextPlan>
  if (candidate.mode !== "shadow") return undefined
  if (candidate.decision !== "none" && candidate.decision !== "shadow") return undefined
  if (typeof candidate.ratio !== "number" || typeof candidate.threshold !== "number") return undefined
  return candidate as ContextPlan
}

function telemetryFromTool(part: SessionV1.ToolPart) {
  const metadata = part.state.status === "completed" ? part.state.metadata.telemetry : undefined
  if (!metadata || typeof metadata !== "object") return undefined
  const value = metadata as Record<string, unknown>
  return {
    time_to_first_edit_ms: numberField(value, "time_to_first_edit_ms"),
    time_to_first_test_ms: numberField(value, "time_to_first_test_ms"),
  }
}

function numberField(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function firstToolStart(message: SessionV1.WithParts, predicate: (part: SessionV1.ToolPart) => boolean) {
  return message.parts
    .filter((part): part is SessionV1.ToolPart => part.type === "tool" && predicate(part))
    .flatMap((part) =>
      part.state.status === "completed" || part.state.status === "running" || part.state.status === "error"
        ? [part.state.time.start]
        : [],
    )
    .toSorted((a, b) => a - b)[0]
}

function isTestTool(part: SessionV1.ToolPart) {
  if (part.tool !== "bash" && part.tool !== "shell") return false
  const command = stringField(part.state.input, "command") ?? stringField(part.state.input, "cmd") ?? ""
  return TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
}

function isSemanticColdFallback(part: SessionV1.ToolPart) {
  if (part.tool !== "semantic_search" || part.state.status !== "completed") return false
  return (
    part.state.metadata.mode === "lexical" &&
    part.state.metadata.indexed === false &&
    part.state.metadata.scheduled === true
  )
}

function isSemanticWarmIndex(part: SessionV1.ToolPart) {
  if (part.tool !== "semantic_search" || part.state.status !== "completed") return false
  return part.state.metadata.mode === "semantic" || part.state.metadata.indexed === true
}

function pathFromTool(part: SessionV1.ToolPart) {
  if (part.state.status === "pending")
    return stringField(part.state.input, "filePath") ?? stringField(part.state.input, "path")
  return (
    stringField(part.state.input, "filePath") ??
    stringField(part.state.input, "path") ??
    stringField(part.state.metadata, "path") ??
    stringField(part.state.metadata, "cwd")
  )
}

function stringField(input: Record<string, unknown> | undefined, key: string) {
  const value = input?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function elapsed(time: number | undefined, baseline: number) {
  if (time === undefined || baseline === undefined) return undefined
  return Math.max(0, time - baseline)
}

function promptTotal(prompt: PromptTokensDetails) {
  return (
    prompt.messages.reduce((total, item) => total + item.tokens, 0) +
    prompt.tools.reduce((total, item) => total + item.tokens, 0) +
    (prompt.agent_instructions?.reduce((total, item) => total + item.tokens, 0) ?? 0) +
    prompt.template_overhead +
    prompt.image_tokens
  )
}

function tokenTotal(tokensInput: SessionV1.Assistant["tokens"] | undefined) {
  if (!tokensInput) return 0
  return (
    tokensInput.total ??
    tokensInput.input + tokensInput.output + tokensInput.reasoning + tokensInput.cache.read + tokensInput.cache.write
  )
}

function pressureBySource(samples: TurnSample[]) {
  const result: Record<string, number> = {}
  for (const sample of samples) {
    for (const item of sample.contextPlan?.ledger ?? []) {
      const key = item.kind === "file_observation" && item.source.path ? item.source.path : item.kind
      result[key] = (result[key] ?? 0) + item.tokens
    }
  }
  return result
}

function rereadAfterDrop(samples: TurnSample[]) {
  const dropped = new Set<string>()
  let count = 0
  for (const sample of samples) {
    for (const path of sample.observedPaths) {
      if (dropped.has(path)) count++
    }
    for (const path of sample.droppedPaths) dropped.add(path)
  }
  return count
}

function dataGaps(samples: TurnSample[]) {
  const gaps: string[] = []
  if (samples.some((sample) => !sample.prompt)) gaps.push("promptTokensDetails")
  if (samples.some((sample) => !sample.contextPlan)) gaps.push("contextPlan")
  return gaps
}

function recommendedThreshold(ratios: number[]) {
  if (ratios.length === 0) return 0.6
  return Math.min(0.7, Math.max(0.45, round(median(ratios) ?? 0.6)))
}

function reduction(control: number[], macro: number[]) {
  const controlAvg = average(control)
  if (controlAvg === 0) return 0
  return Math.max(0, (controlAvg - average(macro)) / controlAvg)
}

function median(values: number[]) {
  if (values.length === 0) return undefined
  const sorted = values.toSorted((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function average(values: number[]) {
  if (values.length === 0) return 0
  return values.reduce((total, value) => total + value, 0) / values.length
}

function rate(count: number, total: number) {
  if (total === 0) return 0
  return count / total
}

function round(value: number) {
  return Math.round(value * 1_000) / 1_000
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`
}

function format(value: number) {
  return value.toFixed(2)
}

function duration(value: number | undefined) {
  return value === undefined ? "n/a" : `${Math.round(value)}ms`
}

function tokens(value: number) {
  return Math.round(value).toLocaleString()
}
