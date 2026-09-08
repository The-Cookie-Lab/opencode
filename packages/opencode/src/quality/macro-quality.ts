export type MacroQualityMode = "local" | "ci" | "full"
export type MacroQualityStatus = "pass" | "fail" | "waived"

export type MacroRiskArea =
  | "tool_registry"
  | "runtime_flags"
  | "context_intel"
  | "permissions"
  | "session_prompting"
  | "docs"
  | "ci"
  | "tests"

export type MacroScenario = {
  id: string
  fixture: string
  flags: string[]
  requiredTools: string[]
  forbiddenTools: string[]
  assertions: string[]
  budgets: Record<string, number>
}

export type MacroScenarioManifest = {
  version: 1
  scenarios: MacroScenario[]
}

export type MacroGate = {
  id: string
  description: string
  command?: string[]
  riskAreas: MacroRiskArea[]
  modes: MacroQualityMode[]
}

export type MacroWaiver = {
  id: string
  kind: "gate" | "scenario" | "budget"
  target: string
  owner: string
  reason: string
  issue: string
  expires: string
}

export type MacroScenarioResult = {
  id: string
  status: MacroQualityStatus
  failures: string[]
  durationMs?: number
}

export type MacroBudgetResult = {
  id: string
  status: MacroQualityStatus
  actual?: number
  limit?: number
  failures: string[]
}

export type MacroGateResult = {
  id: string
  status: MacroQualityStatus
  command?: string[]
  exitCode?: number
  durationMs?: number
  snippet?: string
}

export type MacroQualityReport = {
  status: MacroQualityStatus
  mode: MacroQualityMode
  changedFrom: string
  changedFiles: string[]
  riskAreas: MacroRiskArea[]
  requiredGates: MacroGate[]
  gateResults: MacroGateResult[]
  scenarioResults: MacroScenarioResult[]
  budgets: MacroBudgetResult[]
  waivers: MacroWaiver[]
  generatedAt: string
}

export const REQUIRED_SCENARIOS = [
  "project-dossier-node",
  "project-dossier-python",
  "project-dossier-java",
  "project-dossier-empty",
  "project-dossier-no-git",
  "project-dossier-monorepo",
  "view-outline-lsp-success",
  "view-outline-lsp-fallback",
  "view-outline-large-file-truncation",
  "view-outline-binary-file",
  "view-outline-symlink",
  "semantic-search-cold-index",
  "semantic-search-warm-index",
  "semantic-search-ignored-dirs",
  "semantic-search-permission-denied",
  "semantic-search-metamorphic-renamed-symbol",
  "semantic-search-metamorphic-moved-file",
  "semantic-search-metamorphic-noise-files",
  "agent-replay-first-repo-orientation",
  "agent-replay-symbol-lookup-before-edit",
  "agent-replay-conceptual-bug-search",
  "agent-replay-primitive-fallback",
] as const

