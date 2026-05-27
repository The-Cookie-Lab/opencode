import path from "path"
import { pathToFileURL } from "url"
import { existsSync } from "fs"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { InstanceState } from "@/effect/instance-state"
import { LSP } from "@/lsp/lsp"
import { Ripgrep } from "@/file/ripgrep"
import { Context, Effect, Layer, Scope } from "effect"
import * as Stream from "effect/Stream"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { FetchHttpClient } from "effect/unstable/http"

const IGNORED_DIRS = [
  ".git",
  ".idea",
  ".svn",
  ".hg",
  ".vscode",
  "__pycache__",
  "node_modules",
  ".venv",
  "venv",
  "env",
  ".env",
  "dist",
  "build",
  ".next",
  "target",
  "vendor",
  "bin",
  "obj",
]
const SEARCH_GLOBS = [
  ...IGNORED_DIRS.map((dir) => `!${dir}/**`),
  "!**/.git/**",
  "!**/node_modules/**",
  "!**/dist/**",
  "!**/build/**",
  "!**/.next/**",
  "!**/target/**",
  "!**/vendor/**",
]
const CODE_GLOBS = [
  "*.py",
  "*.js",
  "*.jsx",
  "*.ts",
  "*.tsx",
  "*.java",
  "*.c",
  "*.cc",
  "*.cpp",
  "*.h",
  "*.hpp",
  "*.rs",
  "*.go",
  "*.cs",
  "*.rb",
  "*.php",
  "*.kt",
  "*.kts",
  "*.scala",
  "*.swift",
  "*.m",
  "*.mm",
]
const DEPENDENCY_FILES = [
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "build.gradle",
  "build.gradle.kts",
  "pom.xml",
  "composer.json",
]
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
])
const MAX_INDEX_FILES = 600
const MAX_FILE_BYTES = 256 * 1024
const DEFAULT_MAX_SYMBOLS = 120
const DEFAULT_SEARCH_MAX = 10

export type TelemetrySnapshot = {
  tool_count: number
  schema_tokens_estimate: number
  output_tokens_estimate: number
  read_loop_count: number
  time_to_first_edit_ms?: number
  time_to_first_test_ms?: number
}

export type ProjectDossierMetadata = {
  cwd: string
  worktree: string
  branch?: string
  head?: string
  package_manager?: string
  ecosystems: string[]
  scripts: string[]
  entrypoints: string[]
  dependency_files: string[]
  truncated: boolean
  telemetry?: TelemetrySnapshot
}

export type OutlineSource = "lsp" | "cookielayer_ast" | "text"

export type OutlineSymbol = {
  line: number
  kind: string
  name: string
  signature?: string
  private?: boolean
}

export type OutlineMetadata = {
  path: string
  source: OutlineSource
  symbol_count: number
  truncated: boolean
  adapter?: "openviking" | "text"
  telemetry?: TelemetrySnapshot
}

export type SearchMode = "auto" | "lexical" | "semantic"

export type SearchHit = {
  path: string
  start: number
  end: number
  label: string
  score: number
  snippet: string
}

export type SearchMetadata = {
  cwd: string
  path?: string
  mode: "lexical" | "semantic"
  requested_mode: SearchMode
  indexed: boolean
  scheduled: boolean
  count: number
  truncated: boolean
  backend: "ripgrep" | "local_sparse"
  telemetry?: TelemetrySnapshot
}

type SemanticIndex = {
  chunks: IndexedChunk[]
  builtAt: number
}

type IndexState = {
  index?: SemanticIndex
  building: boolean
}

type IndexedChunk = SearchHit & {
  text: string
  terms: Map<string, number>
}

type TurnTelemetry = {
  toolCount: number
  schemaTokens: number
  outputTokens: number
  readLoopCount: number
  firstEditAt?: number
  firstTestAt?: number
}

type State = {
  indexes: Map<string, IndexState>
  telemetry: Map<string, TurnTelemetry>
}

