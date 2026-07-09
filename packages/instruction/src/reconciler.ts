import type { Entry } from "./parser"

export interface Result {
  readonly entries: Entry[]
  readonly sameIdOverrides: number
  readonly replacementSuppressions: number
}

export function reconcile(entries: Entry[]): Result {
  const structured = new Map<string, Entry>()
  const unstructured: Entry[] = []
  let sameIdOverrides = 0

  for (const entry of entries) {
    if (!entry.id) {
      unstructured.push(entry)
      continue
    }
    if (structured.has(entry.id)) sameIdOverrides++
    structured.set(entry.id, entry)
  }

  let replacementSuppressions = 0
  for (const entry of Array.from(structured.values())) {
    if (!entry.id || !entry.replacedBy) continue
    if (!structured.has(entry.replacedBy)) continue
    structured.delete(entry.id)
    replacementSuppressions++
  }

  return {
    entries: [...unstructured, ...structured.values()].sort(
      (a, b) => a.sourceOrder - b.sourceOrder || a.ordinal - b.ordinal,
    ),
    sameIdOverrides,
    replacementSuppressions,
  }
}
