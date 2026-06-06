import type { Provider } from "@/provider/provider"
import { LocalModelServerMemory } from "@/memory/local-model-server"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Natural-language memory query." }),
  target_uri: Schema.optional(Schema.String).annotate({
    description: "Optional viking:// URI scope to restrict retrieval.",
  }),
  mode: Schema.optional(Schema.Literals(["auto", "fast", "deep"] as const)).annotate({
    description: "auto|fast|deep. auto uses session context for deeper multi-turn memory search when available.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "Maximum memory results to return. Defaults to model-server policy.",
  }),
  score_threshold: Schema.optional(Schema.Number).annotate({
    description: "Optional minimum relevance score threshold.",
  }),
})

type Metadata = {
  status?: string
  mode?: string
  openviking_session_id?: unknown
}

function currentProvider(ctx: Tool.Context) {
  const model = ctx.extra?.model as Provider.Model | undefined
  return model?.providerID
}

function output(payload: Record<string, unknown>) {
  return JSON.stringify(payload, null, 2)
}

export const MemSearchTool = Tool.define<typeof Parameters, Metadata, LocalModelServerMemory.Service>(
  "memsearch",
  Effect.gen(function* () {
    const memory = yield* LocalModelServerMemory.Service
    return {
      description:
        "Search persisted OpenViking memory through the local model-server. Use for project decisions, prior session context, skills, and Codex memory recall.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const query = params.query.trim()
          if (!query) {
            return {
              title: "memsearch",
              output: output({ status: "error", reason: "query is required" }),
              metadata: { status: "error" },
            }
          }
          const providerID = currentProvider(ctx)
          if (!providerID) {
            return {
              title: query,
              output: output({ status: "error", reason: "active model provider is unavailable" }),
              metadata: { status: "error" },
            }
          }
          const result: Record<string, unknown> = yield* memory
            .search({
              sessionID: String(ctx.sessionID),
              providerID,
              query,
              target_uri: params.target_uri,
              mode: params.mode ?? "auto",
              limit: params.limit,
              score_threshold: params.score_threshold,
              signal: ctx.abort,
            })
            .pipe(
              Effect.catch((error) =>
                Effect.succeed({ status: "fallback", reason: error.message } satisfies Record<string, unknown>),
              ),
            )
          return {
            title: query,
            output: output(result),
            metadata: {
              status: typeof result.status === "string" ? result.status : undefined,
              mode: typeof result.mode === "string" ? result.mode : undefined,
              openviking_session_id: result.openviking_session_id,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
