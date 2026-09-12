import fs from "node:fs"
import path from "node:path"
import { parseRouteTable } from "./resolve-sources"

export const MANAGED_CURSORIGNORE_MARKER = "cookielab-agent-toolkit-instructions"
export const MANAGED_CURSORIGNORE_SYNC_VERSION = 1

const LEGACY_CURSORIGNORE_MARKER = "cookielayer-cursor-instruction-hook"
const MANAGED_MARKERS = [LEGACY_CURSORIGNORE_MARKER, MANAGED_CURSORIGNORE_MARKER]

export const STATIC_SUPPRESS_BASENAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  "PULL_REQUESTS.md",
  "GITHUB_COMMENTS.md",
  "VERIFICATION.md",
  "GIT_WORKTREES.md",
  "PRD_DELIVERY.md",
  "MACOS_CODEX_ENV.md",
] as const

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const MARKER_ALTERNATION = MANAGED_MARKERS.map(escapeRegex).join("|")
const BEGIN_END_RE = new RegExp(`^# (BEGIN|END) (${MARKER_ALTERNATION})(?=[ \t]|$)`, "gm")

function expandUser(value: string) {
  if (value.startsWith("~/")) return path.join(process.env.HOME ?? "", value.slice(2))
  return value
}

export function parseRoutedBasenamesFromAgents(content: string) {
  const basenames = new Set<string>()
  for (const route of parseRouteTable(content)) {
    const basename = path.basename(route.file.trim())
    if (basename.endsWith(".md")) basenames.add(basename)
  }
  return basenames
}

export function suppressPatterns(options?: { globalAgentsPath?: string }) {
  const patterns = new Set<string>()
  for (const basename of STATIC_SUPPRESS_BASENAMES) {
    patterns.add(basename)
    patterns.add(`**/${basename}`)
  }
  const globalPath = options?.globalAgentsPath
    ? path.resolve(expandUser(options.globalAgentsPath))
    : path.join(process.env.HOME ?? "", ".codex", "AGENTS.md")
  try {
    const content = fs.readFileSync(globalPath, "utf-8")
    for (const basename of parseRoutedBasenamesFromAgents(content)) {
      patterns.add(basename)
      patterns.add(`**/${basename}`)
    }
  } catch {
    // static fallback only
  }
  return Array.from(patterns).sort()
}

export function managedCursorignoreBlock(patterns: readonly string[]) {
  const lines = [
    `# BEGIN ${MANAGED_CURSORIGNORE_MARKER} (managed by ./cookielab clients sync)`,
    `# sync_version: ${MANAGED_CURSORIGNORE_SYNC_VERSION}`,
    `# adapter: CAT instruction curation`,
    ...patterns,
    `# END ${MANAGED_CURSORIGNORE_MARKER}`,
  ]
  return lines.join("\n")
}

type MarkerToken = { kind: "begin" | "end"; marker: string; start: number; end: number }

function markerTokens(text: string): MarkerToken[] {
  const tokens: MarkerToken[] = []
  let match: RegExpExecArray | null
  BEGIN_END_RE.lastIndex = 0
  while ((match = BEGIN_END_RE.exec(text)) !== null) {
    tokens.push({
      kind: match[1] === "BEGIN" ? "begin" : "end",
      marker: match[2],
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return tokens
}

function completeSpans(text: string): Array<{ start: number; end: number }> {
  const tokens = markerTokens(text)
  const spans: Array<{ start: number; end: number }> = []
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (token.kind !== "begin") {
      i++
      continue
    }
    let endIdx = -1
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].kind === "end" && tokens[j].marker === token.marker) {
        endIdx = j
        break
      }
    }
    if (endIdx === -1) {
      i++
      continue
    }
    const endToken = tokens[endIdx]
    const after = text.slice(endToken.end)
    const newline = after.match(/^[ \t]*\r?\n/)?.[0] ?? ""
    spans.push({ start: token.start, end: endToken.end + newline.length })
    i = endIdx + 1
  }
  return spans
}

export function readManagedCursorignoreBlock(text: string) {
  const tokens = markerTokens(text)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.kind !== "begin") continue
    let endIdx = -1
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].kind === "end" && tokens[j].marker === token.marker) {
        endIdx = j
        break
      }
    }
    if (endIdx === -1) continue
    const endToken = tokens[endIdx]
    const begin = token.start
    const end = endToken.end
    const block = text.slice(begin, end)
    const patterns = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
    return { block, patterns, begin, end }
  }
  return null
}

function stripManagedBlocks(text: string): string {
  const spans = completeSpans(text)
  if (spans.length === 0) return text
  let out = ""
  let cursor = 0
  for (const span of spans) {
    out += text.slice(cursor, span.start)
    cursor = span.end
  }
  out += text.slice(cursor)
  out = out.replace(/\r?\n/g, "\n")
  out = out.replace(/\n{3,}/g, "\n\n")
  out = out.replace(/^\n+/, "").replace(/\n+$/, "")
  return out ? out + "\n" : ""
}

export function applyManagedCursorignoreBlock(text: string, patterns: readonly string[]) {
  const block = managedCursorignoreBlock(patterns)
  const content = stripManagedBlocks(text).replace(/\s+$/, "")
  if (!content) return `${block}\n`
  return `${content}\n\n${block}\n`
}

export function removeManagedCursorignoreBlock(text: string) {
  return stripManagedBlocks(text)
}
