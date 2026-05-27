import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { ContextIntel } from "@/context-intel"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  path: Schema.String.annotate({ description: "Source file path, absolute or relative to the current cwd." }),
  maxSymbols: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "Maximum symbol rows to return. Defaults to 120.",
  }),
  includePrivate: Schema.optional(Schema.Boolean).annotate({
    description: "Include private/internal symbols. Defaults to false.",
  }),
})

type Metadata = ContextIntel.OutlineMetadata

export const ViewOutlineTool = Tool.define<typeof Parameters, Metadata, ContextIntel.Service>(
  "view_outline",
  Effect.gen(function* () {
    const contextIntel = yield* ContextIntel.Service
    return {
      description:
        "Return a compact structural outline for one source file: flat line/kind/name/signature rows, without bodies, imports, or comments.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const file = path.isAbsolute(params.path) ? params.path : path.resolve(instance.directory, params.path)
          yield* assertExternalDirectoryEffect(ctx, file, { kind: "file" })
          yield* ctx.ask({
            permission: "read",
            patterns: [path.relative(instance.worktree, file)],
            always: ["*"],
            metadata: { path: file },
          })

          const result = yield* contextIntel.viewOutline({
            path: file,
            maxSymbols: params.maxSymbols,
            includePrivate: params.includePrivate,
          })
          const telemetry = yield* contextIntel.recordTool({
            messageID: String(ctx.messageID),
            toolID: "view_outline",
            output: result.output,
            schemaTokens: 54,
          })
          return {
            title: path.relative(instance.worktree, file),
            output: result.output,
            metadata: { ...result.metadata, telemetry },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
