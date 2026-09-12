import { describe, expect, test } from "bun:test"
import { parse } from "../src/parser"
import { reconcile } from "../src/reconciler"
import { route, hasDevelopmentIntent } from "../src/router"
import { render } from "../src/renderer"
import {
  MANAGED_CURSORIGNORE_MARKER,
  applyManagedCursorignoreBlock,
  removeManagedCursorignoreBlock,
  suppressPatterns,
} from "../src/suppress-manifest"
import { renderInstructionRequest } from "../src/index"

describe("structured instruction curation", () => {
  test("extracts addressable IDs, replacement notes, and unstructured fallback text", () => {
    const parsed = parse([
      {
        filepath: "/repo/AGENTS.md",
        order: 0,
        content: [
          "# Rules",
          "- `USR.RULE.OLD`: Keep the old rule. replaced_by=USR.RULE.NEW",
          "- `USR.RULE.NEW`: Keep the new rule.",
          "",
          "Unstructured guidance stays included when no ID is available.",
        ].join("\n"),
      },
    ])

    expect(parsed.entries.some((entry) => entry.id === "USR.RULE.OLD" && entry.replacedBy === "USR.RULE.NEW")).toBe(
      true,
    )
    expect(parsed.entries.some((entry) => !entry.structured && entry.text.includes("Unstructured guidance"))).toBe(true)

    const reconciled = reconcile(parsed.entries)
    expect(reconciled.entries.some((entry) => entry.id === "USR.RULE.OLD")).toBe(false)
    expect(reconciled.entries.some((entry) => entry.id === "USR.RULE.NEW")).toBe(true)
    expect(reconciled.replacementSuppressions).toBe(1)
  })

  test("renders curated compact blocks based on mode", () => {
    const sources = [
      {
        filepath: "/repo/AGENTS.md",
        order: 0,
        content: ["- `VER.RULE.TESTS`: Run unit tests.", "- `PR.RULE.REVIEW`: Audit PR review threads."].join("\n"),
      },
    ]

    const raw = render(sources, { mode: "raw", prompt: "add unit tests" })
    expect(raw.blocks).toEqual([`Instructions from: /repo/AGENTS.md\n${sources[0].content}`])

    const curated = render(sources, { mode: "curated", prompt: "add unit tests" })
    expect(curated.blocks).toHaveLength(1)
    expect(curated.blocks[0]).toContain("[VER.RULE.TESTS]")
    expect(curated.blocks[0]).not.toContain("[PR.RULE.REVIEW]")
    expect(curated.blocks[0]).not.toContain("<agent-instruction-telemetry>")
    expect(curated.telemetry?.omittedIds).toEqual(["PR.RULE.REVIEW"])
  })
  test("selects always entries plus development domains without model metadata", () => {
    const sources = [
      {
        filepath: "/repo/AGENTS.md",
        order: 0,
        content: [
          "- `USR.RULE.ALWAYS`: Preserve this rule.",
          "- `GIT.RULE.BRANCH`: Use the repository branch.",
          "- `VER.RULE.COVERAGE`: Run coverage checks.",
          "- `DOCS.RULE.GUIDE`: Update the guide.",
          "- `PR.RULE.REVIEW`: Review the pull request.",
        ].join("\n"),
      },
    ]

    const first = render(sources, { mode: "curated", prompt: "implement the branch change" })
    const second = render(sources, { mode: "curated", prompt: "implement the branch change" })

    expect(first.blocks).toEqual(second.blocks)
    expect(first.blocks[0]).toContain("[USR.RULE.ALWAYS] Preserve this rule.")
    expect(first.blocks[0]).toContain("[GIT.RULE.BRANCH] Use the repository branch.")
    expect(first.blocks[0]).toContain("[VER.RULE.COVERAGE] Run coverage checks.")
    expect(first.blocks[0]).toContain("[DOCS.RULE.GUIDE] Update the guide.")
    expect(first.blocks[0]).not.toContain("[PR.RULE.REVIEW]")
    expect(first.blocks[0]).not.toContain("/repo/AGENTS.md")
    expect(first.blocks[0]).not.toContain("omitted")
    expect(first.telemetry?.omittedIds).toEqual(["PR.RULE.REVIEW"])
  })

  test("does not turn investigation prompts into development routing", () => {
    const entries = parse([
      {
        filepath: "/repo/AGENTS.md",
        order: 0,
        content: "- `GIT.RULE.BRANCH`: Use the repository branch.",
      },
    ]).entries

    expect(hasDevelopmentIntent("investigate the failure")).toBe(false)
    expect(route(entries, "investigate the failure").selected).toEqual([])
  })

  test("excludes routing metadata headings while retaining payload", () => {
    const rendered = render(
      [
        {
          filepath: "/tmp/codex/AGENTS.md",
          order: 0,
          content: [
            "## Always Loaded Files",
            "- @$CODEX_HOME/always.md",
            "",
            "## Context-Routed Files",
            "| File | Usage Context | Holds |",
            "| --- | --- | --- |",
            "| PULL_REQUESTS.md | PR / merge / review | PR policy |",
            "",
            "## Payload",
            "- `USR.RULE.PAYLOAD`: Keep the actual instruction.",
            "Actual payload guidance remains included.",
          ].join("\n"),
        },
      ],
      {
        mode: "curated",
        prompt: "investigate the repository",
        excludedHeadings: ["Always Loaded Files", "Context-Routed Files"],
      },
    )

    expect(rendered.blocks[0]).toContain("## Payload")
    expect(rendered.blocks[0]).toContain("[USR.RULE.PAYLOAD] Keep the actual instruction.")
    expect(rendered.blocks[0]).not.toContain("Context-Routed Files")
    expect(rendered.blocks[0]).not.toContain("PULL_REQUESTS.md")
  })
})

