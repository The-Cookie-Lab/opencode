import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  parseAlwaysLoaded,
  parseRouteTable,
  resolveDeclaredRoutePath,
  resolveRepositoryRoutes,
  resolveSourcesDetailed,
  routeApplies,
} from "../src/resolve-sources"
import { profileHash, renderWithDelta, sourcesToSession } from "../src/session-profile"
import { renderInstructionRequest } from "../src/index"
const activationFixtures = JSON.parse(
  fs.readFileSync(new URL("./route-activation-fixtures.json", import.meta.url), "utf8"),
) as Array<{
  name: string
  route: { file: string; usage_context: string; holds: string }
  prompt: string
  expected: boolean
}>
describe("resolve-sources v2 routing", () => {
  test("parses always-loaded and route tables", () => {
    const agents = [
      "## Always Loaded Files",
      "- @$CODEX_HOME/always.md",
      "",
      "## Context-Routed Files",
      "| File | Usage Context | Holds |",
      "| --- | --- | --- |",
      "| PULL_REQUESTS.md | PR / merge / review | PR policy |",
      "| SDL_MCP.md | SDL / indexed | SDL policy |",
    ].join("\n")
    expect(parseAlwaysLoaded(agents)).toEqual(["$CODEX_HOME/always.md"])
    const routes = parseRouteTable(agents)
    expect(routes.map((route) => route.file)).toEqual(["PULL_REQUESTS.md", "SDL_MCP.md"])
  })

  test("routeApplies follows the shared activation fixtures", () => {
    for (const fixture of activationFixtures) {
      expect(routeApplies(fixture.route, fixture.prompt), fixture.name).toBe(fixture.expected)
    }
    expect(routeApplies({ file: "MACOS_CODEX_ENV.md" }, "configure launchctl")).toBe(true)
  })
  test("uses the shared classifier for unknown routes and rejects unsafe declarations", () => {
    expect(routeApplies({ file: "TEAM_NOTES.md", usage_context: "documentation", holds: "guide" }, "update docs")).toBe(
      true,
    )
    expect(routeApplies({ file: "TEAM_NOTES.md", usage_context: "SDL / indexed", holds: "SDL policy" }, "indexed SDL")).toBe(
      false,
    )
    expect(resolveDeclaredRoutePath("/tmp/codex", "PULL_REQUESTS.md")).toBe(
      path.resolve("/tmp/codex", "PULL_REQUESTS.md"),
    )
    expect(resolveDeclaredRoutePath("/tmp/codex", "../PULL_REQUESTS.md")).toBe(null)
    expect(resolveDeclaredRoutePath("/tmp/codex", "/tmp/outside/PULL_REQUESTS.md")).toBe(null)
    expect(resolveDeclaredRoutePath("/tmp/codex", "notes.txt")).toBe(null)
  })

  test("interleaves each owner scope with the routes it declares", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cat-order-"))
    try {
      const codexHome = path.join(root, "codex")
      const repo = path.join(root, "repo")
      const nested = path.join(repo, "nested")
      fs.mkdirSync(codexHome, { recursive: true })
      fs.mkdirSync(nested, { recursive: true })
      expect(spawnSync("git", ["init"], { cwd: repo, encoding: "utf-8" }).status).toBe(0)
      const resolvedRepo = fs.realpathSync(repo)
      fs.writeFileSync(path.join(codexHome, "AGENTS.md"), "global agents")
      fs.writeFileSync(path.join(repo, "AGENTS.md"), "root repo agents")
      fs.writeFileSync(path.join(nested, "AGENTS.md"), "nested repo agents")
      fs.writeFileSync(path.join(repo, "GIT_WORKTREES.md"), "git override")

      const result = resolveSourcesDetailed({
        cwd: nested,
        prompt: "implement the branch change",
        codexHome,
        useCodexRouting: true,
      })

      expect(result.sources.map((source) => source.filepath)).toEqual([
        path.join(codexHome, "AGENTS.md"),
        path.join(resolvedRepo, "AGENTS.md"),
        path.join(resolvedRepo, "GIT_WORKTREES.md"),
        path.join(resolvedRepo, "nested", "AGENTS.md"),
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("keeps conventional route files a repository-root convention", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cat-nested-convention-"))
    try {
      const codexHome = path.join(root, "codex")
      const repo = path.join(root, "repo")
      const nested = path.join(repo, "nested")
      fs.mkdirSync(codexHome, { recursive: true })
      fs.mkdirSync(nested, { recursive: true })
      expect(spawnSync("git", ["init"], { cwd: repo, encoding: "utf-8" }).status).toBe(0)
      const resolvedRepo = fs.realpathSync(repo)
      fs.writeFileSync(path.join(codexHome, "AGENTS.md"), "global agents")
      fs.writeFileSync(path.join(repo, "AGENTS.md"), "root repo agents")
      fs.writeFileSync(path.join(nested, "AGENTS.md"), "nested repo agents")
      fs.writeFileSync(path.join(nested, "VERIFICATION.md"), "undeclared nested verification")

      const undeclared = resolveSourcesDetailed({
        cwd: nested,
        prompt: "run validation",
        codexHome,
        useCodexRouting: true,
      })
      expect(undeclared.sources.map((source) => source.filepath)).toEqual([
        path.join(codexHome, "AGENTS.md"),
        path.join(resolvedRepo, "AGENTS.md"),
        path.join(resolvedRepo, "nested", "AGENTS.md"),
      ])

      fs.writeFileSync(
        path.join(nested, "AGENTS.md"),
        [
          "nested repo agents",
          "",
          "## Context Routes",
          "| File | Usage context | Holds |",
          "| --- | --- |",
          "| `VERIFICATION.md` | validation | nested verification policy |",
        ].join("\n"),
      )
      const declared = resolveSourcesDetailed({
        cwd: nested,
        prompt: "run validation",
        codexHome,
        useCodexRouting: true,
      })
      expect(declared.sources.map((source) => source.filepath)).toEqual([
        path.join(codexHome, "AGENTS.md"),
        path.join(resolvedRepo, "AGENTS.md"),
        path.join(resolvedRepo, "nested", "AGENTS.md"),
        path.join(resolvedRepo, "nested", "VERIFICATION.md"),
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("resolves repository routes for symlinked working directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cat-symlinked-"))
    try {
      const repo = path.join(root, "repo")
      const nested = path.join(repo, "nested")
      const link = path.join(root, "link")
      fs.mkdirSync(nested, { recursive: true })
      expect(spawnSync("git", ["init"], { cwd: repo, encoding: "utf-8" }).status).toBe(0)
      fs.writeFileSync(path.join(repo, "AGENTS.md"), "root repo agents")
      fs.writeFileSync(path.join(repo, "GIT_WORKTREES.md"), "git override")
      try {
        fs.symlinkSync(repo, link, "dir")
      } catch {
        return // Symlinks unavailable (Windows without developer mode).
      }
      const resolvedRepo = fs.realpathSync(repo)
      const symlinkedNested = path.join(link, "nested")

      const result = resolveRepositoryRoutes(symlinkedNested, ["git"], [
        path.join(symlinkedNested, "AGENTS.md"),
      ])

      expect(result.sources.map((source) => source.filepath)).toEqual([
        path.join(resolvedRepo, "GIT_WORKTREES.md"),
      ])
      expect([...result.byOwner.keys()]).toEqual([resolvedRepo])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("loads nested AGENTS route declarations after their owner scope", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cat-nested-route-"))
    try {
      const codexHome = path.join(root, "codex")
      const repo = path.join(root, "repo")
      const nested = path.join(repo, "nested")
      fs.mkdirSync(codexHome, { recursive: true })
      fs.mkdirSync(nested, { recursive: true })
      expect(spawnSync("git", ["init"], { cwd: repo, encoding: "utf-8" }).status).toBe(0)
      const resolvedRepo = fs.realpathSync(repo)
      fs.writeFileSync(path.join(codexHome, "AGENTS.md"), "global agents")
      fs.writeFileSync(path.join(repo, "AGENTS.md"), "root agents")
      fs.writeFileSync(
        path.join(nested, "AGENTS.md"),
        [
          "nested agents",
          "",
          "## Context Routes",
          "| File | Usage context | Holds |",
          "| --- | --- | --- |",
          "| `PULL_REQUESTS.md` | Pull request creation and review | nested PR policy |",
        ].join("\n"),
      )
      fs.writeFileSync(path.join(nested, "PULL_REQUESTS.md"), "nested PR policy")

      const result = resolveSourcesDetailed({
        cwd: nested,
        prompt: "open a pull request",
        codexHome,
        useCodexRouting: true,
      })

      expect(result.sources.map((source) => source.filepath)).toEqual([
        path.join(codexHome, "AGENTS.md"),
        path.join(resolvedRepo, "AGENTS.md"),
        path.join(resolvedRepo, "nested", "AGENTS.md"),
        path.join(resolvedRepo, "nested", "PULL_REQUESTS.md"),
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("resolves always-loaded and routed files from codex home", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cat-resolve-"))
    try {
      const codexHome = path.join(root, "codex")
      const repo = path.join(root, "repo")
      fs.mkdirSync(codexHome, { recursive: true })
      fs.mkdirSync(repo, { recursive: true })
      const init = spawnSync("git", ["init"], { cwd: repo, encoding: "utf-8" })
      expect(init.status).toBe(0)
      fs.writeFileSync(
        path.join(codexHome, "AGENTS.md"),
        [
          "## Always Loaded Files",
          "- @$CODEX_HOME/always.md",
          "",
          "## Context-Routed Files",
          "| File | Usage Context | Holds |",
          "| --- | --- | --- |",
          "| PULL_REQUESTS.md | PR work | policy |",
        ].join("\n"),
      )
      fs.writeFileSync(path.join(codexHome, "always.md"), "always loaded")
      fs.writeFileSync(path.join(codexHome, "PULL_REQUESTS.md"), "pr policy")
      fs.writeFileSync(path.join(repo, "AGENTS.md"), "repo agents")

      const result = resolveSourcesDetailed({
        cwd: repo,
        prompt: "open a pull request and merge",
        codexHome,
        useCodexRouting: true,
      })
      const names = result.sources.map((source) => path.basename(source.filepath))
      expect(names).toContain("AGENTS.md")
      expect(names).toContain("always.md")
      expect(names).toContain("PULL_REQUESTS.md")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("session deltas", () => {
  test("returns empty update when profile hash is unchanged", () => {
    const sources = [
      {
        filepath: "/repo/AGENTS.md",
        order: 0,
        content: "- `VER.RULE.TESTS`: Run unit tests.",
      },
    ]
    const first = renderWithDelta({ sources, mode: "curated", prompt: "add unit tests", delta: true })
    expect(first.update).toBe("snapshot")
    const second = renderWithDelta({
      sources,
      mode: "curated",
      prompt: "add unit tests",
      previous: first.profile,
      delta: true,
    })
    expect(second.update).toBe("")
    expect(second.blocks).toEqual([])
    expect(profileHash(sourcesToSession(sources), first.profile.selectedIds)).toBe(first.profile.profileHash)
  })

  test("renderInstructionRequest exposes profile + update", () => {
    const response = renderInstructionRequest({
      cwd: "/tmp",
      mode: "curated",
      prompt: "add unit tests",
      delta: true,
      sources: [
        {
          filepath: "/repo/AGENTS.md",
          order: 0,
          content: "- `VER.RULE.TESTS`: Run unit tests.",
        },
      ],
    })
    expect(response.update).toBe("snapshot")
    expect(response.profile?.profileHash).toBeTruthy()
  })
})
