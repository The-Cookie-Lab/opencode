import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "@/agent/agent"
import { ContextIntel } from "@/context-intel"
import { FetchHttpClient } from "effect/unstable/http"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { MessageID, SessionID } from "@/session/schema"
import { Permission } from "@/permission"
import { ProjectDossierTool } from "@/tool/project_dossier"
import { Ripgrep } from "@/file/ripgrep"
import { SemanticSearchTool } from "@/tool/semantic_search"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { ViewOutlineTool } from "@/tool/view_outline"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

let lspAvailable = false
let documentSymbols: unknown[] = []

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(lspAvailable),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed([]),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed(documentSymbols as any),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const contextIntelLayer = ContextIntel.layer.pipe(
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(lsp),
  Layer.provide(Ripgrep.defaultLayer),
)

const layer = Layer.mergeAll(
  Agent.defaultLayer,
  AppFileSystem.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  FetchHttpClient.layer,
  Git.defaultLayer,
  lsp,
  Ripgrep.defaultLayer,
  Truncate.defaultLayer,
  contextIntelLayer,
)

const it = testEffect(layer)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
} satisfies Tool.Context

const asks = () => {
  const items: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    } satisfies Tool.Context,
  }
}

const initProjectDossier = Effect.fn("MacroToolsTest.initProjectDossier")(function* () {
  const info = yield* ProjectDossierTool
  return yield* info.init()
})

const initViewOutline = Effect.fn("MacroToolsTest.initViewOutline")(function* () {
  const info = yield* ViewOutlineTool
  return yield* info.init()
})

const initSemanticSearch = Effect.fn("MacroToolsTest.initSemanticSearch")(function* () {
  const info = yield* SemanticSearchTool
  return yield* info.init()
})

afterEach(async () => {
  lspAvailable = false
  documentSymbols = []
  await disposeAllInstances()
})

