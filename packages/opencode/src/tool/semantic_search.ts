import type { Provider } from "@/provider/provider"
import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { ContextIntel } from "@/context-intel"
import { LocalModelServerMemory } from "@/memory/local-model-server"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Natural-language or conceptual code search query." }),
  path: Schema.optional(Schema.String).annotate({
    description: "Optional directory or file scope, absolute or relative to cwd. Defaults to cwd.",
  }),
  max: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "Maximum ranked hits to return. Defaults to 10.",
  }),
  mode: Schema.optional(Schema.Literals(["auto", "lexical", "semantic"] as const)).annotate({
    description: "auto|lexical|semantic. Cold semantic indexes return lexical hits immediately and warm locally.",
  }),
})

type Metadata = ContextIntel.SearchMetadata

const workspaceCodeTargetUri = "viking://resources/workspace/code"

type JsonRecord = Record<string, unknown>

function isRecord(input: unknown): input is JsonRecord {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function currentProvider(ctx: Tool.Context) {
  const model = ctx.extra?.model as Provider.Model | undefined
  return model?.providerID
}

function stringField(record: JsonRecord | undefined, keys: string[]) {
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function numberField(record: JsonRecord | undefined, keys: string[]) {
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

function nestedRecord(record: JsonRecord, key: string) {
  const value = record[key]
  return isRecord(value) ? value : undefined
}

function candidateRecords(input: unknown): JsonRecord[] {
  if (Array.isArray(input)) return input.flatMap(candidateRecords)
  if (!isRecord(input)) return []
  const nested = ["result", "results", "items", "nodes", "data", "matches", "documents", "resources", "memories", "skills"]
    .flatMap((key) => candidateRecords(input[key]))
  const direct =
    stringField(input, ["uri", "target_uri", "resource_uri", "path", "file", "source"]) ||
    stringField(nestedRecord(input, "metadata"), ["uri", "path", "rel_path"]) ||
    stringField(input, ["snippet", "text", "content", "abstract", "overview", "summary"])
  return direct ? [input, ...nested] : nested
}

function compactSnippet(input: string | undefined) {
  const cleaned = input?.replace(/\s+/g, " ").trim()
  if (!cleaned) return ""
  return cleaned.length > 220 ? `${cleaned.slice(0, 217)}...` : cleaned
}

function pathFromOpenVikingRecord(record: JsonRecord, worktree: string) {
  const metadata = nestedRecord(record, "metadata")
  const uri = stringField(record, ["uri", "target_uri", "resource_uri"]) ?? stringField(metadata, ["uri", "target_uri"])
  const relPath =
    stringField(record, ["rel_path", "relative_path"]) ??
    stringField(metadata, ["rel_path", "relative_path"]) ??
    (uri?.startsWith(workspaceCodeTargetUri)
      ? uri.slice(workspaceCodeTargetUri.length).replace(/^\/+/, "")
      : undefined)
  const explicitPath =
    stringField(record, ["path", "file", "source_path"]) ?? stringField(metadata, ["path", "file", "source_path"])
  if (explicitPath) return path.isAbsolute(explicitPath) ? explicitPath : path.join(worktree, explicitPath)
  if (relPath) return path.join(worktree, relPath)
  return uri ?? "viking://resources/workspace/code"
}

function hitFromOpenVikingRecord(record: JsonRecord, worktree: string): ContextIntel.SearchHit | undefined {
  const metadata = nestedRecord(record, "metadata")
  const source = nestedRecord(record, "source") ?? nestedRecord(record, "document") ?? nestedRecord(record, "node")
  const snippet = compactSnippet(
    stringField(record, ["snippet", "text", "content", "abstract", "overview", "summary"]) ??
      stringField(source, ["snippet", "text", "content", "abstract", "overview", "summary"]),
  )
  if (!snippet) return undefined
  const fullPath = pathFromOpenVikingRecord(record, worktree)
  const start = Math.max(1, Math.trunc(numberField(record, ["start", "line", "line_number"]) ?? numberField(metadata, ["start", "line", "line_number"]) ?? 1))
  const end = Math.max(start, Math.trunc(numberField(record, ["end", "end_line"]) ?? numberField(metadata, ["end", "end_line"]) ?? start))
  return {
    path: fullPath,
    start,
    end,
    label: stringField(record, ["label", "title", "name"]) ?? stringField(metadata, ["label", "title", "name"]) ?? "openviking",
    score: numberField(record, ["score", "similarity", "relevance"]) ?? numberField(metadata, ["score", "similarity", "relevance"]) ?? 1,
    snippet,
  }
}

function openVikingHits(payload: JsonRecord, worktree: string, max: number) {
  const seen = new Set<string>()
  return candidateRecords(payload)
    .map((record) => hitFromOpenVikingRecord(record, worktree))
    .filter((hit): hit is ContextIntel.SearchHit => {
      if (!hit) return false
      const key = `${hit.path}:${hit.start}:${hit.snippet}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, max)
}

function renderSearchHits(hits: ContextIntel.SearchHit[]) {
  if (hits.length === 0) return "No results found"
  return hits
    .map((hit) => {
      const location = `${hit.path}:${hit.start}${hit.end !== hit.start ? `-${hit.end}` : ""}`
      return `${hit.score.toFixed(2)} ${location} ${hit.label}\n  ${hit.snippet}`
    })
    .join("\n")
}

function workspaceTargetUri(params: Schema.Schema.Type<typeof Parameters>, instance: { directory: string; worktree: string }) {
  if (!params.path) return workspaceCodeTargetUri
  const requested = path.isAbsolute(params.path) ? params.path : path.resolve(instance.directory, params.path)
  const rel = path.relative(instance.worktree, requested)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return workspaceCodeTargetUri
  const encoded = rel.split(path.sep).filter(Boolean).map(encodeURIComponent).join("/")
  return `${workspaceCodeTargetUri}/${encoded}`
}

function openVikingSemanticSearch(
  memory: LocalModelServerMemory.Interface,
  params: Schema.Schema.Type<typeof Parameters>,
  ctx: Tool.Context<Metadata>,
) {
  return Effect.gen(function* () {
    const providerID = currentProvider(ctx)
    if (!providerID || !LocalModelServerMemory.isLocalModelServerProvider(providerID)) return undefined
    const instance = yield* InstanceState.context
    const max = Math.min(50, Math.max(1, params.max ?? 10))
    const payload = yield* memory
      .search({
        sessionID: String(ctx.sessionID),
        providerID,
        query: params.query,
        target_uri: workspaceTargetUri(params, instance),
        mode: "fast",
        limit: max,
        signal: ctx.abort,
      })
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!payload) return undefined
    const status = typeof payload.status === "string" ? payload.status : "ok"
    if (status !== "ok") return undefined
    const hits = openVikingHits(payload, instance.worktree, max)
    if (hits.length === 0) return undefined
    return {
      output: renderSearchHits(hits),
      metadata: {
        cwd: instance.directory,
        path: params.path,
        mode: "semantic" as const,
        requested_mode: params.mode ?? "auto",
        indexed: true,
        scheduled: false,
        count: hits.length,
        truncated: false,
        backend: "openviking" as const,
      },
    }
  })
}

export const SemanticSearchTool = Tool.define<typeof Parameters, Metadata, ContextIntel.Service | LocalModelServerMemory.Service>(
  "semantic_search",
  Effect.gen(function* () {
    const contextIntel = yield* ContextIntel.Service
    const memory = yield* LocalModelServerMemory.Service
    return {
      description:
        "Conceptually search the current codebase. Returns compact ranked file spans, symbols or chunk labels, scores, and short snippets.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          if (!params.query.trim()) throw new Error("query is required")
          const instance = yield* InstanceState.context
          const requested = path.isAbsolute(params.path ?? instance.directory)
            ? (params.path ?? instance.directory)
            : path.resolve(instance.directory, params.path ?? ".")
          yield* assertExternalDirectoryEffect(ctx, requested)
          yield* ctx.ask({
            permission: "grep",
            patterns: [params.query],
            always: ["*"],
            metadata: {
              query: params.query,
              path: params.path,
              mode: params.mode ?? "auto",
            },
          })

          const openViking =
            (params.mode ?? "auto") === "lexical"
              ? undefined
              : yield* openVikingSemanticSearch(memory, params, ctx)
          const result = openViking ?? (yield* contextIntel.semanticSearch({
            query: params.query,
            path: params.path,
            max: params.max,
            mode: params.mode,
            signal: ctx.abort,
          }))
          const telemetry = yield* contextIntel.recordTool({
            messageID: String(ctx.messageID),
            toolID: "semantic_search",
            output: result.output,
            schemaTokens: 68,
          })
          return {
            title: params.query,
            output: result.output,
            metadata: { ...result.metadata, telemetry },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
