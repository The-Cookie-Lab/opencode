import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { ContextIntel } from "@/context-intel"
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

export const SemanticSearchTool = Tool.define<typeof Parameters, Metadata, ContextIntel.Service>(
  "semantic_search",
  Effect.gen(function* () {
    const contextIntel = yield* ContextIntel.Service
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

          const result = yield* contextIntel.semanticSearch({
            query: params.query,
            path: params.path,
            max: params.max,
            mode: params.mode,
            signal: ctx.abort,
          })
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
