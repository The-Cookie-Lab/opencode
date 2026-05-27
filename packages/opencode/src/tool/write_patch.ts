import * as path from "path"
import { Effect, Schema, Semaphore } from "effect"
import { createTwoFilesPatch, diffLines } from "diff"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Bus } from "@/bus"
import { File } from "@/file"
import { FileWatcher } from "@/file/watcher"
import { Format } from "@/format"
import { InstanceState } from "@/effect/instance-state"
import { LSP } from "@/lsp/lsp"
import type * as LSPClient from "@/lsp/client"
import { Snapshot } from "@/snapshot"
import * as Bom from "@/util/bom"
import { assertExternalDirectoryEffect } from "./external-directory"
import { trimDiff } from "./edit"
import * as Tool from "./tool"

const locks = new Map<string, Semaphore.Semaphore>()
const FUZZY_THRESHOLD = 0.7

export const Parameters = Schema.Struct({
  path: Schema.String.annotate({ description: "file path" }),
  old: Schema.String.annotate({ description: "exact text; empty creates/overwrites" }),
  new: Schema.String.annotate({ description: "replacement text" }),
  count: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "expected replacements; default 1",
  }),
})

type Metadata = {
  diagnostics: Record<string, LSPClient.Diagnostic[]>
  diff: string
  filediff: Snapshot.FileDiff
}

export const WritePatchTool = Tool.define<
  typeof Parameters,
  Metadata,
  LSP.Service | AppFileSystem.Service | Format.Service | Bus.Service
>(
  "write_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* AppFileSystem.Service
    const format = yield* Format.Service
    const bus = yield* Bus.Service

    return {
      description:
        'edit by exact replacement. args: path, old, new, count? old="" => create/overwrite. mutate only when occurrence count matches; fail with nearest text on mismatch.',
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          if (params.old !== "" && params.old === params.new) {
            throw new Error("No changes to apply: old and new are identical.")
          }

          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.path) ? params.path : path.join(instance.directory, params.path)
          yield* assertExternalDirectoryEffect(ctx, filepath)

          let contentOld = ""
          let contentNew = ""
          let diff = ""

          yield* lock(filepath).withPermits(1)(
            Effect.gen(function* () {
              const exists = yield* afs.existsSafe(filepath)
              if (!exists && params.old !== "") throw new Error(`File not found: ${filepath}`)
              const source = exists ? yield* Bom.readFile(afs, filepath) : { bom: false, text: "" }
              const nextText = params.old === "" ? params.new : applyExact(source.text, params)
              const next = Bom.split(nextText)
              const desiredBom = source.bom || next.bom
              contentOld = source.text
              contentNew = next.text
              diff = trimDiff(
                createTwoFilesPatch(
                  filepath,
                  filepath,
                  normalizeLineEndings(contentOld),
                  normalizeLineEndings(contentNew),
                ),
              )

              yield* ctx.ask({
                permission: "edit",
                patterns: [path.relative(instance.worktree, filepath)],
                always: ["*"],
                metadata: {
                  filepath,
                  diff,
                },
              })

              yield* afs.writeWithDirs(filepath, Bom.join(contentNew, desiredBom))
              if (yield* format.file(filepath)) contentNew = yield* Bom.syncFile(afs, filepath, desiredBom)
              yield* bus.publish(File.Event.Edited, { file: filepath })
              yield* bus.publish(FileWatcher.Event.Updated, {
                file: filepath,
                event: exists ? "change" : "add",
              })
              diff = trimDiff(
                createTwoFilesPatch(
                  filepath,
                  filepath,
                  normalizeLineEndings(contentOld),
                  normalizeLineEndings(contentNew),
                ),
              )
            }).pipe(Effect.orDie),
          )

          const filediff = fileDiff(filepath, diff, contentOld, contentNew)
          yield* ctx.metadata({
            metadata: {
              diff,
              filediff,
              diagnostics: {},
            },
          })

          yield* lsp.touchFile(filepath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const block = LSP.Diagnostic.report(filepath, diagnostics[AppFileSystem.normalizePath(filepath)] ?? [])
          return {
            title: path.relative(instance.worktree, filepath),
            metadata: {
              diagnostics,
              diff,
              filediff,
            },
            output: `Patch applied.${block ? `\n\nLSP errors detected in this file, please fix:\n${block}` : ""}`,
          }
        }),
    }
  }),
)

