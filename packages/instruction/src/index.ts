export type { Entry, InstructionDomain, Parsed, Source } from "./parser"
export { parse } from "./parser"
export type { Result as ReconcileResult } from "./reconciler"
export { reconcile } from "./reconciler"
export type { Routed } from "./router"
export { classifyTask, countDomains, route } from "./router"
export type { Mode, RenderOptions, Rendered, Telemetry } from "./renderer"
export { render } from "./renderer"
export type { ResolveOptions, ResolveResult, ResolvedSourceMeta } from "./resolve-sources"
export {
  parseAlwaysLoaded,
  parseRouteTable,
  resolveSourcePaths,
  resolveSources,
  resolveSourcesDetailed,
  routeApplies,
} from "./resolve-sources"
export type { DeltaRenderResult, SessionProfile, SessionSource } from "./session-profile"
export {
  mergeSessionSources,
  profileHash,
  renderWithDelta,
  sourcesToSession,
} from "./session-profile"
export {
  MANAGED_CURSORIGNORE_MARKER,
  MANAGED_CURSORIGNORE_SYNC_VERSION,
  STATIC_SUPPRESS_BASENAMES,
  applyManagedCursorignoreBlock,
  managedCursorignoreBlock,
  parseRoutedBasenamesFromAgents,
  readManagedCursorignoreBlock,
  removeManagedCursorignoreBlock,
  suppressPatterns,
} from "./suppress-manifest"

import type { Mode } from "./renderer"
import type { Source } from "./parser"
import { parse } from "./parser"
import { reconcile } from "./reconciler"
import { classifyTask, countDomains, route } from "./router"
import { render } from "./renderer"
import { resolveSources } from "./resolve-sources"
import { renderWithDelta, type SessionProfile } from "./session-profile"

export const InstructionParser = { parse }
export const InstructionReconciler = { reconcile }
export const InstructionRouter = { classifyTask, countDomains, route }
export const InstructionRenderer = { render }

export interface RenderRequest {
  readonly mode?: Mode
  readonly cwd: string
  readonly prompt?: string
  readonly event?: string
  readonly toolName?: string
  readonly toolContext?: string
  readonly targetPaths?: readonly string[]
  readonly globalAgentsPaths?: readonly string[]
  readonly codexHome?: string
  readonly client?: string
  readonly sources?: readonly Source[]
  readonly delta?: boolean
  readonly previousProfile?: SessionProfile | null
  readonly useCodexRouting?: boolean
}

export interface RenderResponse {
  readonly blocks: string[]
  readonly telemetry?: ReturnType<typeof render>["telemetry"]
  readonly source_paths: string[]
  readonly update?: "snapshot" | "delta" | ""
  readonly profile?: SessionProfile
}

export function renderInstructionRequest(request: RenderRequest): RenderResponse {
  const sources =
    request.sources && request.sources.length > 0
      ? request.sources.map((source, order) => ({ ...source, order }))
      : resolveSources({
          cwd: request.cwd,
          prompt: request.prompt,
          event: request.event,
          toolName: request.toolName,
          toolContext: request.toolContext,
          targetPaths: request.targetPaths,
          globalAgentsPaths: request.globalAgentsPaths,
          codexHome: request.codexHome,
          useCodexRouting:
            request.useCodexRouting ?? (request.client === "codex" || request.client === "cursor"),
        })

  if (request.delta) {
    const delta = renderWithDelta({
      sources,
      mode: request.mode ?? "curated",
      prompt: request.prompt,
      previous: request.previousProfile,
      delta: true,
    })
    return {
      blocks: delta.blocks,
      telemetry: delta.telemetry,
      source_paths: sources.map((source) => source.filepath),
      update: delta.update,
      profile: delta.profile,
    }
  }

  const rendered = render(sources, {
    mode: request.mode ?? "curated",
    prompt: request.prompt,
  })
  return {
    blocks: rendered.blocks,
    telemetry: rendered.telemetry,
    source_paths: sources.map((source) => source.filepath),
    update: "snapshot",
    profile: renderWithDelta({
      sources,
      mode: request.mode ?? "curated",
      prompt: request.prompt,
      delta: false,
    }).profile,
  }
}
