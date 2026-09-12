import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import type { InstructionDomain, Source } from "./parser"
import { classifyTask, normalizeTaskDomains } from "./router"

export interface ResolveOptions {
  readonly cwd: string
  readonly prompt?: string
  readonly event?: string
  readonly toolName?: string
  readonly toolContext?: string
  readonly targetPaths?: readonly string[]
  readonly globalAgentsPaths?: readonly string[]
  readonly codexHome?: string
  readonly extraSources?: readonly Source[]
  /** When true, prefer ~/.codex/AGENTS.md routing semantics (Codex/Cursor curated). */
  readonly useCodexRouting?: boolean
}

export interface ResolvedSourceMeta {
  readonly filepath: string
  readonly reason: string
  readonly sha256: string
}

export interface ResolveResult {
  readonly sources: Source[]
  readonly omitted: string[]
  readonly repoRoot: string | null
  readonly routeContext: string
  readonly meta: ResolvedSourceMeta[]
}

const DEFAULT_GLOBAL_AGENTS_PATHS = [
  path.join(process.env.HOME ?? "", ".codex", "AGENTS.md"),
  path.join(process.env.HOME ?? "", ".config", "opencode", "AGENTS.md"),
]

const ROUTE_HEADINGS = ["## Context Routes", "## Context-Routed Files", "## Root File Routing"] as const
const ALWAYS_LOADED_HEADING = "## Always Loaded Files"
const TABLE_SEPARATOR_RE = /^:?-{3,}:?$/
const PATH_TOKEN_RE = /(?<path>(?:\.\.\/|\.\/|\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./@+=:-]+)/g
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

function existsDir(filepath: string) {
  try {
    return fs.statSync(filepath).isDirectory()
  } catch {
    return false
  }
}

function sha256Text(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

function readText(filepath: string) {
  try {
    return fs.readFileSync(filepath, "utf-8")
  } catch {
    return null
  }
}

function canonicalPath(filepath: string) {
  const resolved = path.resolve(filepath)
  try {
    return fs.realpathSync(resolved)
  } catch {
    return resolved
  }
}

function gitRoot(cwd: string): string | null {
  try {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      timeout: 2000,
    })
    if (result.status !== 0) return null
    const root = (result.stdout || "").trim()
    return root ? canonicalPath(root) : null
  } catch {
    return null
  }
}


