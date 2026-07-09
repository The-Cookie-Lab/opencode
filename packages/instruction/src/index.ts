export type { Entry, InstructionDomain, Parsed, Source } from "./parser"
export { parse } from "./parser"
export type { Result as ReconcileResult } from "./reconciler"
export { reconcile } from "./reconciler"
export type { Routed } from "./router"
export { classifyTask, countDomains, route } from "./router"
export type { Mode, RenderOptions, Rendered, Telemetry } from "./renderer"
export { render } from "./renderer"
export type { ResolveOptions } from "./resolve-sources"
export { resolveSourcePaths, resolveSources } from "./resolve-sources"
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

export const InstructionParser = { parse }
export const InstructionReconciler = { reconcile }
export const InstructionRouter = { classifyTask, countDomains, route }
export const InstructionRenderer = { render }

export interface RenderRequest {
  readonly mode?: Mode
  readonly cwd: string
  readonly prompt?: string
  readonly globalAgentsPaths?: readonly string[]
  readonly client?: string
  readonly sources?: readonly Source[]
}

export interface RenderResponse {
  readonly blocks: string[]
  readonly telemetry?: ReturnType<typeof render>["telemetry"]
  readonly source_paths: string[]
}

export function renderInstructionRequest(request: RenderRequest): RenderResponse {
  const sources =
    request.sources && request.sources.length > 0
      ? request.sources.map((source, order) => ({ ...source, order }))
      : resolveSources({
          cwd: request.cwd,
          globalAgentsPaths: request.globalAgentsPaths,
        })
  const rendered = render(sources, {
    mode: request.mode ?? "curated",
    prompt: request.prompt,
  })
  return {
    blocks: rendered.blocks,
    telemetry: rendered.telemetry,
    source_paths: sources.map((source) => source.filepath),
  }
}
