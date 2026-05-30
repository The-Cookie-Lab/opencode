import { PlanExitTool } from "./plan"
import { Session } from "@/session/session"
import { QuestionTool } from "./question"
import { ShellTool } from "./shell"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import * as Tool from "./tool"
import { Config } from "@/config/config"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider"
import { Schema } from "effect"
import z from "zod"
import { Plugin } from "../plugin"
import { Provider } from "@/provider/provider"
import { ProviderID, type ModelID } from "../provider/schema"
import { WebSearchTool } from "./websearch"
import { RepoCloneTool } from "./repo_clone"
import { RepoOverviewTool } from "./repo_overview"
import { ProjectDossierTool } from "./project_dossier"
import { ViewOutlineTool } from "./view_outline"
import { SemanticSearchTool } from "./semantic_search"
import { RepositoryCache } from "@/reference/repository-cache"
import * as Log from "@opencode-ai/core/util/log"
import { LspTool } from "./lsp"
import * as Truncate from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { RgTool } from "./rg"
import { WritePatchTool } from "./write_patch"
import { Glob } from "@opencode-ai/core/util/glob"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "../file/ripgrep"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "../session/instruction"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Bus } from "../bus"
import { Agent } from "../agent/agent"
import { Git } from "@/git"
import { Skill } from "../skill"
import { Permission } from "@/permission"
import { Reference } from "@/reference/reference"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ToolJsonSchema } from "./json-schema"
import { ContextIntel } from "@/context-intel"

const log = Log.create({ service: "tool.registry" })
const compactDescriptions = {
  [InvalidTool.id]: "Never call.",
  [QuestionTool.id]:
    "Ask user. Required: questions[{header, question, options?}]. Only when blocked or unclear.",
  [ShellTool.id]:
    "Run shell command. For git/npm/docker/builds/tests. NOT for file ops. Required: description (5-10 word summary of what the command does — e.g. 'List files in current directory'), command. Optional: timeout (ms), workdir (use instead of cd).",
  [ReadTool.id]:
    "Read file or list dir. Required: filePath (absolute). Optional: offset (start line, 1-indexed), limit (max lines, default 2000). Returns numbered lines. Reads images/PDFs.",
  [RgTool.id]:
    "Ripgrep search/list. Required: pattern (regex/glob). Optional: path (root, default cwd), mode=content|files, glob (file filter), literal (no regex), ignoreCase, hidden (show dotfiles), max (default 100).",
  [WritePatchTool.id]:
    "Exact string replace in file. Required: path, old (text to find; empty creates file), new (replacement). Optional: count (expected matches, default 1). Fails on count mismatch.",
  [TaskTool.id]:
    "Launch subagent. Required: description (3-5 words), prompt (full task), subagent_type. Optional: background (async), task_id (resume session).",
  [WebFetchTool.id]:
    "Fetch URL. Required: url. Optional: format=text|markdown|html, timeout (sec, max 120).",
  [TodoWriteTool.id]:
    "Replace todos. Required: todos[{content, status, priority}]. Status: pending|in_progress|completed|cancelled. Priority: high|medium|low. Max one in_progress. Always submit full list.",
  [WebSearchTool.id]:
    "Web search. Required: query. Optional: numResults (default 8), livecrawl=fallback|preferred, type=auto|fast|deep, contextMaxChars (default 10000).",
  [RepoCloneTool.id]:
    "Clone repo into cache. Required: repository (git URL or owner/repo). Optional: refresh, branch. Returns local path.",
  [RepoOverviewTool.id]:
    "Summarize repo structure. Required: repository or path. Optional: depth (default 3). Reports ecosystems, entrypoints, deps.",
  [ProjectDossierTool.id]:
    "Repo dossier. No params. Reports cwd, git, package mgr, scripts, entrypoints, deps.",
  [ViewOutlineTool.id]:
    "Source file outline. Required: path. Optional: maxSymbols (default 120), includePrivate (default false). Returns [line, kind, name, signature].",
  [SemanticSearchTool.id]:
    "Semantic codebase search. Required: query. Optional: path (default cwd), max (default 10), mode=auto|lexical|semantic. Returns scored spans.",
  [SkillTool.id]:
    "Load skill instructions. Required: name (exact name from available skills list).",
  [LspTool.id]:
    "LSP code intel. Required: operation (goToDefinition|findReferences|hover|documentSymbol|workspaceSymbol|goToImplementation|prepareCallHierarchy|incomingCalls|outgoingCalls), filePath, line, character. Optional: query.",
  [PlanExitTool.id]: "Exit plan mode when ready.",
  [GlobTool.id]:
    "Find files by glob. Required: pattern. Optional: path (default cwd). Returns absolute paths.",
  [GrepTool.id]:
    "Search file contents by regex. Required: pattern. Optional: path (default cwd), include (file filter).",
  [EditTool.id]:
    "Edit file by string replace (diff). Required: filePath, oldString, newString. Optional: replaceAll (default false).",
  [WriteTool.id]:
    "Write/overwrite file. Required: filePath, content. Creates parent dirs.",
  [ApplyPatchTool.id]:
    "Apply unified diff patch. Required: patchText.",
} satisfies Record<string, string>

