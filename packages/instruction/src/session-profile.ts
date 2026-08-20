import { createHash } from "node:crypto"
import type { InstructionDomain, Source } from "./parser"
import { render, type Mode, type Telemetry } from "./renderer"

export interface SessionSource {
  readonly filepath: string
  readonly content: string
  readonly sha256: string
  readonly order?: number
}

export interface SessionProfile {
  readonly mode: Mode
  readonly profileHash: string
  readonly sourcePaths: string[]
  readonly selectedIds: string[]
  readonly sources: SessionSource[]
  readonly injectionHash?: string
}

export interface DeltaRenderResult {
  readonly update: "snapshot" | "delta" | ""
  readonly blocks: string[]
  readonly profile: SessionProfile
  readonly telemetry?: Telemetry
}

function sha256Text(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

export function profileHash(sources: readonly SessionSource[], selectedIds: readonly string[] = []) {
  const payload = {
    source_hashes: sources.map((source) => [source.filepath, source.sha256]),
    selected_ids: [...selectedIds].sort(),
  }
  return sha256Text(JSON.stringify(payload)).slice(0, 16)
}

export function sourcesToSession(sources: readonly Source[]): SessionSource[] {
  return sources.map((source, order) => ({
    filepath: source.filepath,
    content: source.content,
    sha256: sha256Text(source.content),
    order: source.order ?? order,
  }))
}

export function mergeSessionSources(
  previous: readonly SessionSource[] | undefined,
  current: readonly SessionSource[],
): SessionSource[] {
  const merged = [...(previous ?? [])]
  const indexes = new Map(merged.map((source, index) => [source.filepath, index]))
  for (const source of current) {
    const index = indexes.get(source.filepath)
    if (index === undefined) {
      indexes.set(source.filepath, merged.length)
      merged.push(source)
    } else if (merged[index]?.sha256 !== source.sha256) {
      merged[index] = source
    }
  }
  return merged
}

function wrapCurated(body: string, update: "snapshot" | "delta", profileHashValue: string) {
  return [
    `<agent-instructions mode="curated" update="${update}" profile_hash="${profileHashValue}">`,
    body.replace(/^<agent-instructions mode="curated">\n?/, "").replace(/\n?<\/agent-instructions>\s*$/, ""),
    `</agent-instructions>`,
  ].join("\n")
}

/**
 * Render curated instructions as a full snapshot or additive delta vs a previous profile.
 * Empty update means the profile hash is unchanged and no injection is needed.
 */
export function renderWithDelta(options: {
  readonly sources: readonly Source[]
  readonly mode?: Mode
  readonly prompt?: string
  readonly taskDomains?: readonly InstructionDomain[]
  readonly excludedHeadings?: readonly string[]
  readonly previous?: SessionProfile | null
  readonly delta?: boolean
}): DeltaRenderResult {
  const mode = options.mode ?? "curated"
  const rendered = render([...options.sources], {
    mode,
    prompt: options.prompt,
    taskDomains: options.taskDomains,
    excludedHeadings: options.excludedHeadings,
  })
  const sessionSources = sourcesToSession(options.sources)
  const selectedIds = rendered.telemetry?.selectedIds ?? []
  const currentHash = profileHash(sessionSources, selectedIds)
  const profile: SessionProfile = {
    mode,
    profileHash: currentHash,
    sourcePaths: sessionSources.map((source) => source.filepath),
    selectedIds,
    sources: sessionSources,
    injectionHash: rendered.telemetry?.injectionHash,
  }

  if (!options.delta) {
    return {
      update: "snapshot",
      blocks: rendered.blocks,
      profile,
      telemetry: rendered.telemetry,
    }
  }

  const previous = options.previous
  if (previous && previous.profileHash === currentHash) {
    return { update: "", blocks: [], profile, telemetry: rendered.telemetry }
  }

  if (!previous) {
    const blocks = rendered.blocks.map((block) =>
      mode === "curated" && block.includes("<agent-instructions")
        ? wrapCurated(block, "snapshot", currentHash)
        : block,
    )
    return { update: "snapshot", blocks, profile, telemetry: rendered.telemetry }
  }

  const previousPaths = new Set(previous.sourcePaths)
  const newSources = options.sources.filter((source) => !previousPaths.has(source.filepath))
  if (newSources.length === 0) {
    // Hash changed without new paths (content edit) — emit snapshot of current turn sources.
    const blocks = rendered.blocks.map((block) =>
      mode === "curated" && block.includes("<agent-instructions")
        ? wrapCurated(block, "snapshot", currentHash)
        : block,
    )
    return { update: "snapshot", blocks, profile, telemetry: rendered.telemetry }
  }

  const deltaRendered = render([...newSources], { mode, prompt: options.prompt })
  const blocks = deltaRendered.blocks.map((block) =>
    mode === "curated" && block.includes("<agent-instructions")
      ? wrapCurated(block, "delta", currentHash)
      : block,
  )
  return {
    update: "delta",
    blocks,
    profile: {
      ...profile,
      // Session accumulates; caller should merge for persistence.
      sources: mergeSessionSources(previous.sources, sessionSources),
      profileHash: profileHash(mergeSessionSources(previous.sources, sessionSources), selectedIds),
      sourcePaths: mergeSessionSources(previous.sources, sessionSources).map((source) => source.filepath),
    },
    telemetry: deltaRendered.telemetry,
  }
}
