import path from "path"
import { Effect, Option, Schema } from "effect"
import * as Stream from "effect/Stream"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/filesystem/ripgrep"
import { InstanceState } from "@/effect/instance-state"
import { Reference } from "@/reference/reference"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Tool from "./tool"

const MAX_LINE_LENGTH = 2000

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "regex or glob" }),
  path: Schema.optional(Schema.String).annotate({ description: "search root/file; default cwd" }),
  mode: Schema.optional(Schema.Union([Schema.Literal("content"), Schema.Literal("files")])).annotate({
    description: "content|files; default content",
  }),
  glob: Schema.optional(Schema.String).annotate({ description: "content file filter" }),
  literal: Schema.optional(Schema.Boolean).annotate({ description: "treat pattern literally" }),
  ignoreCase: Schema.optional(Schema.Boolean).annotate({ description: "case-insensitive match" }),
  hidden: Schema.optional(Schema.Boolean).annotate({ description: "include dotfiles; default true" }),
  max: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({ description: "max rows; default 100" }),
})

type Metadata = {
  count: number
  mode: "content" | "files"
  truncated: boolean
}

export const RgTool = Tool.define<
  typeof Parameters,
  Metadata,
  FSUtil.Service | Ripgrep.Service | Reference.Service
>(
  "rg",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const rg = yield* Ripgrep.Service
    const reference = yield* Reference.Service

    return {
      description:
        "ripgrep. mode=content searches file text; mode=files lists matching paths. args: pattern,path?,glob?,literal?,ignoreCase?,hidden?,max?",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          if (!params.pattern) throw new Error("pattern is required")
          const mode = params.mode ?? "content"
          const instance = yield* InstanceState.context
          const requested = path.isAbsolute(params.path ?? instance.directory)
            ? (params.path ?? instance.directory)
            : path.join(instance.directory, params.path ?? ".")
          yield* reference.ensure(requested)
          const requestedInfo = yield* fs.stat(requested).pipe(Effect.catch(() => Effect.succeed(undefined)))
          yield* assertExternalDirectoryEffect(ctx, requested, {
            bypass: yield* reference.contains(requested),
            kind: requestedInfo?.type === "Directory" ? "directory" : "file",
          })

          yield* ctx.ask({
            permission: mode === "files" ? "glob" : "grep",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
              mode,
              glob: params.glob,
            },
          })

          if (mode === "files")
            return yield* files(params, requested, instance.worktree, requestedInfo?.type, rg, fs, ctx)
          return yield* content(params, requested, requestedInfo?.type, rg, ctx)
        }).pipe(Effect.orDie),
    }
  }),
)

const files = Effect.fn("RgTool.files")(function* (
  params: Schema.Schema.Type<typeof Parameters>,
  requested: string,
  worktree: string,
  requestedType: string | undefined,
  rg: Ripgrep.Interface,
  fs: FSUtil.Interface,
  ctx: Tool.Context<Metadata>,
) {
  if (requestedType === "File") throw new Error(`rg files path must be a directory: ${requested}`)
  const limit = params.max ?? 100
  const rows = yield* rg
    .files({ cwd: FSUtil.resolve(requested), glob: [params.pattern], hidden: params.hidden, signal: ctx.abort })
    .pipe(
      Stream.mapEffect((file) =>
        Effect.gen(function* () {
          const full = path.resolve(requested, file)
          const info = yield* fs.stat(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const mtime =
            info?.mtime.pipe(
              Option.map((date) => date.getTime()),
              Option.getOrElse(() => 0),
            ) ?? 0
          return { path: full, mtime }
        }),
      ),
      Stream.take(limit + 1),
      Stream.runCollect,
      Effect.map((chunk) => [...chunk].sort((a, b) => b.mtime - a.mtime)),
    )
  const truncated = rows.length > limit
  const final = truncated ? rows.slice(0, limit) : rows
  return {
    title: path.relative(worktree, requested),
    metadata: {
      count: final.length,
      mode: "files" as const,
      truncated,
    },
    output: final.length
      ? [
          ...final.map((item) => item.path),
          ...(truncated ? ["", `(truncated: showing ${limit} of ${rows.length}+)`] : []),
        ].join("\n")
      : "No files found",
  }
})

const content = Effect.fn("RgTool.content")(function* (
  params: Schema.Schema.Type<typeof Parameters>,
  requested: string,
  requestedType: string | undefined,
  rg: Ripgrep.Interface,
  ctx: Tool.Context<Metadata>,
) {
  const search = FSUtil.resolve(requested)
  const cwd = requestedType === "Directory" ? search : path.dirname(search)
  const file = requestedType === "Directory" ? undefined : [path.relative(cwd, search)]
  const result = yield* rg.search({
    cwd,
    pattern: params.pattern,
    glob: params.glob ? [params.glob] : undefined,
    file,
    hidden: params.hidden,
    literal: params.literal,
    ignoreCase: params.ignoreCase,
    signal: ctx.abort,
  })
  const rows = result.items.map((item) => ({
    path: FSUtil.resolve(path.isAbsolute(item.path.text) ? item.path.text : path.join(cwd, item.path.text)),
    line: item.line_number,
    text: item.lines.text,
  }))
  const limit = params.max ?? 100
  const truncated = rows.length > limit
  const final = truncated ? rows.slice(0, limit) : rows
  const output = final.length
    ? [`Found ${rows.length} matches${truncated ? ` (showing ${limit})` : ""}`]
    : ["No files found"]
  let current = ""
  for (const match of final) {
    if (current !== match.path) {
      if (current !== "") output.push("")
      current = match.path
      output.push(`${match.path}:`)
    }
    output.push(`  Line ${match.line}: ${trimLine(match.text)}`)
  }
  if (result.partial) output.push("", "(Some paths were inaccessible and skipped)")
  return {
    title: params.pattern,
    metadata: {
      count: rows.length,
      mode: "content" as const,
      truncated,
    },
    output: output.join("\n"),
  }
})

function trimLine(line: string) {
  if (line.length <= MAX_LINE_LENGTH) return line
  return `${line.slice(0, MAX_LINE_LENGTH)}...`
}
