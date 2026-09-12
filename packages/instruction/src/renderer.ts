import { createHash } from "node:crypto"
import { parse, type Entry, type InstructionDomain, type Source } from "./parser"
import { reconcile } from "./reconciler"
import { countDomains, route } from "./router"

export type Mode = "raw" | "curated"

export interface RenderOptions {
  readonly mode: Mode
  readonly prompt?: string
  readonly taskDomains?: readonly InstructionDomain[]
  readonly excludedHeadings?: readonly string[]
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
  readonly selectedCount: number
  readonly omittedCount: number
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function normalizedHeading(value: string) {
  return value.replace(/^#+\s*/, "").trim().toLowerCase()
}

function compactStructuredEntry(entry: Entry) {
  let body = entry.text.trim().replace(/^\s*[-*+]\s+/, "").trimStart()
  if (entry.id) {
    const markers = [entry.id, `\`${entry.id}\``, `**${entry.id}**`]
    const marker = markers.find((candidate) => body.startsWith(candidate))
    if (marker) {
      body = body.slice(marker.length).replace(/^\s*[:.\-–—]\s*/, "")
    } else {
      const duplicate = new RegExp(`^${escapeRegExp(entry.id)}\\b\\s*[:.\\-–—]?\\s*`)
      body = body.replace(duplicate, "")
    }
    return `[${entry.id}]${body ? ` ${body}` : ""}`
  }
  return body
}

function compactEntries(entries: Entry[]) {
  const rendered: string[] = []
  const emittedHeadings = new Set<string>()
  for (const entry of entries) {
    if (entry.structured) {
      rendered.push(compactStructuredEntry(entry))
      continue
    }
    if (entry.heading) {
      const headingKey = `${entry.filepath}\u0000${entry.heading}`
      if (!emittedHeadings.has(headingKey)) {
        emittedHeadings.add(headingKey)
        rendered.push(`## ${entry.heading}`)
      }
    }
    rendered.push(entry.text)
  }
  return rendered
}

function selectedEntries(entries: Entry[], excludedHeadings: readonly string[]) {
  const excluded = new Set(excludedHeadings.map(normalizedHeading))
  return entries.filter((entry) => !entry.heading || !excluded.has(normalizedHeading(entry.heading)))
}

export function render(sources: Source[], options: RenderOptions): Rendered {
  if (options.mode === "raw") return { blocks: rawBlocks(sources) }

  const parsed = parse(sources)
  const reconciled = reconcile(parsed.entries)
  const routed = route(reconciled.entries, options.prompt, options.taskDomains)
  const selected = selectedEntries(routed.selected, [
    "Context Routes",
    "Context-Routed Files",
    "Root File Routing",
    ...(options.excludedHeadings ?? []),
  ])
  const excluded = routed.selected.filter((entry) => !selected.includes(entry))
  const omitted = [...routed.omitted, ...excluded]
  const lines = compactEntries(selected)
  const curatedWithoutTelemetry =
    selected.length === 0
      ? ""
      : [
          '<agent-instructions mode="curated">',
          "Precedence: broad-to-narrow AGENTS guidance, with same-ID narrower entries replacing broader entries.",
          ...lines,
          "</agent-instructions>",
        ].join("\n")
  const rawText = rawBlocks(sources).join("\n\n")
  const selectedIds = selected.flatMap((entry) => (entry.id ? [entry.id] : []))
  const omittedIds = omitted.flatMap((entry) => (entry.id ? [entry.id] : []))
  const omittedDomains = countDomains(omitted)
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
    selectedCount: selected.length,
    omittedCount: omitted.length,
    omittedDomains: omittedDomains as Record<string, number>,
    rawTokensEstimate,
    curatedTokensEstimate,
    savingsRatio,
    sameIdOverrides: reconciled.sameIdOverrides,
    replacementSuppressions: reconciled.replacementSuppressions,
    injectionHash: hash(curatedWithoutTelemetry),
  }

  return { blocks: curatedWithoutTelemetry ? [curatedWithoutTelemetry] : [], telemetry }
}
