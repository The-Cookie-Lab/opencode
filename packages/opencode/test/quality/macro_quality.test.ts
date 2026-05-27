import { describe, expect, test } from "bun:test"
import { stat } from "fs/promises"
import path from "path"
import {
  activeWaivers,
  applyWaivers,
  classifyChangedFiles,
  createReport,
  REQUIRED_SCENARIOS,
  renderSummary,
  selectRequiredGates,
  validateBudgetContracts,
  validateScenarioManifest,
  type MacroScenarioManifest,
  type MacroScenarioResult,
} from "@/quality/macro-quality"

const qualityDir = path.join(import.meta.dir)
const manifestPath = path.join(qualityDir, "macro-scenarios.json")

async function manifest() {
  return JSON.parse(await Bun.file(manifestPath).text()) as MacroScenarioManifest
}

describe("macro quality framework", () => {
  test("classifies macro-related changes into blocking risk areas", () => {
    const areas = classifyChangedFiles([
      "packages/opencode/src/context-intel/index.ts",
      "packages/opencode/src/tool/semantic_search.ts",
      "packages/opencode/src/effect/runtime-flags.ts",
      "packages/opencode/src/skill/prompt/customize-opencode.md",
      ".github/workflows/macro-quality.yml",
    ])

    expect(areas).toContain("context_intel")
    expect(areas).toContain("tool_registry")
    expect(areas).toContain("permissions")
    expect(areas).toContain("runtime_flags")
    expect(areas).toContain("session_prompting")
    expect(areas).toContain("docs")
    expect(areas).toContain("ci")
  })

  test("selects blocking local gates for macro changes and skips docs-only changes", () => {
    const macroGates = selectRequiredGates({
      mode: "local",
      changedFiles: ["packages/opencode/src/context-intel/index.ts"],
      riskAreas: ["context_intel"],
    }).map((gate) => gate.id)

    expect(macroGates).toContain("manifest-contracts")
    expect(macroGates).toContain("macro-quality-tests")
    expect(macroGates).toContain("macro-tool-contract-tests")
    expect(macroGates).toContain("typecheck")
    expect(macroGates).not.toContain("single-build-smoke")

    const docsGates = selectRequiredGates({
      mode: "local",
      changedFiles: ["README.md"],
      riskAreas: ["docs"],
    })
    expect(docsGates).toEqual([])
  })

  test("promotes CI mode to include the build smoke gate", () => {
    const gates = selectRequiredGates({
      mode: "ci",
      changedFiles: ["packages/opencode/src/tool/registry.ts"],
      riskAreas: ["tool_registry"],
    }).map((gate) => gate.id)

    expect(gates).toContain("single-build-smoke")
  })

  test("validates the versioned scenario manifest and required scenario coverage", async () => {
    const results = validateScenarioManifest(await manifest())
    expect(results.filter((result) => result.status === "fail")).toEqual([])

    const ids = new Set(results.map((result) => result.id))
    for (const required of REQUIRED_SCENARIOS) {
      expect(ids.has(required)).toBe(true)
    }
  })

  test("proves every manifest fixture and shared contract fixture exists", async () => {
    const data = await manifest()
    for (const scenario of data.scenarios) {
      const fixture = path.join(qualityDir, scenario.fixture)
      expect(await exists(fixture)).toBe(true)
    }

    expect(await Bun.file(path.join(qualityDir, "fixtures/contracts/macro-tool-contracts.json")).exists()).toBe(true)
  })

  test("enforces compact token and latency budget contracts", async () => {
    const results = validateBudgetContracts(await manifest())
    expect(results.filter((result) => result.status === "fail")).toEqual([])

    const dossierBudget = results.find((result) => result.id === "project-dossier-node:output_tokens")
    expect(dossierBudget?.limit).toBeLessThanOrEqual(250)
  })

  test("models deterministic replay constraints as manifest assertions", async () => {
    const data = await manifest()
    const replay = data.scenarios.filter((scenario) => scenario.id.startsWith("agent-replay-"))
    expect(replay).toHaveLength(4)
    expect(replay.find((scenario) => scenario.id === "agent-replay-first-repo-orientation")?.requiredTools).toEqual([
      "project_dossier",
    ])
    expect(replay.find((scenario) => scenario.id === "agent-replay-symbol-lookup-before-edit")?.forbiddenTools).toContain(
      "read",
    )
    expect(replay.find((scenario) => scenario.id === "agent-replay-primitive-fallback")?.forbiddenTools).toContain(
      "semantic_search",
    )
  })

  test("requires explicit active waivers and marks only matching failures waived", () => {
    const waivers = activeWaivers(
      [
        {
          id: "w1",
          kind: "scenario",
          target: "semantic-search-warm-index",
          owner: "quality",
          reason: "temporary deterministic vector fixture migration",
          issue: "https://example.invalid/issue/1",
          expires: "2099-01-01",
        },
        {
          id: "expired",
          kind: "scenario",
          target: "project-dossier-node",
          owner: "quality",
          reason: "expired",
          issue: "https://example.invalid/issue/2",
          expires: "2000-01-01",
        },
      ],
      new Date("2026-05-27T00:00:00Z"),
    )

    expect(waivers.map((waiver) => waiver.id)).toEqual(["w1"])
    const failing: MacroScenarioResult[] = [
      { id: "semantic-search-warm-index", status: "fail" as const, failures: [] },
      { id: "project-dossier-node", status: "fail" as const, failures: [] },
    ]
    const results = applyWaivers(failing, waivers, "scenario")
    expect(results).toEqual([
      { id: "semantic-search-warm-index", status: "waived", failures: [] },
      { id: "project-dossier-node", status: "fail", failures: [] },
    ])
  })

  test("creates machine-readable reports and concise markdown summaries", () => {
    const report = createReport({
      mode: "local",
      changedFrom: "origin/dev",
      changedFiles: ["packages/opencode/src/context-intel/index.ts"],
      riskAreas: ["context_intel"],
      requiredGates: [],
      gateResults: [{ id: "manifest-contracts", status: "pass" }],
      scenarioResults: [{ id: "project-dossier-node", status: "pass", failures: [] }],
      budgets: [{ id: "project-dossier-node:output_tokens", status: "pass", failures: [], limit: 250 }],
      waivers: [],
      generatedAt: "2026-05-27T00:00:00.000Z",
    })

    expect(report.status).toBe("pass")
    expect(report.generatedAt).toBe("2026-05-27T00:00:00.000Z")
    expect(renderSummary(report)).toContain("Status: pass")
  })
})

async function exists(file: string) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}
