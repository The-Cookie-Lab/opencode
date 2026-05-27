import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { ContextIntel } from "@/context-intel"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({})

type Metadata = ContextIntel.ProjectDossierMetadata

export const ProjectDossierTool = Tool.define<typeof Parameters, Metadata, ContextIntel.Service>(
  "project_dossier",
  Effect.gen(function* () {
    const contextIntel = yield* ContextIntel.Service
    return {
      description:
        "Summarize the current repository in a compact dossier: cwd, git state, package manager, ecosystems, scripts, entrypoints, and dependency files.",
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          yield* assertExternalDirectoryEffect(ctx, instance.directory, { kind: "directory" })
          yield* ctx.ask({
            permission: "repo_overview",
            patterns: [instance.directory],
            always: [instance.directory],
            metadata: { path: instance.directory },
          })

          const result = yield* contextIntel.projectDossier()
          const telemetry = yield* contextIntel.recordTool({
            messageID: String(ctx.messageID),
            toolID: "project_dossier",
            output: result.output,
            schemaTokens: 12,
          })
          return {
            title: "project dossier",
            output: result.output,
            metadata: { ...result.metadata, telemetry },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
