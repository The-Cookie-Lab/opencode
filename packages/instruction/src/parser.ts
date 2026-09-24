export type InstructionDomain =
  | "always"
  | "docs"
  | "env"
  | "git"
  | "model-server"
  | "opencode"
  | "pr"
  | "prd"
  | "skill"
  | "test"
  | "tool"

export interface Source {
  readonly filepath: string
  readonly content: string
  readonly order: number
}

export interface Entry {
  readonly id?: string
  readonly prefix?: string
  readonly filepath: string
  readonly sourceOrder: number
  readonly ordinal: number
  readonly heading?: string
  readonly text: string
  readonly domains: InstructionDomain[]
  readonly replacedBy?: string
  readonly structured: boolean
  /**
   * Set when the entry is an ID-targeted `Extend`/`Require`/`Override` directive.
   * `id` is then the targeted rule ID: overrides replace it, extensions add to it.
   */
  readonly directive?: Directive
}

export interface Parsed {
  readonly entries: Entry[]
}

const ID_PATTERN = /\b([A-Z][A-Z0-9]{1,12}(?:\.[A-Z][A-Z0-9_]{1,48}){1,4})\b/g
const REPLACED_BY_PATTERN = /\breplaced_by=([A-Z][A-Z0-9]{1,12}(?:\.[A-Z][A-Z0-9_]{1,48}){1,4})\b/

export type Directive = "extend" | "require" | "override"

const DIRECTIVE_PATTERN =
  /^\s*(?:[-*+]\s+)?(?:\*\*|__)?(Extend|Require|Override)(?:\*\*|__)?\s+`?([A-Z][A-Z0-9]{1,12}(?:\.[A-Z][A-Z0-9_]{1,48}){1,4})\b/

const LIST_ITEM_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+/

const DOMAIN_KEYWORDS: Array<[InstructionDomain, RegExp]> = [
  ["pr", /\b(pull request|pr\b|review|merge|github comment|review-thread|bot-summary)\b/i],
  ["git", /\b(git|worktree|branch|commit|push|checkout|default branch|dirty worktree)\b/i],
  ["test", /\b(test|tests|unit|coverage|build|typecheck|lint|verification|quality gate|green build)\b/i],
  ["prd", /\b(linear|prd|ticket|issue delivery|handoff)\b/i],
  ["env", /\b(mac ?os|shell|python|venv|launchctl|mcp environment|npx)\b/i],
  ["tool", /\b(tool|tools|mcp|read tool|write tool|bash|grep|glob)\b/i],
  ["skill", /\b(skill|skills)\b/i],
  ["opencode", /\b(opencode|agent|agents|instruction|instructions|prompt|session|context)\b/i],
  ["model-server", /\b(model-server|huggingface|openviking|local llm|processor|telemetry)\b/i],
  ["docs", /\b(doc|docs|javadoc|guide|readme|documentation)\b/i],
]

function uniqueDomains(domains: InstructionDomain[]) {
  const seen = new Set<InstructionDomain>()
  for (const domain of domains) seen.add(domain)
  return Array.from(seen)
}

function ids(text: string) {
  return Array.from(text.matchAll(ID_PATTERN), (match) => match[1])
}

function prefix(id: string | undefined) {
  if (!id) return undefined
  return id.split(".")[0]
}

function inferDomains(input: { id?: string; heading?: string; text: string; structured: boolean }) {
  const text = [input.heading ?? "", input.text].join("\n")
  const found: InstructionDomain[] = []
  for (const [domain, pattern] of DOMAIN_KEYWORDS) {
    if (pattern.test(text)) found.push(domain)
  }

  if (input.heading === "Rules") found.push("always")
  const idPrefix = prefix(input.id)
  if (idPrefix === "PR" || idPrefix === "GHC") found.push("pr")
  if (idPrefix === "GIT") found.push("git")
  if (idPrefix === "VER") found.push("test")
  if (idPrefix === "PRD") found.push("prd")
  if (idPrefix === "ENV") found.push("env")
  if (idPrefix === "USR") found.push("always")

  if (found.length === 0) found.push("always")
  return uniqueDomains(found)
}

function cleanHeading(line: string) {
  return line.replace(/^#+\s*/, "").trim()
}

function cleanText(text: string) {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim()
}

export function parse(sources: Source[]): Parsed {
  const entries: Entry[] = []
  let ordinal = 0

  for (const source of sources) {
    let heading: string | undefined
    let paragraph: string[] = []

    const push = (text: string, structured: boolean, id?: string, directive?: Directive) => {
      const cleaned = cleanText(text)
      if (!cleaned) return
      const replacedBy = cleaned.match(REPLACED_BY_PATTERN)?.[1]
      entries.push({
        id,
        prefix: prefix(id),
        filepath: source.filepath,
        sourceOrder: source.order,
        ordinal: ordinal++,
        heading,
        text: cleaned,
        domains: inferDomains({ id, heading, text: cleaned, structured }),
        replacedBy,
        directive,
        structured,
      })
    }

    const flush = () => {
      if (paragraph.length === 0) return
      push(paragraph.join("\n"), false)
      paragraph = []
    }

    // A structured list item owns its indented continuation lines (including
    // blank-separated indented blocks), so a wrapped rule stays whole and a
    // continuation line is never keyed by an ID it merely mentions. Nested list
    // items that carry their own ID still start a new entry.
    let item: { lines: string[]; id: string; directive?: Directive } | undefined
    const flushItem = () => {
      if (!item) return
      push(item.lines.join("\n"), true, item.id, item.directive)
      item = undefined
    }
    const continuesItem = (line: string) => {
      if (line.trim() === "") return true
      if (!/^\s+\S/.test(line)) return false
      return !(LIST_ITEM_PATTERN.test(line) && ids(line).length > 0)
    }

    for (const line of source.content.split(/\r?\n/)) {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
      if (headingMatch) {
        flushItem()
        flush()
        heading = cleanHeading(line)
        continue
      }

      if (item && continuesItem(line)) {
        item.lines.push(line)
        continue
      }
      flushItem()

      const found = ids(line)
      if (found.length > 0) {
        flush()
        const directive = line.match(DIRECTIVE_PATTERN)
        const id = directive?.[2] ?? found[0]
        const kind = directive ? (directive[1].toLowerCase() as Directive) : undefined
        if (LIST_ITEM_PATTERN.test(line)) item = { lines: [line], id, directive: kind }
        else push(line, true, id, kind)
        continue
      }

      if (line.trim() === "") {
        flush()
        continue
      }
      paragraph.push(line)
    }
    flushItem()
    flush()
  }

  return { entries }
}