export interface Interface {
  readonly projectDossier: () => Effect.Effect<{ output: string; metadata: ProjectDossierMetadata }>
  readonly viewOutline: (input: {
    path: string
    maxSymbols?: number
    includePrivate?: boolean
  }) => Effect.Effect<{ output: string; metadata: OutlineMetadata }>
  readonly semanticSearch: (input: {
    query: string
    path?: string
    max?: number
    mode?: SearchMode
    signal?: AbortSignal
  }) => Effect.Effect<{ output: string; metadata: SearchMetadata }>
  readonly recordTool: (input: {
    messageID: string
    toolID: string
    output: string
    schemaTokens?: number
  }) => Effect.Effect<TelemetrySnapshot>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ContextIntel") {}

export const layer: Layer.Layer<
  Service,
  never,
  AppFileSystem.Service | Git.Service | LSP.Service | Ripgrep.Service | ChildProcessSpawner
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const git = yield* Git.Service
    const lsp = yield* LSP.Service
    const rg = yield* Ripgrep.Service
    const spawner = yield* ChildProcessSpawner
    const scope = yield* Scope.Scope

    const state = yield* InstanceState.make<State>(
      Effect.fn("ContextIntel.state")(function* () {
        return { indexes: new Map(), telemetry: new Map() }
      }),
    )

