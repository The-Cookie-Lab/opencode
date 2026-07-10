import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  parseAlwaysLoaded,
  parseRouteTable,
  resolveSourcesDetailed,
  routeApplies,
} from "../src/resolve-sources"
import { profileHash, renderWithDelta, sourcesToSession } from "../src/session-profile"
import { renderInstructionRequest } from "../src/index"

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

  test("routeApplies uses CI word boundaries", () => {
    expect(routeApplies({ file: "PULL_REQUESTS.md" }, "run ci checks")).toBe(true)
    expect(routeApplies({ file: "PULL_REQUESTS.md" }, "circular dependency")).toBe(false)
    expect(routeApplies({ file: "SDL_MCP.md" }, "use sdl-mcp tools")).toBe(true)
  })

  test("resolves always-loaded and routed files from codex home", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cookielayer-resolve-"))
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
