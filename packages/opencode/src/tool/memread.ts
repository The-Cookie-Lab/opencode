import type { Provider } from "@/provider/provider"
import { LocalModelServerMemory } from "@/memory/local-model-server"
import { Effect, Schema } from "effect"
import { Tool } from "./tool"

export const Parameters = Schema.Struct({
  uri: Schema.String.annotate({ description: "viking:// URI to read from persisted memory." }),
  level: Schema.optional(Schema.Literals(["auto", "abstract", "overview", "read"] as const)).annotate({
    description: "auto|abstract|overview|read. auto lets model-server choose a directory overview or direct read.",
  }),
})

type Metadata = {
  status?: string
  level?: string
  uri?: string
}

function currentProvider(ctx: Tool.Context) {
  const model = ctx.extra?.model as Provider.Model | undefined
  return model?.providerID
}

function output(payload: Record<string, unknown>) {
  return JSON.stringify(payload, null, 2)
}

export const MemReadTool = Tool.define<typeof Parameters, Metadata, LocalModelServerMemory.Service>(
  "memread",
  Effect.gen(function* () {
    const memory = yield* LocalModelServerMemory.Service
    return {
      description:
        "Read a viking:// memory URI through the local model-server. Use after memsearch when more detail is needed from a recalled memory resource.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const uri = params.uri.trim()
          if (!uri) {
            return {
              title: "memread",
              output: output({ status: "error", reason: "uri is required" }),
              metadata: { status: "error" },
            }
          }
          const providerID = currentProvider(ctx)
          if (!providerID) {
            return {
              title: uri,
              output: output({ status: "error", reason: "active model provider is unavailable" }),
              metadata: { status: "error" },
            }
          }
          const result: Record<string, unknown> = yield* memory
            .read({
              providerID,
              uri,
              level: params.level ?? "auto",
              signal: ctx.abort,
            })
            .pipe(
              Effect.catch((error) =>
                Effect.succeed({ status: "fallback", reason: error.message } satisfies Record<string, unknown>),
              ),
            )
          return {
            title: uri,
            output: output(result),
            metadata: {
              status: typeof result.status === "string" ? result.status : undefined,
              level: typeof result.level === "string" ? result.level : undefined,
              uri: typeof result.uri === "string" ? result.uri : undefined,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