export const MACRO_GATES: MacroGate[] = [
  {
    id: "manifest-contracts",
    description: "Validate the macro scenario manifest and shared contract fixtures.",
    riskAreas: ["context_intel", "tool_registry", "tests"],
    modes: ["local", "ci", "full"],
  },
  {
    id: "macro-quality-tests",
    description: "Run quality framework unit tests.",
    command: ["bun", "test", "test/quality/macro_quality.test.ts"],
    riskAreas: ["context_intel", "tool_registry", "tests", "ci"],
    modes: ["local", "ci", "full"],
  },
  {
    id: "macro-tool-contract-tests",
    description: "Run macro tool schema, registry, contract, and behavior tests.",
    command: [
      "bun",
      "test",
      "test/tool/parameters.test.ts",
      "test/tool/registry.test.ts",
      "test/tool/macro_tools.test.ts",
    ],
    riskAreas: ["context_intel", "tool_registry", "runtime_flags", "permissions"],
    modes: ["local", "ci", "full"],
  },
  {
    id: "runtime-flag-tests",
    description: "Run runtime flag gate tests.",
    command: ["bun", "test", "test/effect/runtime-flags.test.ts"],
    riskAreas: ["runtime_flags"],
    modes: ["local", "ci", "full"],
  },
  {
    id: "session-prompt-tests",
    description: "Run session prompt tests for macro-tool guidance and replay invariants.",
    command: ["bun", "test", "test/session/prompt.test.ts"],
    riskAreas: ["session_prompting"],
    modes: ["ci", "full"],
  },
  {
    id: "typecheck",
    description: "Run opencode TypeScript typecheck.",
    command: ["bun", "typecheck"],
    riskAreas: [
      "context_intel",
      "tool_registry",
      "runtime_flags",
      "permissions",
      "session_prompting",
      "tests",
      "ci",
    ],
    modes: ["local", "ci", "full"],
  },
  {
    id: "single-build-smoke",
    description: "Build a single native opencode binary and run the build smoke test.",
    command: ["bun", "run", "./packages/opencode/script/build.ts", "--single"],
    riskAreas: ["context_intel", "tool_registry", "runtime_flags", "permissions"],
    modes: ["ci", "full"],
  },
  {
    id: "httpapi-exerciser",
    description: "Run HTTP API exerciser gates when full product behavior may be affected.",
    command: ["bun", "run", "test:httpapi"],
    riskAreas: ["session_prompting", "permissions"],
    modes: ["full"],
  },
]

export function classifyChangedFiles(files: string[]): MacroRiskArea[] {
  const areas = new Set<MacroRiskArea>()
  for (const file of files) {
    if (file.endsWith(".md")) areas.add("docs")
    if (file.startsWith(".github/")) areas.add("ci")
    if (file.includes("/test/")) areas.add("tests")
    if (file.includes("src/tool/registry.ts") || file.includes("src/tool/project_dossier.ts")) areas.add("tool_registry")
    if (file.includes("src/tool/view_outline.ts") || file.includes("src/tool/semantic_search.ts")) {
      areas.add("tool_registry")
      areas.add("permissions")
    }
    if (file.includes("src/effect/runtime-flags.ts")) areas.add("runtime_flags")
    if (file.includes("src/context-intel/")) areas.add("context_intel")
    if (file.includes("src/permission/") || file.includes("test/permission/")) areas.add("permissions")
    if (file.includes("src/session/prompt") || file.includes("src/skill/prompt/")) areas.add("session_prompting")
  }
  return [...areas].sort()
}

export function selectRequiredGates(input: {
  riskAreas: MacroRiskArea[]
  mode: MacroQualityMode
  changedFiles: string[]
}): MacroGate[] {
  const riskAreas = new Set(input.riskAreas)
  const macroTouched =
    riskAreas.has("context_intel") ||
    riskAreas.has("tool_registry") ||
    riskAreas.has("runtime_flags") ||
    input.changedFiles.some((file) => file.includes("macro") || file.includes("ContextIntel"))
  if (!macroTouched && riskAreas.size === 1 && riskAreas.has("docs")) return []
  return MACRO_GATES.filter(
    (gate) => gate.modes.includes(input.mode) && gate.riskAreas.some((area) => riskAreas.has(area) || macroTouched),
  )
}

export function validateScenarioManifest(manifest: MacroScenarioManifest): MacroScenarioResult[] {
  const results: MacroScenarioResult[] = []
  const seen = new Set<string>()
  const required = new Set<string>(REQUIRED_SCENARIOS)
  for (const scenario of manifest.scenarios) {
    const failures: string[] = []
    if (seen.has(scenario.id)) failures.push("duplicate scenario id")
    seen.add(scenario.id)
    required.delete(scenario.id)
    if (!scenario.fixture) failures.push("missing fixture")
    if (!Array.isArray(scenario.flags)) failures.push("flags must be an array")
    if (!Array.isArray(scenario.requiredTools)) failures.push("requiredTools must be an array")
    if (!Array.isArray(scenario.forbiddenTools)) failures.push("forbiddenTools must be an array")
    if (!Array.isArray(scenario.assertions) || scenario.assertions.length === 0) failures.push("missing assertions")
    if (!scenario.budgets || typeof scenario.budgets !== "object") failures.push("missing budgets")
    results.push({ id: scenario.id, status: failures.length ? "fail" : "pass", failures })
  }
  for (const id of [...required].sort()) {
    results.push({ id, status: "fail", failures: ["required scenario missing from manifest"] })
  }
  return results
}

