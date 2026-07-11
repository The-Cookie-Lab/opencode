#!/usr/bin/env bun
import { renderInstructionRequest, resolveSourcesDetailed, suppressPatterns, type SessionProfile } from "../src/index"

interface CliArgs {
  command: string
  cwd: string
  prompt: string
  mode: "raw" | "curated"
  globalAgents: string[]
  json: boolean
  delta: boolean
  event: string
  toolName: string
  toolContext: string
}

function usage() {
  process.stderr.write(
    [
      "usage:",
      "  instruction-cli.ts render [--cwd PATH] [--prompt TEXT] [--mode curated|raw] [--delta] [--event NAME] [--tool-name NAME] [--tool-context TEXT] [--global-agents PATH]... [--json]",
      "  instruction-cli.ts resolve-sources [--cwd PATH] [--prompt TEXT] [--event NAME] [--tool-name NAME] [--tool-context TEXT] [--global-agents PATH]... [--json]",
      "  instruction-cli.ts suppress-patterns [--global-agents PATH] [--json]",
      "  instruction-cli.ts doctor-smoke [--cwd PATH] [--json]",
    ].join("\n") + "\n",
  )
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2)
  const command = args[0] ?? ""
  let cwd = process.cwd()
  let prompt = ""
  let mode: "raw" | "curated" = "curated"
  const globalAgents: string[] = []
  let json = false
  let delta = false
  let event = ""
  let toolName = ""
  let toolContext = ""

  for (let index = 1; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--json") {
      json = true
      continue
    }
    if (arg === "--delta") {
      delta = true
      continue
    }
    if (arg === "--cwd" && args[index + 1]) {
      cwd = args[++index]
      continue
    }
    if (arg === "--prompt" && args[index + 1] !== undefined) {
      prompt = args[++index]
      continue
    }
    if (arg === "--mode" && args[index + 1]) {
      mode = args[++index] === "raw" ? "raw" : "curated"
      continue
    }
    if (arg === "--event" && args[index + 1]) {
      event = args[++index]
      continue
    }
    if (arg === "--tool-name" && args[index + 1]) {
      toolName = args[++index]
      continue
    }
    if (arg === "--tool-context" && args[index + 1]) {
      toolContext = args[++index]
      continue
    }
    if (arg === "--global-agents" && args[index + 1]) {
      globalAgents.push(args[++index])
      continue
    }
  }

  return { command, cwd, prompt, mode, globalAgents, json, delta, event, toolName, toolContext }
}

function readStdinJson<T>() {
  const raw = Bun.stdin.text()
  return raw.then((text) => {
    if (!text.trim()) return null
    return JSON.parse(text) as T
  })
}

async function main() {
  const args = parseArgs(process.argv)
  if (!args.command || args.command === "--help" || args.command === "-h") {
    usage()
    process.exit(args.command ? 0 : 1)
  }

  if (args.command === "render") {
    const stdin = await readStdinJson<Record<string, unknown>>()
    const previousProfile =
      (stdin?.previous_profile as SessionProfile | undefined) ??
      (stdin?.previousProfile as SessionProfile | undefined) ??
      null
    const request = {
      mode: (stdin?.mode as "raw" | "curated" | undefined) ?? args.mode,
      cwd: String(stdin?.cwd ?? args.cwd),
      prompt: String(stdin?.prompt ?? args.prompt ?? ""),
      event: String(stdin?.event ?? args.event ?? ""),
      toolName: String(stdin?.tool_name ?? stdin?.toolName ?? args.toolName ?? ""),
      toolContext: String(stdin?.tool_context ?? stdin?.toolContext ?? args.toolContext ?? ""),
      targetPaths: Array.isArray(stdin?.target_paths)
        ? (stdin.target_paths as string[])
        : Array.isArray(stdin?.targetPaths)
          ? (stdin.targetPaths as string[])
          : undefined,
      globalAgentsPaths:
        (Array.isArray(stdin?.global_agents_paths) ? stdin?.global_agents_paths : undefined) ??
        (Array.isArray(stdin?.globalAgentsPaths) ? stdin?.globalAgentsPaths : undefined) ??
        (args.globalAgents.length ? args.globalAgents : undefined),
      client: typeof stdin?.client === "string" ? stdin.client : undefined,
      sources: Array.isArray(stdin?.sources) ? (stdin.sources as never) : undefined,
      delta: Boolean(stdin?.delta ?? args.delta),
      previousProfile,
      useCodexRouting: stdin?.use_codex_routing === true || stdin?.useCodexRouting === true,
    }
    const response = renderInstructionRequest(request)
    const payload = {
      blocks: response.blocks,
      telemetry: response.telemetry,
      source_paths: response.source_paths,
      update: response.update ?? "snapshot",
      profile: response.profile ?? null,
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    return
  }

  if (args.command === "resolve-sources") {
    const stdin = await readStdinJson<Record<string, unknown>>()
    const result = resolveSourcesDetailed({
      cwd: String(stdin?.cwd ?? args.cwd),
      prompt: String(stdin?.prompt ?? args.prompt ?? ""),
      event: String(stdin?.event ?? args.event ?? ""),
      toolName: String(stdin?.tool_name ?? stdin?.toolName ?? args.toolName ?? ""),
      toolContext: String(stdin?.tool_context ?? stdin?.toolContext ?? args.toolContext ?? ""),
      targetPaths: Array.isArray(stdin?.target_paths)
        ? (stdin.target_paths as string[])
        : Array.isArray(stdin?.targetPaths)
          ? (stdin.targetPaths as string[])
          : undefined,
      globalAgentsPaths:
        (Array.isArray(stdin?.global_agents_paths) ? (stdin.global_agents_paths as string[]) : undefined) ??
        (Array.isArray(stdin?.globalAgentsPaths) ? (stdin.globalAgentsPaths as string[]) : undefined) ??
        (args.globalAgents.length ? args.globalAgents : undefined),
      useCodexRouting: true,
    })
    const payload = {
      source_paths: result.sources.map((source) => source.filepath),
      omitted: result.omitted,
      repo_root: result.repoRoot,
      route_context: result.routeContext,
      meta: result.meta,
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    return
  }

  if (args.command === "suppress-patterns") {
    const globalAgentsPath = args.globalAgents[0]
    const patterns = suppressPatterns(globalAgentsPath ? { globalAgentsPath } : undefined)
    const payload = { patterns }
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    return
  }

  if (args.command === "doctor-smoke") {
    const response = renderInstructionRequest({ cwd: args.cwd, mode: "curated", client: "cursor" })
    const payload = {
      ok: response.blocks.length > 0,
      source_paths: response.source_paths,
      injection_hash: response.telemetry?.injectionHash ?? null,
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    process.exit(payload.ok ? 0 : 1)
  }

  usage()
  process.exit(1)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
