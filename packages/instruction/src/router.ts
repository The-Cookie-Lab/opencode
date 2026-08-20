import type { Entry, InstructionDomain } from "./parser"

export interface Routed {
  readonly selected: Entry[]
  readonly omitted: Entry[]
  readonly taskDomains: InstructionDomain[]
}

const TASK_KEYWORDS: Array<[InstructionDomain, RegExp]> = [
  ["pr", /\b(pull request|pr\b|review|merge|github comment|review thread|closeout|ci|checks)\b/i],
  ["git", /\b(git|worktree|branch|commit|push|checkout|dirty|default branch)\b/i],
  ["test", /\b(test|tests|unit|coverage|build|typecheck|lint|smoke|gate|verification)\b/i],
  ["prd", /\b(linear|prd|ticket|issue)\b/i],
  ["env", /\b(mac ?os|shell|python|venv|launchctl|mcp|environment|npx)\b/i],
  ["tool", /\b(tool|tools|read tool|write tool|bash|grep|glob|mcp)\b/i],
  ["skill", /\b(skill|skills)\b/i],
  ["opencode", /\b(opencode|agent|agents|instruction|instructions|parser|prompt|session|context)\b/i],
  ["model-server", /\b(model-server|huggingface|openviking|telemetry|processor|local llm)\b/i],
  ["docs", /\b(doc|docs|guide|readme|documentation)\b/i],
]

const DEVELOPMENT_INTENT = /\b(implement|fix|add|remove|rename|refactor|migrate|update|change|configure|wire|develop|deliver|ship)\b/i

function uniqueDomains(domains: Iterable<InstructionDomain>) {
  const seen = new Set<InstructionDomain>()
  for (const domain of domains) seen.add(domain)
  return Array.from(seen)
}

export function normalizeTaskDomains(domains: readonly InstructionDomain[] | undefined): InstructionDomain[] {
  return uniqueDomains(domains ?? [])
}

export function hasDevelopmentIntent(prompt: string | undefined) {
  return Boolean(prompt?.trim() && DEVELOPMENT_INTENT.test(prompt))
}

export function classifyTask(prompt: string | undefined): InstructionDomain[] {
  if (!prompt?.trim()) return []
  const domains: InstructionDomain[] = []
  for (const [domain, pattern] of TASK_KEYWORDS) {
    if (pattern.test(prompt)) domains.push(domain)
  }
  if (hasDevelopmentIntent(prompt)) domains.push("git", "test", "docs")
  return uniqueDomains(domains)
}

export function route(
  entries: Entry[],
  prompt?: string,
  explicitTaskDomains?: readonly InstructionDomain[],
): Routed {
  const taskDomains = explicitTaskDomains === undefined ? classifyTask(prompt) : normalizeTaskDomains(explicitTaskDomains)
  const task = new Set(taskDomains)
  const selected: Entry[] = []
  const omitted: Entry[] = []

  for (const entry of entries) {
    const always = entry.domains.includes("always") || entry.id?.startsWith("USR.") === true
    if (always || entry.domains.some((domain) => task.has(domain))) {
      selected.push(entry)
    } else {
      omitted.push(entry)
    }
  }

  return { selected, omitted, taskDomains }
}

export function countDomains(entries: Entry[]) {
  const counts: Partial<Record<InstructionDomain, number>> = {}
  for (const entry of entries) {
    for (const domain of entry.domains) counts[domain] = (counts[domain] ?? 0) + 1
  }
  return counts
}
