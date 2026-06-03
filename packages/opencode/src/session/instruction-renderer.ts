import { createHash } from "crypto"
import { InstructionParser, type Source } from "./instruction-parser"
import { InstructionReconciler } from "./instruction-reconciler"
import { InstructionRouter } from "./instruction-router"

export type Mode = "raw" | "curated"

export interface RenderOptions {
  readonly mode: Mode
  readonly prompt?: string
}

export interface Rendered {
  readonly blocks: string[]
  readonly telemetry?: Telemetry
}

export interface Telemetry {
  readonly event: "agent_instruction_injection"
  readonly mode: Mode
  readonly taskDomains: string[]
  readonly sourcePaths: string[]
  readonly selectedIds: string[]
  readonly omittedIds: string[]
  readonly omittedDomains: Record<string, number>
  readonly rawTokensEstimate: number
  readonly curatedTokensEstimate: number
  readonly savingsRatio: number
  readonly sameIdOverrides: number
  readonly replacementSuppressions: number
  readonly injectionHash: string
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4)
}

function hash(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

function rawBlocks(sources: Source[]) {
  return sources.flatMap((source) =>
    source.content ? [`Instructions from: ${source.filepath}\n${source.content}`] : [],
  )
}

function compactEntry(entry: InstructionParser.Entry) {
  const source = `source=${entry.filepath}${entry.heading ? ` heading=${JSON.stringify(entry.heading)}` : ""}`
  if (entry.id) return `- [${entry.id}] ${entry.text.replace(/\s+/g, " ")} (${source})`
  return [`From ${entry.filepath}${entry.heading ? ` (${entry.heading})` : ""}:`, entry.text].join("\n")
}

function telemetryBlock(telemetry: Telemetry) {
  return `<agent-instruction-telemetry>${JSON.stringify(telemetry)}</agent-instruction-telemetry>`
}

export function render(sources: Source[], options: RenderOptions): Rendered {
  if (options.mode === "raw") return { blocks: rawBlocks(sources) }

  const parsed = InstructionParser.parse(sources)
  const reconciled = InstructionReconciler.reconcile(parsed.entries)
  const routed = InstructionRouter.route(reconciled.entries, options.prompt)

  const body = [
    '<agent-instructions mode="curated">',
    "Precedence: broad-to-narrow AGENTS guidance, with same-ID narrower entries replacing broader entries.",
    ...routed.selected.map(compactEntry),
  ]
  const omittedDomains = InstructionRouter.countDomains(routed.omitted)
  if (routed.omitted.length > 0) {
    body.push(`Omitted routed domains: ${JSON.stringify(omittedDomains)}`)
  }
  body.push("</agent-instructions>")

  const rawText = rawBlocks(sources).join("\n\n")
  const curatedWithoutTelemetry = body.join("\n")
  const selectedIds = routed.selected.flatMap((entry) => (entry.id ? [entry.id] : []))
  const omittedIds = routed.omitted.flatMap((entry) => (entry.id ? [entry.id] : []))
  const rawTokensEstimate = estimateTokens(rawText)
  const curatedTokensEstimate = estimateTokens(curatedWithoutTelemetry)
  const savingsRatio =
    rawTokensEstimate === 0 ? 0 : Math.max(0, (rawTokensEstimate - curatedTokensEstimate) / rawTokensEstimate)
  const telemetry: Telemetry = {
    event: "agent_instruction_injection",
    mode: "curated",
    taskDomains: routed.taskDomains,
    sourcePaths: sources.map((source) => source.filepath),
    selectedIds,
    omittedIds,
    omittedDomains: omittedDomains as Record<string, number>,
    rawTokensEstimate,
    curatedTokensEstimate,
    savingsRatio,
    sameIdOverrides: reconciled.sameIdOverrides,
    replacementSuppressions: reconciled.replacementSuppressions,
    injectionHash: hash(curatedWithoutTelemetry),
  }

  return { blocks: [[curatedWithoutTelemetry, telemetryBlock(telemetry)].join("\n")], telemetry }
}

export * as InstructionRenderer from "./instruction-renderer"