    const projectDossier = Effect.fn("ContextIntel.projectDossier")(function* () {
      const instance = yield* InstanceState.context
      const entries = yield* fs.readDirectoryEntries(instance.directory).pipe(Effect.orElseSucceed(() => []))
      const topLevel = new Set(entries.map((entry) => entry.name))
      const dependencyFiles = DEPENDENCY_FILES.filter((file) => topLevel.has(file))
      const packageJson = topLevel.has("package.json")
        ? ((yield* fs
            .readJson(path.join(instance.directory, "package.json"))
            .pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>)
        : {}
      const scripts = packageScripts(packageJson)
      const entrypoints = packageEntrypoints(packageJson, topLevel)
      const branch = yield* git.branch(instance.directory)
      const head = yield* git.run(["rev-parse", "HEAD"], { cwd: instance.directory })
      const headText = head.exitCode === 0 ? head.text().trim() : undefined
      const rootEntries = entries
        .filter((entry) => !IGNORED_DIRS.includes(entry.name))
        .sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name))
        .slice(0, 18)
        .map((entry) => `${entry.name}${entry.type === "directory" ? "/" : ""}`)
      const truncated = entries.length > rootEntries.length
      const metadata: ProjectDossierMetadata = {
        cwd: instance.directory,
        worktree: instance.worktree,
        branch,
        head: headText,
        package_manager: packageManager(topLevel),
        ecosystems: ecosystems(topLevel),
        scripts,
        entrypoints,
        dependency_files: dependencyFiles,
        truncated,
      }

      const lines = [
        `Project: ${path.basename(instance.worktree || instance.directory)}`,
        `CWD: ${path.relative(instance.worktree, instance.directory) || "."}`,
        ...(branch || headText ? [`Git: ${branch ?? "detached"}${headText ? ` @ ${headText.slice(0, 12)}` : ""}`] : []),
        metadata.ecosystems.length ? `Stack: ${metadata.ecosystems.join(", ")}` : "Stack: unknown",
        ...(metadata.package_manager ? [`Package manager: ${metadata.package_manager}`] : []),
        ...(dependencyFiles.length ? [`Dependency files: ${dependencyFiles.join(", ")}`] : []),
        ...(scripts.length ? [`Scripts: ${scripts.join(", ")}`] : []),
        ...(entrypoints.length ? [`Entrypoints: ${entrypoints.join(", ")}`] : []),
        ...(rootEntries.length ? [`Top level: ${rootEntries.join(", ")}`] : ["Top level: empty"]),
        ...(truncated ? ["(truncated)"] : []),
      ]

      return { output: lines.join("\n"), metadata }
    })

    const viewOutline = Effect.fn("ContextIntel.viewOutline")(function* (input: {
      path: string
      maxSymbols?: number
      includePrivate?: boolean
    }) {
      const limit = bounded(input.maxSymbols, DEFAULT_MAX_SYMBOLS, 1, 500)
      const text = yield* fs.readFileStringSafe(input.path).pipe(Effect.orElseSucceed(() => undefined))
      if (text === undefined) throw new Error(`File not found: ${input.path}`)

      const lspSymbols = yield* outlineFromLsp(input.path, input.includePrivate ?? false, lsp).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (lspSymbols && lspSymbols.length) {
        const final = takeSymbols(lspSymbols, limit)
        return {
          output: renderOutline(final.symbols),
          metadata: {
            path: input.path,
            source: "lsp" as const,
            symbol_count: final.symbols.length,
            truncated: final.truncated,
          },
        }
      }

      const skeleton = yield* cookieLayerSkeleton(input.path, spawner).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const symbols = outlineFromText(input.path, text, input.includePrivate ?? false)
      const final = takeSymbols(symbols, limit)
      return {
        output: renderOutline(final.symbols),
        metadata: {
          path: input.path,
          source: skeleton ? ("cookielayer_ast" as const) : ("text" as const),
          symbol_count: final.symbols.length,
          truncated: final.truncated,
          adapter: skeleton ? ("openviking" as const) : ("text" as const),
        },
      }
    })

    const semanticSearch = Effect.fn("ContextIntel.semanticSearch")(function* (input: {
      query: string
      path?: string
      max?: number
      mode?: SearchMode
      signal?: AbortSignal
    }) {
      const instance = yield* InstanceState.context
      const requestedMode = input.mode ?? "auto"
      const max = bounded(input.max, DEFAULT_SEARCH_MAX, 1, 50)
      const requested = path.isAbsolute(input.path ?? instance.directory)
        ? (input.path ?? instance.directory)
        : path.resolve(instance.directory, input.path ?? ".")
      const requestedInfo = yield* fs.stat(requested).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const root = requestedInfo?.type === "File" ? path.dirname(requested) : requested
      const fileScope = requestedInfo?.type === "File" ? path.basename(requested) : undefined
      const indexKey = requested
      const s = yield* InstanceState.get(state)
      const current = s.indexes.get(indexKey)
      if (requestedMode !== "lexical" && current?.index) {
        const hits = searchIndex(input.query, current.index.chunks, max)
        return {
          output: renderSearchHits(hits),
          metadata: {
            cwd: instance.directory,
            path: input.path,
            mode: "semantic" as const,
            requested_mode: requestedMode,
            indexed: true,
            scheduled: false,
            count: hits.length,
            truncated: false,
            backend: "local_sparse" as const,
          },
        }
      }

      const scheduled = requestedMode !== "lexical" ? yield* scheduleIndex(root, indexKey, s, input.signal) : false
      const lexical = yield* lexicalSearch(input.query, root, max, input.signal, fileScope)
      return {
        output: renderSearchHits(lexical.hits),
        metadata: {
          cwd: instance.directory,
          path: input.path,
          mode: "lexical" as const,
          requested_mode: requestedMode,
          indexed: false,
          scheduled,
          count: lexical.hits.length,
          truncated: lexical.truncated,
          backend: "ripgrep" as const,
        },
      }
    })

    const recordTool = Effect.fn("ContextIntel.recordTool")(function* (input: {
      messageID: string
      toolID: string
      output: string
      schemaTokens?: number
    }) {
      const s = yield* InstanceState.get(state)
      const current =
        s.telemetry.get(input.messageID) ??
        ({ toolCount: 0, outputTokens: 0, schemaTokens: 0, readLoopCount: 0 } satisfies TurnTelemetry)
      current.toolCount += 1
      current.outputTokens += estimateTokens(input.output)
      current.schemaTokens += input.schemaTokens ?? 0
      s.telemetry.set(input.messageID, current)
      return {
        tool_count: current.toolCount,
        schema_tokens_estimate: current.schemaTokens,
        output_tokens_estimate: current.outputTokens,
        read_loop_count: current.readLoopCount,
        time_to_first_edit_ms: current.firstEditAt,
        time_to_first_test_ms: current.firstTestAt,
      }
    })

    const lexicalSearch = Effect.fn("ContextIntel.lexicalSearch")(function* (
      query: string,
      root: string,
      max: number,
      signal?: AbortSignal,
      file?: string,
    ) {
      const terms = queryTerms(query)
      if (terms.length === 0) throw new Error("query must include at least one searchable term")
      const rows = new Map<string, SearchHit & { matched: Set<string> }>()
      for (const term of terms.slice(0, 8)) {
        const result = yield* rg
          .search({
            cwd: root,
            pattern: term,
            glob: SEARCH_GLOBS,
            hidden: true,
            literal: true,
            ignoreCase: true,
            signal,
            file: file ? [file] : undefined,
          })
          .pipe(Effect.catch(() => Effect.succeed({ items: [], partial: true })))
        for (const item of result.items.slice(0, max * 12)) {
          const full = AppFileSystem.resolve(path.isAbsolute(item.path.text) ? item.path.text : path.join(root, item.path.text))
          const key = `${full}:${item.line_number}`
          const existing = rows.get(key)
          const snippet = trimSnippet(item.lines.text)
          if (existing) {
            existing.matched.add(term)
            existing.score += 1
            continue
          }
          rows.set(key, {
            path: full,
            start: item.line_number,
            end: item.line_number,
            label: path.basename(full),
            score: 1 + pathBoost(full, terms),
            snippet,
            matched: new Set([term]),
          })
        }
      }
      const sorted = [...rows.values()]
        .map((hit) => ({ ...hit, score: hit.score + hit.matched.size * 0.2 }))
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.start - b.start)
      return { hits: sorted.slice(0, max), truncated: sorted.length > max }
    })

    const buildIndex = Effect.fn("ContextIntel.buildIndex")(function* (root: string, indexKey: string, signal?: AbortSignal) {
      const s = yield* InstanceState.get(state)
      const files = yield* rg
        .files({ cwd: root, glob: [...CODE_GLOBS, ...SEARCH_GLOBS], hidden: true, signal })
        .pipe(Stream.take(MAX_INDEX_FILES), Stream.runCollect, Effect.map((chunk) => [...chunk]))
      const chunks: IndexedChunk[] = []
      for (const file of files) {
        const full = AppFileSystem.resolve(path.join(root, file))
        const content = yield* fs.readFileStringSafe(full).pipe(Effect.orElseSucceed(() => undefined))
        if (!content || Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) continue
        const symbols = outlineFromText(full, content, false)
        const lines = content.split(/\r?\n/)
        for (const symbol of symbols.slice(0, 80)) {
          const start = Math.max(1, symbol.line)
          const snippet = trimSnippet(lines[start - 1] ?? "")
          const text = [path.relative(root, full), symbol.kind, symbol.name, symbol.signature, snippet].filter(Boolean).join(" ")
          chunks.push({
            path: full,
            start,
            end: Math.min(lines.length, start + 2),
            label: symbol.name,
            score: 0,
            snippet,
            text,
            terms: termFrequency(text),
          })
        }
      }
      s.indexes.set(indexKey, { building: false, index: { chunks, builtAt: Date.now() } })
    })

    const scheduleIndex = Effect.fn("ContextIntel.scheduleIndex")(function* (
      root: string,
      indexKey: string,
      s: State,
      signal?: AbortSignal,
    ) {
      const current = s.indexes.get(indexKey)
      if (current?.building) return true
      s.indexes.set(indexKey, { building: true, index: current?.index })
      yield* buildIndex(root, indexKey, signal).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            const latest = s.indexes.get(indexKey)
            s.indexes.set(indexKey, { building: false, index: latest?.index })
          }),
        ),
        Effect.ignore,
        Effect.forkIn(scope),
      )
      return true
    })

    return Service.of({ projectDossier, viewOutline, semanticSearch, recordTool })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(LSP.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(Ripgrep.defaultLayer),
)