function lock(filePath: string) {
  const resolved = AppFileSystem.resolve(filePath)
  const hit = locks.get(resolved)
  if (hit) return hit
  const next = Semaphore.makeUnsafe(1)
  locks.set(resolved, next)
  return next
}

function normalizeLineEndings(text: string) {
  return text.replaceAll("\r\n", "\n")
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n") {
  if (ending === "\n") return text
  return text.replaceAll("\n", "\r\n")
}

function applyExact(content: string, params: Schema.Schema.Type<typeof Parameters>) {
  const ending = detectLineEnding(content)
  const oldText = convertToLineEnding(normalizeLineEndings(params.old), ending)
  const newText = convertToLineEnding(normalizeLineEndings(params.new), ending)
  const expected = params.count ?? 1
  const count = occurrences(content, oldText)
  if (count !== expected) {
    throw replacementCountError(content, oldText, expected, count)
  }
  return content.split(oldText).join(newText)
}

function occurrences(content: string, needle: string) {
  if (needle === "") return 0
  return content.split(needle).length - 1
}

function nearest(content: string, needle: string) {
  const searchLines = needle.split("\n")
  const lines = content.split("\n")
  const size = Math.max(1, Math.min(searchLines.length, lines.length))
  const candidates = lines
    .map((_, index) => lines.slice(index, index + size).join("\n"))
    .filter((candidate) => candidate.length > 0)
  const best = candidates
    .map((candidate) => ({ candidate, score: distance(candidate, needle) }))
    .sort((a, b) => a.score - b.score)[0]?.candidate
  if (!best) return undefined
  return best.length > 800 ? `${best.slice(0, 800)}...` : best
}

function replacementCountError(content: string, needle: string, expected: number, count: number) {
  if (count > 0) {
    return new Error(
      [
        `Expected ${expected} replacement${expected === 1 ? "" : "s"} but found ${count}.`,
        `Set count=${count} to replace all occurrences, or add more surrounding context to target one occurrence.`,
      ].join("\n\n"),
    )
  }

  const nearby = nearest(content, needle)
  if (!nearby) return new Error(`Expected ${expected} replacement${expected === 1 ? "" : "s"} but found 0.`)

  const similarity = ratio(needle, nearby)
  const prefix =
    similarity >= FUZZY_THRESHOLD
      ? `Exact match not found; nearest text is ${Math.round(similarity * 100)}% similar.`
      : `Exact match not found; nearest text is only ${Math.round(similarity * 100)}% similar.`
  return new Error(
    [
      `Expected ${expected} replacement${expected === 1 ? "" : "s"} but found 0.`,
      prefix,
      `Differences:\n${highlightDifferences(needle, nearby)}`,
      `Nearest match:\n${nearby}`,
      "Use the exact text found in the file, or add more surrounding context.",
    ].join("\n\n"),
  )
}

function ratio(a: string, b: string) {
  const size = Math.max(a.length, b.length)
  if (size === 0) return 1
  return 1 - distance(a, b) / size
}

function highlightDifferences(expected: string, actual: string) {
  const limit = 800
  const left = expected.length > limit ? `${expected.slice(0, limit)}...` : expected
  const right = actual.length > limit ? `${actual.slice(0, limit)}...` : actual
  const min = Math.min(left.length, right.length)
  const prefix = commonPrefix(left, right, min)
  const suffix = commonSuffix(left, right, min, prefix)
  return [
    left.slice(0, prefix),
    "{-",
    left.slice(prefix, left.length - suffix),
    "-}{+",
    right.slice(prefix, right.length - suffix),
    "+}",
    left.slice(left.length - suffix),
  ].join("")
}

function commonPrefix(a: string, b: string, max: number) {
  for (let index = 0; index < max; index++) {
    if (a[index] !== b[index]) return index
  }
  return max
}

function commonSuffix(a: string, b: string, max: number, prefix: number) {
  for (let index = 0; index < max - prefix; index++) {
    if (a[a.length - 1 - index] !== b[b.length - 1 - index]) return index
  }
  return max - prefix
}

function distance(a: string, b: string) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]
    previous[0] = i
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = previous[j]
      previous[j] = next
    }
  }
  return previous[b.length]
}

function fileDiff(file: string, diff: string, contentOld: string, contentNew: string): Snapshot.FileDiff {
  let additions = 0
  let deletions = 0
  for (const change of diffLines(contentOld, contentNew)) {
    if (change.added) additions += change.count || 0
    if (change.removed) deletions += change.count || 0
  }
  return {
    file,
    patch: diff,
    additions,
    deletions,
  }
}