function findStopRoot(cwd: string) {
  const git = gitRoot(cwd)
  if (git) return git
  let current = path.resolve(cwd)
  while (true) {
    if (existsFile(path.join(current, ".git")) || existsDir(path.join(current, ".git"))) return current
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

function splitMarkdownRow(line: string): string[] | null {
  const stripped = line.trim()
  if (!stripped.startsWith("|") || !stripped.endsWith("|")) return null
  return stripped
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim().replace(/^`+|`+$/g, ""))
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function sectionAfterHeading(text: string, heading: string): string | null {
  const pattern = new RegExp(`^${escapeRegExp(heading)}\\s*$`, "m")
  const match = pattern.exec(text)
  if (!match || match.index === undefined) return null
  const start = match.index + match[0].length
  const rest = text.slice(start)
  const next = /^(?:#{1,6}\s+\S.*|--- project-doc ---\s*)$/m.exec(rest)
  const end = next?.index !== undefined ? start + next.index : text.length
  return text.slice(start, end)
}

function normalizeHeader(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function columnIndex(headers: string[], ...names: string[]) {
  const accepted = new Set(names.map(normalizeHeader))
  for (let index = 0; index < headers.length; index++) {
    if (accepted.has(normalizeHeader(headers[index] ?? ""))) return index
  }
  return null
}

function routeFileColumn(headers: string[]) {
  const direct = columnIndex(headers, "file", "path", "file path", "owner")
  if (direct !== null) return direct
  const modern = headers.findIndex((header) => normalizeHeader(header).startsWith("owner under "))
  return modern < 0 ? null : modern
}

export function parseRouteTable(agentsText: string): Array<{ file: string; usage_context: string; holds: string }> {
  let section: string | null = null
  for (const heading of ROUTE_HEADINGS) {
    section = sectionAfterHeading(agentsText, heading)
    if (section) break
  }
  if (!section) return []
  const rows = section
    .split(/\r?\n/)
    .map(splitMarkdownRow)
    .filter((row): row is string[] => Boolean(row))
  if (rows.length < 2) return []
  const headers = rows[0] ?? []
  const separator = rows[1] ?? []
  if (!separator.every((cell) => TABLE_SEPARATOR_RE.test(cell.trim()))) return []
  const fileColumn = routeFileColumn(headers)
  const contextColumn = columnIndex(headers, "usage context", "context", "load before")
  const holdsColumn = columnIndex(headers, "holds", "contains", "preferences")
  if (fileColumn === null || contextColumn === null) return []
  const routes: Array<{ file: string; usage_context: string; holds: string }> = []
  for (const row of rows.slice(2)) {
    if (row.length !== headers.length) continue
    routes.push({
      file: row[fileColumn] ?? "",
      usage_context: row[contextColumn] ?? "",
      holds: holdsColumn !== null ? (row[holdsColumn] ?? "") : "",
    })
  }
  return routes
}

export function parseAlwaysLoaded(agentsText: string): string[] {
  const section = sectionAfterHeading(agentsText, ALWAYS_LOADED_HEADING)
  if (!section) return []
  const paths: string[] = []
  for (const line of section.split(/\r?\n/)) {
    const match = /@([^\s]+)/.exec(line)
    if (match?.[1]) paths.push(match[1])
  }
  return paths
}

const KNOWN_ROUTE_DOMAINS: Record<string, InstructionDomain> = {
  "PULL_REQUESTS.md": "pr",
  "GITHUB_COMMENTS.md": "pr",
  "VERIFICATION.md": "test",
  "GIT_WORKTREES.md": "git",
  "PRD_DELIVERY.md": "prd",
  "MACOS_CODEX_ENV.md": "env",
}

export const REPOSITORY_ROUTE_FILES: readonly string[] = Object.keys(KNOWN_ROUTE_DOMAINS)

export function resolveDeclaredRoutePath(codexHome: string, rawPath: string): string | null {
  const normalized = rawPath.trim().replaceAll("$CODEX_HOME", codexHome)
  if (!normalized || !/\.md$/i.test(normalized)) return null
  const resolvedHome = path.resolve(expandUser(codexHome))
  const resolved = path.resolve(resolvedHome, expandUser(normalized))
  if (!contains(resolvedHome, resolved)) return null
  return resolved
}

export function routeApplies(
  route: { file: string; usage_context?: string; holds?: string },
  contextText: string,
  explicitTaskDomains?: readonly InstructionDomain[],
): boolean {
  const routeDomain = KNOWN_ROUTE_DOMAINS[path.basename(route.file)]
  const routeDomains = routeDomain
    ? [routeDomain]
    : classifyTask([route.usage_context ?? "", route.holds ?? ""].join(" "))
  if (routeDomains.length === 0) return false
  const taskDomains =
    explicitTaskDomains === undefined ? classifyTask(contextText) : normalizeTaskDomains(explicitTaskDomains)
  if (taskDomains.length === 0) return false
  const task = new Set(taskDomains)
  return routeDomains.some((domain) => task.has(domain))
}

function extractPathMentions(text: string, cwd: string): string[] {
  const paths: string[] = []
  PATH_TOKEN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = PATH_TOKEN_RE.exec(text))) {
    const raw = (match.groups?.path ?? match[0] ?? "").replace(/^[`'"]+|[`'".),]+$/g, "")
    if (!raw || raw.startsWith("http")) continue
    const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw)
    paths.push(resolved)
  }
  return paths
}

function dedupePaths(paths: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of paths) {
    const resolved = canonicalPath(item)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    result.push(resolved)
  }
  return result
}

function requestTargetPaths(options: ResolveOptions, cwd: string) {
  const paths = [cwd]
  if (options.prompt) paths.push(...extractPathMentions(options.prompt, cwd))
  for (const raw of options.targetPaths ?? []) {
    const resolved = path.isAbsolute(raw) ? path.resolve(expandUser(raw)) : path.resolve(cwd, expandUser(raw))
    paths.push(resolved)
  }
  return dedupePaths(paths)
}

function routeContextForRequest(options: ResolveOptions, cwd: string) {
  const fragments = [options.prompt ?? "", options.event ?? "", options.toolName ?? "", options.toolContext ?? ""]
  fragments.push(...requestTargetPaths(options, cwd))
  return fragments.filter(Boolean).join(" ").toLowerCase()
}

function pathRelativeTo(root: string, target: string): string[] | null {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  if (!contains(resolvedRoot, resolvedTarget) && resolvedRoot !== resolvedTarget) return null
  if (resolvedRoot === resolvedTarget) return []
  return path.relative(resolvedRoot, resolvedTarget).split(path.sep).filter(Boolean)
}

function ignoredRepoScopePath(repoRoot: string, target: string) {
  const relative = pathRelativeTo(repoRoot, target)
  if (relative === null) return true
  if (relative.includes("target")) return true
  return relative.length >= 3 && relative[0] === ".agents" && relative[1] === "worktrees"
}

function agentsUpwardFromPath(repoRoot: string, target: string): string[] {
  if (ignoredRepoScopePath(repoRoot, target)) return []
  let directory = existsDir(target) ? path.resolve(target) : path.dirname(path.resolve(target))
  const result: string[] = []
  while (true) {
    if (ignoredRepoScopePath(repoRoot, directory)) break
    const candidate = path.join(directory, "AGENTS.md")
    if (existsFile(candidate)) result.push(path.resolve(candidate))
    if (path.resolve(directory) === path.resolve(repoRoot)) break
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return dedupePaths(result)
}

function repoAgentsFromStartingPoints(repoRoot: string, startingPoints: string[]) {
  const candidates: string[] = []
  for (const start of startingPoints) {
    candidates.push(...agentsUpwardFromPath(repoRoot, start))
  }
  const deduped = dedupePaths(candidates)
  return deduped.sort((a, b) => {
    const aParts = pathRelativeTo(repoRoot, a)?.length ?? 0
    const bParts = pathRelativeTo(repoRoot, b)?.length ?? 0
    return aParts - bParts
  })
}

function projectAgentsPathsShallowFirst(cwd: string) {
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

function pushSource(
  sources: Source[],
  meta: ResolvedSourceMeta[],
  seen: Set<string>,
  filepath: string,
  reason: string,
  order: { value: number },
) {
  const resolved = path.resolve(filepath)
  if (seen.has(resolved)) return true
  const content = readText(resolved)
  if (content === null) return false
  seen.add(resolved)
  sources.push({ filepath: resolved, content, order: order.value++ })
  meta.push({ filepath: resolved, reason, sha256: sha256Text(content) })
  return true
}

export function resolveRepositoryRoutes(
  cwd: string,
  taskDomains: readonly InstructionDomain[],
): Pick<ResolveResult, "repoRoot" | "sources" | "meta"> {
  const repoRoot = gitRoot(canonicalPath(expandUser(cwd)))
  if (!repoRoot) return { repoRoot: null, sources: [], meta: [] }
  const sources: Source[] = []
  const meta: ResolvedSourceMeta[] = []
  const seen = new Set<string>()
  const order = { value: 0 }
  for (const name of REPOSITORY_ROUTE_FILES) {
    const filepath = path.join(repoRoot, name)
    if (existsFile(filepath) && routeApplies({ file: name }, "", taskDomains)) {
      pushSource(sources, meta, seen, filepath, "repo-local routed override file", order)
    }
  }
  return { repoRoot, sources, meta }
}
/** Legacy v1 path list: first global AGENTS + shallow→deep project AGENTS. */
export function resolveSourcePaths(options: ResolveOptions) {
  const globalPaths = options.globalAgentsPaths?.length ? options.globalAgentsPaths : DEFAULT_GLOBAL_AGENTS_PATHS
  const paths: string[] = []
  const global = firstExistingGlobalPath(globalPaths)
  if (global) paths.push(global)
  for (const projectPath of projectAgentsPathsShallowFirst(canonicalPath(options.cwd))) {
    if (!paths.includes(projectPath)) paths.push(projectPath)
  }
  return paths
}

/**
 * Resolve instruction sources.
 *
 * When prompt/event/tool hints are present (or useCodexRouting), uses Codex-parity
 * routing: global source and selected route files, shallow-to-deep repo AGENTS,
 * then repo-local routed overrides.
 * Otherwise falls back to v1 global + walk-up AGENTS discovery.
 */
export function resolveSourcesDetailed(options: ResolveOptions): ResolveResult {
  const cwd = canonicalPath(expandUser(options.cwd))
  const useRouting =
    options.useCodexRouting === true ||
    Boolean(options.prompt?.trim()) ||
    Boolean(options.event?.trim()) ||
    Boolean(options.toolName?.trim()) ||
    Boolean(options.toolContext?.trim()) ||
    Boolean(options.targetPaths?.length)

  if (!useRouting) {
    const sources: Source[] = []
    const meta: ResolvedSourceMeta[] = []
    const omitted: string[] = []
    const seen = new Set<string>()
    const order = { value: 0 }
    for (const filepath of resolveSourcePaths(options)) {
      if (!pushSource(sources, meta, seen, filepath, "legacy walk-up", order)) omitted.push(filepath)
    }
    if (options.extraSources?.length) {
      for (const source of options.extraSources) {
        if (!source.content?.trim()) continue
        const filepath = path.resolve(source.filepath)
        if (seen.has(filepath)) continue
        seen.add(filepath)
        sources.push({ ...source, filepath, order: order.value++ })
        meta.push({ filepath, reason: "extra", sha256: sha256Text(source.content) })
      }
    }
    return {
      sources,
      omitted,
      repoRoot: gitRoot(cwd),
      routeContext: "",
      meta,
    }
  }

  const routeContext = routeContextForRequest(options, cwd)
  const codexHome = path.resolve(
    expandUser(options.codexHome || process.env.CODEX_HOME || path.join(process.env.HOME ?? "", ".codex")),
  )
  const sources: Source[] = []
  const meta: ResolvedSourceMeta[] = []
  const omitted: string[] = []
  const seen = new Set<string>()
  const order = { value: 0 }
  const targetPaths = requestTargetPaths(options, cwd)

  const taskDomains = classifyTask(routeContext)
  const repositoryRoutes = resolveRepositoryRoutes(cwd, taskDomains)
  const repo = repositoryRoutes.repoRoot

  const globalAgentsPath =
    firstExistingGlobalPath(options.globalAgentsPaths?.length ? options.globalAgentsPaths : [path.join(codexHome, "AGENTS.md")]) ??
    path.join(codexHome, "AGENTS.md")

  const globalText = readText(globalAgentsPath)
  if (globalText !== null) {
    pushSource(sources, meta, seen, globalAgentsPath, "global user instructions", order)
    for (const rawPath of parseAlwaysLoaded(globalText)) {
      const expanded = expandUser(rawPath.replaceAll("$CODEX_HOME", codexHome))
      const filepath = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(codexHome, expanded)
      if (!pushSource(sources, meta, seen, filepath, "global always-loaded file", order)) omitted.push(filepath)
    }
    for (const route of parseRouteTable(globalText)) {
      if (!routeApplies(route, routeContext, taskDomains)) continue
      const filepath = resolveDeclaredRoutePath(codexHome, route.file)
      if (!filepath) {
        omitted.push(route.file)
        continue
      }
      if (!pushSource(sources, meta, seen, filepath, `global routed file: ${route.usage_context}`, order)) omitted.push(filepath)
    }
  } else {
    omitted.push(globalAgentsPath)
  }

  if (repo) {
    for (const agents of repoAgentsFromStartingPoints(repo, targetPaths)) {
      pushSource(sources, meta, seen, agents, "repo scoped AGENTS upward chain", order)
    }
  }

  for (const source of repositoryRoutes.sources) {
    if (seen.has(source.filepath)) continue
    seen.add(source.filepath)
    sources.push({ ...source, order: order.value++ })
    const sourceMeta = repositoryRoutes.meta.find((item) => item.filepath === source.filepath)
    if (sourceMeta) meta.push(sourceMeta)
  }

  if (options.extraSources?.length) {
    for (const source of options.extraSources) {
      if (!source.content?.trim()) continue
      const filepath = path.resolve(source.filepath)
      if (seen.has(filepath)) continue
      seen.add(filepath)
      sources.push({ ...source, filepath, order: order.value++ })
      meta.push({ filepath, reason: "extra", sha256: sha256Text(source.content) })
    }
  }

  return { sources, omitted, repoRoot: repo, routeContext, meta }
}

export function resolveSources(options: ResolveOptions): Source[] {
  return resolveSourcesDetailed(options).sources
}