function packageManager(files: Set<string>) {
  if (files.has("bun.lock") || files.has("bun.lockb")) return "bun"
  if (files.has("pnpm-lock.yaml")) return "pnpm"
  if (files.has("yarn.lock")) return "yarn"
  if (files.has("package-lock.json")) return "npm"
}

function ecosystems(files: Set<string>) {
  return [
    ...(files.has("package.json") ? ["Node.js"] : []),
    ...(files.has("pyproject.toml") || files.has("requirements.txt") ? ["Python"] : []),
    ...(files.has("go.mod") ? ["Go"] : []),
    ...(files.has("Cargo.toml") ? ["Rust"] : []),
    ...(files.has("Gemfile") ? ["Ruby"] : []),
    ...(files.has("build.gradle") || files.has("build.gradle.kts") || files.has("pom.xml") ? ["Java/Kotlin"] : []),
    ...(files.has("composer.json") ? ["PHP"] : []),
  ]
}

function packageScripts(packageJson: Record<string, unknown>) {
  const scripts = packageJson.scripts
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return []
  const preferred = ["dev", "start", "build", "test", "typecheck", "lint"]
  const names = Object.keys(scripts as Record<string, unknown>)
  return [...preferred.filter((name) => names.includes(name)), ...names.filter((name) => !preferred.includes(name)).slice(0, 4)]
}

