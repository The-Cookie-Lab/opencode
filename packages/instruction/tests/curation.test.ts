import { describe, expect, test } from "bun:test"
import { parse } from "../src/parser"
import { reconcile } from "../src/reconciler"
import { route } from "../src/router"
import { render } from "../src/renderer"
import {
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
    expect(curated.blocks[0]).toContain("<agent-instruction-telemetry>")
    expect(curated.telemetry?.omittedIds).toEqual(["PR.RULE.REVIEW"])
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
    expect(applied).toContain("BEGIN cookielayer-cursor-instruction-hook")
    expect(applied).toContain("AGENTS.md")
    const removed = removeManagedCursorignoreBlock(applied)
    expect(removed.trim()).toBe("")
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
