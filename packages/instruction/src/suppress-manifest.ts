import fs from "node:fs"
import path from "node:path"

export const MANAGED_CURSORIGNORE_MARKER = "cookielayer-cursor-instruction-hook"
export const MANAGED_CURSORIGNORE_SYNC_VERSION = 1

export const STATIC_SUPPRESS_BASENAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  "PULL_REQUESTS.md",
  "GITHUB_COMMENTS.md",
  "VERIFICATION.md",
  "GIT_WORKTREES.md",
  "PRD_DELIVERY.md",
  "MACOS_CODEX_ENV.md",
  "SDL_MCP.md",
] as const

const ROUTE_TABLE_RE = /^\|\s*`([^`]+)`\s*\|/

function expandUser(value: string) {
  if (value.startsWith("~/")) return path.join(process.env.HOME ?? "", value.slice(2))
  return value
}

export function parseRoutedBasenamesFromAgents(content: string) {
  const basenames = new Set<string>()
  let inRouteTable = false
  for (const line of content.split(/\r?\n/)) {
    if (line.includes("## Context-Routed Files")) {
      inRouteTable = true
      continue
    }
    if (inRouteTable && line.startsWith("## ")) break
    if (!inRouteTable) continue
    const match = line.match(ROUTE_TABLE_RE)
    if (!match) continue
    const basename = path.basename(match[1].trim())
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
    `# BEGIN ${MANAGED_CURSORIGNORE_MARKER} (managed by model-server sync — do not edit manually)`,
    `# sync_version: ${MANAGED_CURSORIGNORE_SYNC_VERSION}`,
    `# hook: cookielayer-instruction`,
    ...patterns,
    `# END ${MANAGED_CURSORIGNORE_MARKER}`,
  ]
  return lines.join("\n")
}

const BEGIN_RE = new RegExp(`^# BEGIN ${MANAGED_CURSORIGNORE_MARKER}`, "m")
const END_RE = new RegExp(`^# END ${MANAGED_CURSORIGNORE_MARKER}`, "m")

export function readManagedCursorignoreBlock(text: string) {
  const begin = text.search(BEGIN_RE)
  if (begin < 0) return null
  const endMatch = text.slice(begin).match(END_RE)
  if (!endMatch || endMatch.index === undefined) return null
  const end = begin + endMatch.index + endMatch[0].length
  const block = text.slice(begin, end)
  const patterns = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
  return { block, patterns, begin, end }
}

export function applyManagedCursorignoreBlock(text: string, patterns: readonly string[]) {
  const block = managedCursorignoreBlock(patterns)
  const existing = readManagedCursorignoreBlock(text)
  if (!existing) {
    const trimmed = text.replace(/\s+$/, "")
    if (!trimmed) return `${block}\n`
    return `${trimmed}\n\n${block}\n`
  }
  return `${text.slice(0, existing.begin)}${block}\n${text.slice(existing.end).replace(/^\n?/, "")}`
}

export function removeManagedCursorignoreBlock(text: string) {
  const existing = readManagedCursorignoreBlock(text)
  if (!existing) return text
  const before = text.slice(0, existing.begin).replace(/\n+$/, "")
  const after = text.slice(existing.end).replace(/^\n+/, "")
  if (!before && !after) return ""
  if (!before) return after ? `${after}\n` : ""
  if (!after) return `${before}\n`
  return `${before}\n\n${after}\n`
}