describe("macro tools", () => {
  describe("project_dossier", () => {
    for (const fixture of [
      {
        name: "Node",
        files: {
          "package.json": JSON.stringify({ scripts: { build: "tsc", test: "bun test" }, main: "dist/index.js" }),
          "bun.lock": "",
        },
        ecosystem: "Node.js",
        dependency: "package.json",
      },
      {
        name: "Python",
        files: { "pyproject.toml": "[project]\nname = 'sample'\n" },
        ecosystem: "Python",
        dependency: "pyproject.toml",
      },
      {
        name: "Java",
        files: { "pom.xml": "<project />\n" },
        ecosystem: "Java/Kotlin",
        dependency: "pom.xml",
      },
      {
        name: "empty",
        files: {},
        ecosystem: undefined,
        dependency: undefined,
      },
    ]) {
      it.live(`summarizes ${fixture.name} repos`, () =>
        provideTmpdirInstance(
          (dir) =>
            Effect.gen(function* () {
              const fs = yield* AppFileSystem.Service
              for (const [name, content] of Object.entries(fixture.files)) {
                yield* fs.writeWithDirs(path.join(dir, name), content)
              }

              const tool = yield* initProjectDossier()
              const result = yield* tool.execute({}, ctx)

              expect(result.metadata.cwd).toBe(dir)
              if (fixture.ecosystem) expect(result.metadata.ecosystems).toContain(fixture.ecosystem)
              if (fixture.dependency) expect(result.metadata.dependency_files).toContain(fixture.dependency)
              expect(result.output).toContain("Project:")
              expect(result.output.length).toBeLessThan(1200)
            }),
          { git: true },
        ),
      )
    }
  })

  describe("view_outline", () => {
    it.live("normalizes mocked LSP document symbols", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            lspAvailable = true
            documentSymbols = [
              {
                name: "Runner",
                kind: 5,
                detail: "",
                range: { start: { line: 3, character: 0 }, end: { line: 8, character: 1 } },
                selectionRange: { start: { line: 3, character: 6 }, end: { line: 3, character: 12 } },
                children: [
                  {
                    name: "start",
                    kind: 6,
                    detail: "(input: string)",
                    range: { start: { line: 5, character: 2 }, end: { line: 7, character: 3 } },
                    selectionRange: { start: { line: 5, character: 2 }, end: { line: 5, character: 7 } },
                  },
                ],
              },
            ]
            const fs = yield* AppFileSystem.Service
            const file = path.join(dir, "runner.ts")
            yield* fs.writeWithDirs(file, "export class Runner {\n  start(input: string) {}\n}\n")

            const tool = yield* initViewOutline()
            const result = yield* tool.execute({ path: file }, ctx)

            expect(result.metadata.source).toBe("lsp")
            expect(result.output).toContain("4 class Runner")
            expect(result.output).toContain("6 method Runner.start(input: string)")
          }),
        { git: true },
      ),
    )

    it.live("falls back to a body-free AST/text outline when LSP is unavailable", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const fs = yield* AppFileSystem.Service
            const file = path.join(dir, "service.ts")
            yield* fs.writeWithDirs(
              file,
              [
                "export class TokenService {",
                "  refreshToken(input: string) {",
                "    return input.trim()",
                "  }",
                "}",
                "export function parseToken(raw: string) {",
                "  return raw",
                "}",
                "",
              ].join("\n"),
            )

            const tool = yield* initViewOutline()
            const result = yield* tool.execute({ path: "service.ts", maxSymbols: 2 }, ctx)

            expect(["cookielayer_ast", "text"]).toContain(result.metadata.source)
            expect(result.metadata.truncated).toBe(true)
            expect(result.output).toContain("1 class TokenService")
            expect(result.output).toContain("2 method TokenService.refreshToken")
            expect(result.output).not.toContain("return input.trim")
          }),
        { git: true },
      ),
    )
  })

  describe("semantic_search", () => {
    it.live("returns cold-index lexical fallback hits and schedules indexing", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const fs = yield* AppFileSystem.Service
            yield* fs.writeWithDirs(path.join(dir, "src", "auth.ts"), "export function refreshToken() { return 'ok' }\n")

            const tool = yield* initSemanticSearch()
            const result = yield* tool.execute({ query: "refresh token", path: "src", max: 5 }, ctx)

            expect(result.metadata.mode).toBe("lexical")
            expect(result.metadata.indexed).toBe(false)
            expect(result.metadata.scheduled).toBe(true)
            expect(result.output).toContain("auth.ts")
            expect(result.output).toContain("refreshToken")
          }),
        { git: true },
      ),
    )

    it.live("uses the warmed local sparse index on a follow-up semantic search", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const fs = yield* AppFileSystem.Service
            yield* fs.writeWithDirs(path.join(dir, "src", "auth.ts"), "export function issueSessionToken() { return 'ok' }\n")
            const tool = yield* initSemanticSearch()

            yield* tool.execute({ query: "session token", path: "src", max: 5, mode: "auto" }, ctx)
            yield* Effect.sleep("250 millis")
            const result = yield* tool.execute({ query: "session token", path: "src", max: 5, mode: "semantic" }, ctx)

            expect(result.metadata.mode).toBe("semantic")
            expect(result.metadata.indexed).toBe(true)
            expect(result.output).toContain("issueSessionToken")
          }),
        { git: true },
      ),
    )

    it.live("honors ignored directories and truncates result sets", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const fs = yield* AppFileSystem.Service
            yield* fs.writeWithDirs(path.join(dir, "node_modules", "pkg", "hidden.ts"), "export const hiddenOnly = true\n")
            for (let i = 0; i < 4; i++) {
              yield* fs.writeWithDirs(path.join(dir, "src", `file${i}.ts`), `export const visibleNeedle${i} = true\n`)
            }

            const tool = yield* initSemanticSearch()
            const hidden = yield* tool.execute({ query: "hiddenOnly", max: 5, mode: "lexical" }, ctx)
            const visible = yield* tool.execute({ query: "visibleNeedle", max: 2, mode: "lexical" }, ctx)

            expect(hidden.output).toBe("No results found")
            expect(visible.metadata.count).toBe(2)
            expect(visible.metadata.truncated).toBe(true)
            expect(visible.output).toContain("src/file")
          }),
        { git: true },
      ),
    )

    it.live("records grep permission metadata", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const fs = yield* AppFileSystem.Service
            yield* fs.writeWithDirs(path.join(dir, "src", "auth.ts"), "export const token = true\n")
            const { items, next } = asks()

            const tool = yield* initSemanticSearch()
            yield* tool.execute({ query: "token", path: "src", mode: "lexical" }, next)

            expect(items.find((item) => item.permission === "grep")?.metadata).toEqual({
              query: "token",
              path: "src",
              mode: "lexical",
            })
          }),
        { git: true },
      ),
    )
  })
})