describe("suppress manifest", () => {
  test("includes static routed basenames", () => {
    const patterns = suppressPatterns({ globalAgentsPath: "/does/not/exist/AGENTS.md" })
    expect(patterns).toContain("AGENTS.md")
    expect(patterns).toContain("**/PULL_REQUESTS.md")
  })

  test("applies and removes managed cursorignore block", () => {
    const patterns = ["AGENTS.md", "**/AGENTS.md"]
    const applied = applyManagedCursorignoreBlock("", patterns)
    expect(applied).toContain(`BEGIN ${MANAGED_CURSORIGNORE_MARKER}`)
    expect(applied).toContain("AGENTS.md")
    const removed = removeManagedCursorignoreBlock(applied)
    expect(removed.trim()).toBe("")
  })

  test("migrates a legacy managed block to the CAT marker", () => {
    const legacy = [
      "# BEGIN cookielayer-cursor-instruction-hook (managed)",
      "AGENTS.md",
      "# END cookielayer-cursor-instruction-hook",
      "",
    ].join("\n")
    const applied = applyManagedCursorignoreBlock(legacy, ["AGENTS.md"])
    expect(applied).toContain(`BEGIN ${MANAGED_CURSORIGNORE_MARKER}`)
    expect(applied).toContain("AGENTS.md")
    expect(applied).not.toContain("cookielayer-cursor-instruction-hook")
  })

  test("preserves user ignore entries while replacing the managed block", () => {
    const text = [
      "build/",
      "node_modules/",
      "",
      "# BEGIN cookielayer-cursor-instruction-hook (managed)",
      "AGENTS.md",
      "# END cookielayer-cursor-instruction-hook",
      "",
      ".cache/",
    ].join("\n")
    const applied = applyManagedCursorignoreBlock(text, ["AGENTS.md"])
    expect(applied).toContain("build/")
    expect(applied).toContain("node_modules/")
    expect(applied).toContain(".cache/")
    expect(applied).toContain(`BEGIN ${MANAGED_CURSORIGNORE_MARKER}`)
    expect(applied).not.toContain("cookielayer-cursor-instruction-hook")
  })

  test("collapses mixed legacy and canonical blocks into one canonical block", () => {
    const text = [
      "# BEGIN cookielayer-cursor-instruction-hook (managed)",
      "AGENTS.md",
      "# END cookielayer-cursor-instruction-hook",
      "",
      `# BEGIN ${MANAGED_CURSORIGNORE_MARKER} (managed by ./cookielab clients sync)`,
      "# sync_version: 1",
      "# adapter: CAT instruction curation",
      "CLAUDE.md",
      `# END ${MANAGED_CURSORIGNORE_MARKER}`,
      "",
    ].join("\n")
    const applied = applyManagedCursorignoreBlock(text, ["AGENTS.md", "CLAUDE.md"])
    expect(applied.split(`BEGIN ${MANAGED_CURSORIGNORE_MARKER}`).length - 1).toBe(1)
    expect(applied).not.toContain("cookielayer-cursor-instruction-hook")
  })

  test("repeated application is idempotent", () => {
    const text = "build/\n"
    const once = applyManagedCursorignoreBlock(text, ["AGENTS.md"])
    const twice = applyManagedCursorignoreBlock(once, ["AGENTS.md"])
    expect(twice).toBe(once)
  })

  test("removal preserves unrelated content and drops every managed block", () => {
    const text = [
      "build/",
      "",
      "# BEGIN cookielayer-cursor-instruction-hook (managed)",
      "AGENTS.md",
      "# END cookielayer-cursor-instruction-hook",
      "",
      ".cache/",
    ].join("\n")
    const removed = removeManagedCursorignoreBlock(text)
    expect(removed).toContain("build/")
    expect(removed).toContain(".cache/")
    expect(removed).not.toContain("cookielayer-cursor-instruction-hook")
    expect(removed).not.toContain(MANAGED_CURSORIGNORE_MARKER)
  })

  test("does not delete an incomplete legacy block", () => {
    const text = [
      "build/",
      "",
      "# BEGIN cookielayer-cursor-instruction-hook (managed)",
      "AGENTS.md",
    ].join("\n")
    const removed = removeManagedCursorignoreBlock(text)
    expect(removed).toContain("cookielayer-cursor-instruction-hook")
    expect(removed).toContain("AGENTS.md")
  })
})

describe("renderInstructionRequest", () => {
  test("accepts explicit sources without filesystem reads", () => {
    const response = renderInstructionRequest({
      cwd: "/tmp",
      mode: "curated",
      prompt: "add unit tests",
      sources: [
        {
          filepath: "/repo/AGENTS.md",
          order: 0,
          content: "- `VER.RULE.TESTS`: Run unit tests.",
        },
      ],
    })
    expect(response.blocks[0]).toContain("[VER.RULE.TESTS]")
    expect(response.source_paths).toEqual(["/repo/AGENTS.md"])
  })
})
