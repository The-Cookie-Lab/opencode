import { mkdirSync } from "fs"
import path from "path"
import {
  applyWaivers,
  classifyChangedFiles,
  createReport,
  renderSummary,
  selectRequiredGates,
  validateBudgetContracts,
  validateScenarioManifest,
  type MacroGateResult,
  type MacroQualityMode,
  type MacroScenarioManifest,
  type MacroWaiver,
} from "../src/quality/macro-quality"

const packageDir = path.resolve(import.meta.dir, "..")
const repoRoot = path.resolve(packageDir, "../..")
const artifactDir = path.join(packageDir, ".artifacts", "macro-quality")
const manifestPath = path.join(packageDir, "test", "quality", "macro-scenarios.json")

const args = parseArgs(Bun.argv.slice(2))
const mode = parseMode(args.mode ?? "local")
const changedFrom = args["changed-from"] ?? "origin/dev"
const planOnly = args["plan-only"] === "true" || Bun.env.MACRO_QUALITY_PLAN_ONLY === "true"

mkdirSync(artifactDir, { recursive: true })
const changedFiles = await gitChangedFiles(changedFrom)
const riskAreas = classifyChangedFiles(changedFiles)
const requiredGates = selectRequiredGates({ riskAreas, mode, changedFiles })
const manifest = (await readJson(manifestPath)) as MacroScenarioManifest
const waivers = await readWaivers(args.waiver)

const scenarioResults = applyWaivers(validateScenarioManifest(manifest), waivers, "scenario")
const budgets = applyWaivers(validateBudgetContracts(manifest), waivers, "budget")
const gateResults: MacroGateResult[] = []

for (const gate of requiredGates) {
  if (!gate.command || planOnly) {
    gateResults.push({ id: gate.id, status: "pass", command: gate.command })
    continue
  }
  const start = performance.now()
  const proc = Bun.spawn(gate.command, {
    cwd: gate.id === "single-build-smoke" ? repoRoot : packageDir,
    stdout: "pipe",
    stderr: "pipe",
    env: Bun.env,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const output = `${stdout}\n${stderr}`.trim()
  gateResults.push({
    id: gate.id,
    status: exitCode === 0 ? "pass" : "fail",
    command: gate.command,
    exitCode,
    durationMs: Math.round(performance.now() - start),
    snippet: output.slice(-2000),
  })
}

const report = createReport({
  mode,
  changedFrom,
  changedFiles,
  riskAreas,
  requiredGates,
  gateResults: applyWaivers(gateResults, waivers, "gate"),
  scenarioResults,
  budgets,
  waivers,
})

await Bun.write(path.join(artifactDir, "report.json"), JSON.stringify(report, null, 2))
await Bun.write(path.join(artifactDir, "summary.md"), renderSummary(report))
console.log(renderSummary(report))
for (const waiver of report.waivers) {
  console.warn(
    `::warning title=Macro quality waiver::${waiver.kind} ${waiver.target} waived by ${waiver.owner} until ${waiver.expires}: ${waiver.reason} (${waiver.issue})`,
  )
}

if (report.status === "fail") process.exit(1)

function parseArgs(values: string[]) {
  const parsed: Record<string, string> = {}
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = values[i + 1]
    if (!next || next.startsWith("--")) parsed[key] = "true"
    else {
      parsed[key] = next
      i++
    }
  }
  return parsed
}

function parseMode(value: string): MacroQualityMode {
  if (value === "local" || value === "ci" || value === "full") return value
  throw new Error(`Invalid --mode ${value}; expected local, ci, or full`)
}

async function gitChangedFiles(ref: string) {
  const files = new Set<string>()
  const candidates = [
    ["git", "diff", "--name-only", `${ref}...HEAD`],
    ["git", "diff", "--name-only", ref],
    ["git", "status", "--short"],
  ]
  for (const command of candidates) {
    const proc = Bun.spawn(command, { cwd: repoRoot, stdout: "pipe", stderr: "pipe" })
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (exitCode !== 0) continue
    for (const file of stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (command[1] === "status" ? line.replace(/^.. /, "") : line))
      .filter((file) => file.startsWith("packages/opencode/") || file.startsWith(".github/") || file === "README.md")) {
      files.add(file)
    }
  }
  return [...files].sort()
}

async function readJson(file: string) {
  return JSON.parse(await Bun.file(file).text())
}

async function readWaivers(file?: string): Promise<MacroWaiver[]> {
  const defaultPath = path.join(packageDir, "test", "quality", "macro-waivers.json")
  const target = file ? path.resolve(file) : defaultPath
  if (!(await Bun.file(target).exists())) return []
  const parsed = await readJson(target)
  return Array.isArray(parsed) ? parsed : parsed.waivers ?? []
}