function packageEntrypoints(packageJson: Record<string, unknown>, files: Set<string>) {
  return [
    ...(typeof packageJson.main === "string" ? [`main:${packageJson.main}`] : []),
    ...(typeof packageJson.module === "string" ? [`module:${packageJson.module}`] : []),
    ...(typeof packageJson.types === "string" ? [`types:${packageJson.types}`] : []),
    ...(typeof packageJson.bin === "string" ? [`bin:${packageJson.bin}`] : []),
    ...(packageJson.bin && typeof packageJson.bin === "object" && !Array.isArray(packageJson.bin)
      ? Object.keys(packageJson.bin as Record<string, unknown>)
          .slice(0, 4)
          .map((name) => `bin:${name}`)
      : []),
    ...["index.ts", "index.js", "main.ts", "main.js", "src/index.ts", "src/index.js", "src/main.ts", "src/main.js"].filter(
      (file) => files.has(file.split("/")[0]) || files.has(file),
    ),
  ].slice(0, 12)
}

function bounded(value: number | undefined, fallback: number, min: number, max: number) {
  if (!value || !Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4))
}

function takeSymbols(symbols: OutlineSymbol[], limit: number) {
  const truncated = symbols.length > limit
  return { symbols: truncated ? symbols.slice(0, limit) : symbols, truncated }
}

function renderOutline(symbols: OutlineSymbol[]) {
  if (symbols.length === 0) return "No symbols found"
  return symbols.map((symbol) => `${symbol.line} ${symbol.kind} ${symbol.name}${symbol.signature ?? ""}`).join("\n")
}

function renderSearchHits(hits: SearchHit[]) {
  if (hits.length === 0) return "No results found"
  return hits
    .map((hit) => {
      const location = `${hit.path}:${hit.start}${hit.end !== hit.start ? `-${hit.end}` : ""}`
      return `${hit.score.toFixed(2)} ${location} ${hit.label}\n  ${hit.snippet}`
    })
    .join("\n")
}

function trimSnippet(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 220)
}

function queryTerms(query: string) {
  const normalized = query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.$#/-]+/g, " ")
    .toLowerCase()
  return [...new Set(normalized.match(/[a-z0-9]{2,}/g) ?? [])].filter((term) => !STOPWORDS.has(term))
}

function termFrequency(text: string) {
  const result = new Map<string, number>()
  for (const term of queryTerms(text)) result.set(term, (result.get(term) ?? 0) + 1)
  return result
}

function pathBoost(file: string, terms: string[]) {
  const normalized = file.toLowerCase()
  return terms.reduce((score, term) => score + (normalized.includes(term) ? 0.35 : 0), 0)
}

function searchIndex(query: string, chunks: IndexedChunk[], max: number) {
  const terms = queryTerms(query)
  if (terms.length === 0) return []
  return chunks
    .map((chunk) => {
      let score = pathBoost(chunk.path, terms)
      for (const term of terms) score += chunk.terms.get(term) ?? 0
      return { ...chunk, score }
    })
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.start - b.start)
    .slice(0, max)
}