export function webSearchEnabled(providerID: ProviderID, flags = { exa: false, parallel: false }) {
  return providerID === ProviderID.opencode || flags.exa || flags.parallel
}

type TaskDef = Tool.InferDef<typeof TaskTool>
type ReadDef = Tool.InferDef<typeof ReadTool>

type State = {
  custom: Tool.Def[]
  builtin: Tool.Def[]
  task: TaskDef
  read: ReadDef
}

export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>
  readonly tools: (model: { providerID: ProviderID; modelID: ModelID; agent: Agent.Info }) => Effect.Effect<Tool.Def[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolRegistry") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Config.Service
  | Plugin.Service
  | Question.Service
  | Todo.Service
  | Agent.Service
  | Skill.Service
  | Session.Service
  | BackgroundJob.Service
  | Provider.Service
  | Git.Service
  | RepositoryCache.Service
  | Reference.Service
  | LSP.Service
  | Instruction.Service
  | AppFileSystem.Service
  | Bus.Service
  | HttpClient.HttpClient
  | ChildProcessSpawner
  | Ripgrep.Service
  | Format.Service
  | Truncate.Service
  | RuntimeFlags.Service
  | ContextIntel.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const agents = yield* Agent.Service
    const skill = yield* Skill.Service
    const truncate = yield* Truncate.Service
    const flags = yield* RuntimeFlags.Service

    const invalid = yield* InvalidTool
    const task = yield* TaskTool
    const read = yield* ReadTool
    const question = yield* QuestionTool
    const todo = yield* TodoWriteTool
    const lsptool = yield* LspTool
    const plan = yield* PlanExitTool
    const webfetch = yield* WebFetchTool
    const websearch = yield* WebSearchTool
    const repoClone = yield* RepoCloneTool
    const repoOverview = yield* RepoOverviewTool
    const projectDossier = yield* ProjectDossierTool
    const viewOutline = yield* ViewOutlineTool
    const semanticSearch = yield* SemanticSearchTool
    const shell = yield* ShellTool
    const globtool = yield* GlobTool
    const writetool = yield* WriteTool
    const edit = yield* EditTool
    const greptool = yield* GrepTool
    const patchtool = yield* ApplyPatchTool
    const rgtool = yield* RgTool
    const writepatch = yield* WritePatchTool
    const skilltool = yield* SkillTool
    const agent = yield* Agent.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolRegistry.state")(function* (ctx) {
        const custom: Tool.Def[] = []

        function fromPlugin(id: string, def: ToolDefinition): Tool.Def {
          // Plugin tools still expose Zod args publicly; keep that compatibility
          // boxed at the registry boundary and give the LLM the original JSON Schema.
          // Normalize missing args to `{}` once — pre-1.14.49 the code was
          // `z.object(def.args)` and Zod silently tolerated undefined (#27451, #27630).
          const args = def.args ?? {}
          const entries = Object.entries(args)
          const allZod = entries.every((entry) => isZodType(entry[1]))
          const zodParams = allZod ? z.object(args) : undefined
          const jsonSchema = zodParams ? zodJsonSchema(zodParams) : legacyJsonSchema(entries)
          const parameters = zodParams
            ? Schema.declare<unknown>((u): u is unknown => zodParams.safeParse(u).success)
            : Schema.Unknown
          return {
            id,
            parameters,
            jsonSchema,
            description: def.description,
            execute: (args, toolCtx) =>
              Effect.gen(function* () {
                // Bridge the host's Effect-based `ask` into a Promise-returning
                // function for the plugin to make sure context persists
                const bridge = yield* EffectBridge.make()
                const pluginCtx: PluginToolContext = {
                  ...toolCtx,
                  ask: (req) => bridge.promise(toolCtx.ask(req)),
                  directory: ctx.directory,
                  worktree: ctx.worktree,
                }
                const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
                const output = typeof result === "string" ? result : result.output
                const metadata = typeof result === "string" ? {} : (result.metadata ?? {})
                const attachments = typeof result === "string" ? undefined : result.attachments
                const info = yield* agent.get(toolCtx.agent)
                const out = yield* truncate.output(output, {}, info)
                return {
                  title: typeof result === "string" ? "" : (result.title ?? ""),
                  output: out.truncated ? out.content : output,
                  attachments,
                  metadata: {
                    ...metadata,
                    truncated: out.truncated,
                    ...(out.truncated && { outputPath: out.outputPath }),
                  },
                }
              }).pipe(
                Effect.withSpan("Tool.execute", {
                  attributes: {
                    "tool.name": id,
                    "session.id": toolCtx.sessionID,
                    "message.id": toolCtx.messageID,
                    ...(toolCtx.callID ? { "tool.call_id": toolCtx.callID } : {}),
                  },
                }),
              ),
          }
        }

        const dirs = yield* config.directories()
        const matches = dirs.flatMap((dir) =>
          Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
        )
        if (matches.length) yield* config.waitForDependencies()
        for (const match of matches) {
          const namespace = path.basename(match, path.extname(match))
          // `match` is an absolute filesystem path from `Glob.scanSync(..., { absolute: true })`.
          // Import it as `file://` so Node on Windows accepts the dynamic import.
          const mod = yield* Effect.promise(() => import(pathToFileURL(match).href))
          for (const [id, def] of Object.entries(mod)) {
            if (!isPluginTool(def)) continue
            custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
          }
        }

        const plugins = yield* plugin.list()
        for (const p of plugins) {
          for (const [id, def] of Object.entries(p.tool ?? {})) {
            custom.push(fromPlugin(id, def))
          }
        }

        yield* config.get()
        const questionEnabled = ["app", "cli", "desktop"].includes(flags.client) || flags.enableQuestionTool
        const contextToolsEnabled = flags.experimentalMacroTools || flags.experimentalContextTools
        const semanticSearchEnabled = flags.experimentalMacroTools || flags.experimentalSemanticSearch

        const tool = yield* Effect.all({
          invalid: Tool.init(invalid),
          shell: Tool.init(shell),
          read: Tool.init(read),
          glob: Tool.init(globtool),
          grep: Tool.init(greptool),
          edit: Tool.init(edit),
          write: Tool.init(writetool),
          task: Tool.init(task),
          fetch: Tool.init(webfetch),
          todo: Tool.init(todo),
          search: Tool.init(websearch),
          repo_clone: Tool.init(repoClone),
          repo_overview: Tool.init(repoOverview),
          project_dossier: Tool.init(projectDossier),
          view_outline: Tool.init(viewOutline),
          semantic_search: Tool.init(semanticSearch),
          skill: Tool.init(skilltool),
          patch: Tool.init(patchtool),
          rg: Tool.init(rgtool),
          write_patch: Tool.init(writepatch),
          question: Tool.init(question),
          lsp: Tool.init(lsptool),
          plan: Tool.init(plan),
        })

        return {
          custom,
          builtin: flags.experimentalCompactTools
            ? [
                tool.invalid,
                ...(questionEnabled ? [tool.question] : []),
                tool.shell,
                ...(contextToolsEnabled ? [tool.project_dossier, tool.view_outline] : []),
                ...(semanticSearchEnabled ? [tool.semantic_search] : []),
                tool.read,
                tool.rg,
                tool.write_patch,
                tool.task,
                tool.fetch,
                tool.todo,
                tool.search,
                ...(flags.experimentalScout ? [tool.repo_clone, tool.repo_overview] : []),
                tool.skill,
                ...(flags.experimentalLspTool ? [tool.lsp] : []),
                ...(flags.experimentalPlanMode && flags.client === "cli" ? [tool.plan] : []),
              ]
            : [
                tool.invalid,
                ...(questionEnabled ? [tool.question] : []),
                tool.shell,
                tool.read,
                ...(contextToolsEnabled ? [tool.project_dossier, tool.view_outline] : []),
                ...(semanticSearchEnabled ? [tool.semantic_search] : []),
                tool.glob,
                tool.grep,
                tool.edit,
                tool.write,
                tool.task,
                tool.fetch,
                tool.todo,
                tool.search,
                ...(flags.experimentalScout ? [tool.repo_clone, tool.repo_overview] : []),
                tool.skill,
                tool.patch,
                ...(flags.experimentalLspTool ? [tool.lsp] : []),
                ...(flags.experimentalPlanMode && flags.client === "cli" ? [tool.plan] : []),
              ],
          task: tool.task,
          read: tool.read,
        }
      }),
    )

    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
      const s = yield* InstanceState.get(state)
      return [...s.builtin, ...s.custom] as Tool.Def[]
    })

    const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
      return (yield* all()).map((tool) => tool.id)
    })

    const describeSkill = Effect.fn("ToolRegistry.describeSkill")(function* (agent: Agent.Info) {
      const list = yield* skill.available(agent)
      if (list.length === 0) return "No skills are currently available."
      if (flags.experimentalCompactTools) return `skills: ${Skill.fmt(list, { verbose: false }).replaceAll("\n", "; ")}`
      return [
        "Load a specialized skill that provides domain-specific instructions and workflows.",
        "",
        "When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
        "",
        "The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.",
        "",
        'Tool output includes a `<skill_content name="...">` block with the loaded content.',
        "",
        "The following skills provide specialized sets of instructions for particular tasks",
        "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
        "",
        Skill.fmt(list, { verbose: false }),
      ].join("\n")
    })

    const describeTask = Effect.fn("ToolRegistry.describeTask")(function* (agent: Agent.Info) {
      const items = (yield* agents.list()).filter((item) => item.mode !== "primary")
      const filtered = items.filter(
        (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
      )
      const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
      const description = list
        .map(
          (item) =>
            `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
        )
        .join("\n")
      if (flags.experimentalCompactTools) {
        return `agents: ${list.map((item) => `${item.name}=${item.description ?? "manual-only"}`).join("; ")}`
      }
      return ["Available agent types and the tools they have access to:", description].join("\n")
    })

    const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
      const s = yield* InstanceState.get(state)
      const builtins = new Set<Tool.Def>(s.builtin)
      const filtered = ([...s.builtin, ...s.custom] as Tool.Def[]).filter((tool) => {
        if (tool.id === WebSearchTool.id) {
          return webSearchEnabled(input.providerID, { exa: flags.enableExa, parallel: flags.enableParallel })
        }

        const usePatch =
          input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
        if (tool.id === ApplyPatchTool.id) return usePatch
        if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch

        return true
      })

      return yield* Effect.forEach(
        filtered,
        Effect.fnUntraced(function* (tool: Tool.Def) {
          using _ = log.time(tool.id)
          const output = {
            description: tool.description,
            parameters: tool.parameters,
            jsonSchema: tool.jsonSchema,
          }
          yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
          const jsonSchema =
            output.parameters === tool.parameters || output.jsonSchema !== tool.jsonSchema
              ? output.jsonSchema
              : undefined
          const compact = (flags.experimentalCompactTools || flags.experimentalMacroTools) && builtins.has(tool)
          return {
            id: tool.id,
            description: [
              compactDescriptions[tool.id] ?? output.description,
              tool.id === TaskTool.id ? yield* describeTask(input.agent) : undefined,
              tool.id === SkillTool.id ? yield* describeSkill(input.agent) : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
            parameters: output.parameters,
            jsonSchema: compact
              ? compactJsonSchema(jsonSchema ?? ToolJsonSchema.fromSchema(output.parameters as Schema.Top))
              : jsonSchema,
            execute: tool.execute,
            formatValidationError: tool.formatValidationError,
          }
        }),
        { concurrency: "unbounded" },
      )
    })

    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* InstanceState.get(state)
      return { task: s.task, read: s.read }
    })

    return Service.of({ ids, all, named, tools })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer
    .pipe(
      Layer.provide(Config.defaultLayer),
      Layer.provide(Plugin.defaultLayer),
      Layer.provide(Question.defaultLayer),
      Layer.provide(Todo.defaultLayer),
      Layer.provide(Skill.defaultLayer),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(Session.defaultLayer),
      Layer.provide(BackgroundJob.defaultLayer),
      Layer.provide(Provider.defaultLayer),
      Layer.provide(Layer.mergeAll(Git.defaultLayer, RepositoryCache.defaultLayer)),
      Layer.provide(Reference.defaultLayer),
      Layer.provide(LSP.defaultLayer),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(AppFileSystem.defaultLayer),
      Layer.provide(Bus.layer),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Format.defaultLayer),
      Layer.provide(CrossSpawnSpawner.defaultLayer),
      Layer.provide(Ripgrep.defaultLayer),
      Layer.provide(Truncate.defaultLayer),
    )
    .pipe(Layer.provide(ContextIntel.defaultLayer))
    .pipe(Layer.provide(RuntimeFlags.defaultLayer)),
)

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

function compactJsonSchema(value: JSONSchema7): JSONSchema7 {
  if (typeof value === "boolean") return value
  return stripSchema(value) as JSONSchema7
}

function stripSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripSchema(item))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, parent]) => {
        if (key === "$schema" || key === "title") return false
        // Keep the description field for the top-level tool description (tool identity)
        // and for the `description` parameter itself so local LLMs see
        // guidance/examples inline.
        if (key === "description" && typeof parent === "string") return true
        return true
      })
      .map(([key, item]) => [key, stripSchema(item)]),
  )
}

function isPluginTool(value: unknown): value is ToolDefinition {
  return typeof value === "object" && value !== null && "args" in value && "description" in value && "execute" in value
}

function isJsonSchemaDefinition(value: unknown): value is JSONSchema7Definition {
  return typeof value === "boolean" || (typeof value === "object" && value !== null && !Array.isArray(value))
}

function legacyJsonSchema(entries: [string, unknown][]): JSONSchema7 {
  const properties = Object.fromEntries(
    entries.filter((entry): entry is [string, JSONSchema7Definition] => isJsonSchemaDefinition(entry[1])),
  )
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
  }
}

function zodJsonSchema(schema: z.ZodType): JSONSchema7 {
  const result = normalizeZodJsonSchema(z.toJSONSchema(schema, { io: "input", metadata: zodMetadataRegistry(schema) }))
  if (!isJsonSchemaObject(result)) throw new Error("plugin tool Zod schema produced a non-object JSON Schema")
  const { $defs, ...rest } = result
  return (
    $defs && isJsonSchemaObject($defs) ? { ...rest, definitions: $defs as JSONSchema7["definitions"] } : rest
  ) as JSONSchema7
}

function zodMetadataRegistry(schema: z.ZodType) {
  const registry = z.registry<Record<string, unknown>>()
  const seen = new WeakSet<object>()
  const collect = (value: unknown) => {
    if (typeof value !== "object" || value === null) return
    if (seen.has(value)) return
    seen.add(value)

    if (isZodType(value)) {
      const metadata = typeof value.meta === "function" ? value.meta() : undefined
      const description = typeof value.description === "string" ? value.description : undefined
      const merged = {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        ...(description ? { description } : {}),
      }
      if (Object.keys(merged).length) registry.add(value, merged)
      collect(value._zod.def)
      return
    }

    for (const item of Object.values(value)) collect(item)
  }
  collect(schema)
  return registry
}

function normalizeZodJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeZodJsonSchema(item))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) =>
        (entry[0] === "exclusiveMaximum" || entry[0] === "exclusiveMinimum") && typeof entry[1] === "boolean"
          ? false
          : true,
      )
      .map(([key, item]) => [key, normalizeZodJsonSchema(item)]),
  )
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export * as ToolRegistry from "./registry"
