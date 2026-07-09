import fs from "node:fs"
import path from "node:path"
import type { Source } from "./parser"

export interface ResolveOptions {
  readonly cwd: string
  readonly globalAgentsPaths?: readonly string[]
  readonly extraSources?: readonly Source[]
}

const DEFAULT_GLOBAL_AGENTS_PATHS = [
  path.join(process.env.HOME ?? "", ".codex", "AGENTS.md"),
  path.join(process.env.HOME ?? "", ".config", "opencode", "AGENTS.md"),
]

function expandUser(value: string) {
  if (value.startsWith("~/")) return path.join(process.env.HOME ?? "", value.slice(2))
  return value
}

function existsFile(filepath: string) {
  try {
    return fs.statSync(filepath).isFile()
  } catch {
    return false
  }
}

function findStopRoot(cwd: string) {
  let current = path.resolve(cwd)
  while (true) {
    if (existsFile(path.join(current, ".git"))) return current
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(cwd)
    current = parent
  }
}

function contains(parent: string, child: string) {
  const resolvedParent = path.resolve(parent)
  const resolvedChild = path.resolve(child)
  return resolvedChild === resolvedParent || resolvedChild.startsWith(resolvedParent + path.sep)
}

function projectAgentsPaths(cwd: string) {
  const stop = findStopRoot(cwd)
  const dirs: string[] = []
  let current = path.resolve(cwd)

  while (true) {
    dirs.push(current)
    if (path.resolve(current) === path.resolve(stop)) break
    const parent = path.dirname(current)
    if (parent === current) break
    if (!contains(stop, parent) && parent !== stop) break
    current = parent
  }

  const paths: string[] = []
  for (const dir of dirs.reverse()) {
    const agents = path.join(dir, "AGENTS.md")
    if (existsFile(agents)) paths.push(path.resolve(agents))
  }
  return paths
}

function firstExistingGlobalPath(paths: readonly string[]) {
  for (const raw of paths) {
    const filepath = path.resolve(expandUser(raw))
    if (existsFile(filepath)) return filepath
  }
  return undefined
}

export function resolveSourcePaths(options: ResolveOptions) {
  const globalPaths = options.globalAgentsPaths?.length
    ? options.globalAgentsPaths
    : DEFAULT_GLOBAL_AGENTS_PATHS
  const paths: string[] = []
  const global = firstExistingGlobalPath(globalPaths)
  if (global) paths.push(global)
  for (const projectPath of projectAgentsPaths(options.cwd)) {
    if (!paths.includes(projectPath)) paths.push(projectPath)
  }
  return paths
}

export function resolveSources(options: ResolveOptions): Source[] {
  const sources: Source[] = []
  let order = 0
  for (const filepath of resolveSourcePaths(options)) {
    sources.push({
      filepath,
      content: fs.readFileSync(filepath, "utf-8"),
      order: order++,
    })
  }
  if (options.extraSources?.length) {
    for (const source of options.extraSources) {
      if (!source.content?.trim()) continue
      sources.push({ ...source, order: order++ })
    }
  }
  return sources
}