function outlineFromText(file: string, content: string, includePrivate: boolean) {
  const rows: OutlineSymbol[] = []
  const lines = content.split(/\r?\n/)
  const classStack: Array<{ name: string; indent: number }> = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue
    const indent = line.length - line.trimStart().length
    while (classStack.length && indent <= classStack[classStack.length - 1].indent) classStack.pop()

    const symbol = parseSymbolLine(trimmed, i + 1, classStack[classStack.length - 1]?.name)
    if (!symbol) continue
    if (symbol.kind === "class" || symbol.kind === "interface" || symbol.kind === "struct" || symbol.kind === "enum") {
      classStack.push({ name: symbol.name, indent })
    }
    if (!includePrivate && isPrivateSymbol(symbol)) continue
    rows.push(symbol)
  }
  return rows
}

function parseSymbolLine(line: string, lineNumber: number, className?: string): OutlineSymbol | undefined {
  const classMatch = line.match(/^(?:export\s+)?(?:abstract\s+)?(?:final\s+)?class\s+([A-Za-z_$][\w$]*)([^{:]*)/)
  if (classMatch) return symbol(lineNumber, "class", classMatch[1], compactSignature(classMatch[2]))
  const interfaceMatch = line.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)([^{]*)/)
  if (interfaceMatch) return symbol(lineNumber, "interface", interfaceMatch[1], compactSignature(interfaceMatch[2]))
  const structMatch = line.match(/^(?:pub\s+)?struct\s+([A-Za-z_$][\w$]*)([^{]*)/)
  if (structMatch) return symbol(lineNumber, "struct", structMatch[1], compactSignature(structMatch[2]))
  const enumMatch = line.match(/^(?:export\s+)?(?:pub\s+)?enum\s+([A-Za-z_$][\w$]*)([^{]*)/)
  if (enumMatch) return symbol(lineNumber, "enum", enumMatch[1], compactSignature(enumMatch[2]))
  const pythonFunction = line.match(/^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*(\(.*\))\s*(?:->\s*([^:]+))?:/)
  if (pythonFunction) return symbol(lineNumber, className ? "method" : "function", scoped(className, pythonFunction[1]), compactSignature(`${pythonFunction[2]}${pythonFunction[3] ? ` -> ${pythonFunction[3]}` : ""}`))
  const goFunction = line.match(/^func\s+(?:\([^)]+\)\s*)?([A-Za-z_][\w]*)\s*(\(.*)/)
  if (goFunction) return symbol(lineNumber, "function", goFunction[1], compactSignature(goFunction[2]))
  const rustFunction = line.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*(\(.*)/)
  if (rustFunction) return symbol(lineNumber, className ? "method" : "function", scoped(className, rustFunction[1]), compactSignature(rustFunction[2]))
  const jsFunction = line.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(\(.*)/)
  if (jsFunction) return symbol(lineNumber, "function", jsFunction[1], compactSignature(jsFunction[2]))
  const variableFunction = line.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(\([^=]*\)|[A-Za-z_$][\w$]*)\s*=>/)
  if (variableFunction) return symbol(lineNumber, "function", variableFunction[1], compactSignature(variableFunction[2]))
  const method = line.match(/^(?:(?:public|private|protected|static|async|override|final|synchronized|virtual|abstract|pub)\s+)*([A-Za-z_$][\w$]*)\s*(\(.*\))\s*(?::|=>|\{|throws|->)/)
  if (method && !["if", "for", "while", "switch", "catch", "return", "new"].includes(method[1])) {
    return symbol(lineNumber, className ? "method" : "function", scoped(className, method[1]), compactSignature(method[2]))
  }
  return
}

function symbol(line: number, kind: string, name: string, signature?: string): OutlineSymbol {
  return { line, kind, name, signature }
}

function scoped(scope: string | undefined, name: string) {
  return scope ? `${scope}.${name}` : name
}

function compactSignature(value: string | undefined) {
  const cleaned = value?.replace(/\s+/g, " ").trim()
  if (!cleaned) return undefined
  return cleaned.length > 160 ? `${cleaned.slice(0, 157)}...` : cleaned
}

function isPrivateSymbol(symbol: OutlineSymbol) {
  const name = symbol.name.split(".").at(-1) ?? symbol.name
  return name.startsWith("_") || name.startsWith("#") || symbol.signature?.includes("private ") === true
}

function outlineFromLsp(file: string, includePrivate: boolean, lsp: LSP.Interface) {
  return Effect.gen(function* () {
    const available = yield* lsp.hasClients(file)
    if (!available) return []
    yield* lsp.touchFile(file, "document")
    const raw = yield* lsp.documentSymbol(pathToFileURL(file).href)
    const rows: OutlineSymbol[] = []
    const visit = (items: unknown[], parent?: string) => {
      for (const item of items) {
        if (!isObject(item)) continue
        const name = typeof item.name === "string" ? item.name : undefined
        if (!name) continue
        const range = isObject(item.range) ? item.range : isObject(item.location) && isObject(item.location.range) ? item.location.range : undefined
        const start = isObject(range?.start) && typeof range.start.line === "number" ? range.start.line + 1 : 1
        const kind = typeof item.kind === "number" ? lspKind(item.kind) : "symbol"
        const detail = typeof item.detail === "string" && item.detail ? item.detail : undefined
        const row = symbol(start, kind, scoped(parent, name), detail)
        if (includePrivate || !isPrivateSymbol(row)) rows.push(row)
        const children = Array.isArray(item.children) ? item.children : []
        visit(children, kind === "class" || kind === "interface" || kind === "struct" ? scoped(parent, name) : parent)
      }
    }
    visit(raw)
    return rows.sort((a, b) => a.line - b.line)
  })
}

function lspKind(kind: number) {
  return (
    {
      5: "class",
      6: "method",
      7: "property",
      8: "field",
      9: "constructor",
      10: "enum",
      11: "interface",
      12: "function",
      13: "variable",
      14: "constant",
      23: "struct",
    } as Record<number, string>
  )[kind] ?? "symbol"
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function cookieLayerSkeleton(file: string, spawner: ChildProcessSpawner["Service"]) {
  return Effect.gen(function* () {
    const root = findCookieLayerRoot(file)
    if (!root) return
    const python = process.env.OPENCODE_COOKIE_LAYER_PYTHON ?? process.env.PYTHON ?? "python3"
    const script = [
      "import json, pathlib, sys",
      `sys.path.insert(0, ${JSON.stringify(root)})`,
      "from openviking.parse.parsers.code.ast.extractor import get_extractor",
      "p = pathlib.Path(sys.argv[1])",
      "text = p.read_text(encoding='utf-8', errors='ignore')",
      "skeleton = get_extractor().extract_skeleton(str(p), text, verbose=False)",
      "print(json.dumps({'skeleton': skeleton}))",
    ].join("\n")
    const handle = yield* spawner.spawn(
      ChildProcess.make(python, ["-c", script, file], {
        cwd: root,
        extendEnv: true,
        env: { PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
        stdin: "ignore",
      }),
    )
    const [stdout, _stderr, code] = yield* Effect.all(
      [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
      { concurrency: "unbounded" },
    )
    if (code !== 0) return
    const data = JSON.parse(stdout) as { skeleton?: string | null }
    return data.skeleton || undefined
  }).pipe(Effect.scoped)
}

function findCookieLayerRoot(file: string) {
  const envRoot = process.env.OPENCODE_COOKIE_LAYER_PATH ?? process.env.COOKIE_LAYER_PATH ?? process.env.COOKIECODE_LAYER_PATH
  if (envRoot) return envRoot
  const candidates = [...ancestorCandidates(path.dirname(file)), ...ancestorCandidates(process.cwd())]
  return candidates.find((candidate) => {
    try {
      return existsSync(path.join(candidate, "openviking", "parse", "parsers", "code", "ast", "extractor.py"))
    } catch {
      return false
    }
  })
}

function ancestorCandidates(start: string) {
  const result: string[] = []
  let current = path.resolve(start)
  while (true) {
    result.push(path.join(current, "CookieLayer"))
    if (path.basename(current) === "CookieLayer") result.push(current)
    const parent = path.dirname(current)
    if (parent === current) return result
    current = parent
  }
}

export * as ContextIntel from "."