export function validateBudgetContracts(manifest: MacroScenarioManifest): MacroBudgetResult[] {
  const results: MacroBudgetResult[] = []
  for (const scenario of manifest.scenarios) {
    for (const [name, limit] of Object.entries(scenario.budgets)) {
      const failures: string[] = []
      if (!Number.isFinite(limit) || limit < 0) failures.push("budget must be a non-negative finite number")
      if (name.includes("token") && limit > 10_000) failures.push("token budget is too high for compact macro-tool output")
      if (name.includes("latency_ms") && limit > 30_000) failures.push("latency budget is too high for blocking validation")
      results.push({
        id: `${scenario.id}:${name}`,
        status: failures.length ? "fail" : "pass",
        limit,
        failures,
      })
    }
  }
  return results
}

export function activeWaivers(waivers: MacroWaiver[], now = new Date()): MacroWaiver[] {
  return waivers.filter((waiver) => {
    if (!waiver.owner || !waiver.reason || !waiver.issue) return false
    const expires = new Date(`${waiver.expires}T23:59:59.999Z`)
    return Number.isFinite(expires.valueOf()) && expires >= now
  })
}

export function applyWaivers<T extends { id: string; status: MacroQualityStatus }>(
  results: T[],
  waivers: MacroWaiver[],
  kind: MacroWaiver["kind"],
): T[] {
  const active = activeWaivers(waivers)
  return results.map((result) => {
    if (result.status !== "fail") return result
    const waived = active.some((waiver) => waiver.kind === kind && waiver.target === result.id)
    return waived ? { ...result, status: "waived" } : result
  })
}

export function summarizeStatus(parts: Array<{ status: MacroQualityStatus }>): MacroQualityStatus {
  if (parts.some((part) => part.status === "fail")) return "fail"
  if (parts.some((part) => part.status === "waived")) return "waived"
  return "pass"
}

export function createReport(input: {
  mode: MacroQualityMode
  changedFrom: string
  changedFiles: string[]
  riskAreas: MacroRiskArea[]
  requiredGates: MacroGate[]
  gateResults: MacroGateResult[]
  scenarioResults: MacroScenarioResult[]
  budgets: MacroBudgetResult[]
  waivers: MacroWaiver[]
  generatedAt?: string
}): MacroQualityReport {
  const status = summarizeStatus([...input.gateResults, ...input.scenarioResults, ...input.budgets])
  return {
    status,
    mode: input.mode,
    changedFrom: input.changedFrom,
    changedFiles: input.changedFiles,
    riskAreas: input.riskAreas,
    requiredGates: input.requiredGates,
    gateResults: input.gateResults,
    scenarioResults: input.scenarioResults,
    budgets: input.budgets,
    waivers: activeWaivers(input.waivers),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  }
}

export function renderSummary(report: MacroQualityReport): string {
  const lines = [
    `# Macro Quality Report`,
    ``,
    `Status: ${report.status}`,
    `Mode: ${report.mode}`,
    `Changed from: ${report.changedFrom}`,
    `Risk areas: ${report.riskAreas.length ? report.riskAreas.join(", ") : "none"}`,
    `Required gates: ${report.requiredGates.map((gate) => gate.id).join(", ") || "none"}`,
    ``,
    `## Gates`,
    ...report.gateResults.map((gate) => `- ${gate.status} ${gate.id}${gate.exitCode === undefined ? "" : ` exit=${gate.exitCode}`}`),
    ``,
    `## Scenarios`,
    ...report.scenarioResults.map((scenario) => `- ${scenario.status} ${scenario.id}`),
    ``,
    `## Budgets`,
    ...report.budgets.map((budget) => `- ${budget.status} ${budget.id}${budget.limit === undefined ? "" : ` limit=${budget.limit}`}`),
  ]
  return `${lines.join("\n")}\n`
}
