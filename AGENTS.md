- Default branch: `dev`. Local `main` may not exist; use `dev` or `origin/dev` for diffs.
- Regenerate JS SDK: `./packages/sdk/js/script/build.ts`.

## High-ROI Agent Notes

- For tool-surface/context-budget work, start with `packages/opencode/src/tool/registry.ts`, `packages/opencode/src/session/tools.ts`, `packages/opencode/src/tool/json-schema.ts`, and the relevant `packages/opencode/src/tool/*.ts` or `*.txt` files.
- For token breakdown rendering, the pipeline is:
  1. Model-server response → `mapUsage()` stores `prompt_tokens_details` in `Usage.providerMetadata.openai`
  2. Protocol adapters (`openai-chat.ts`, `gemini.ts`, `bedrock-converse.ts`, `anthropic-messages.ts`) pass `state.usage?.providerMetadata` to `Lifecycle.finish()` → emitted as `providerMetadata` on the `step-finish` event
  3. `processor.ts` reads `value.providerMetadata` and passes it as `metadata` to `Session.getUsage()`
  4. `session.ts` (`getUsage()`) extracts `promptTokensDetails` with a defense-in-depth fallback: primary path reads `input.metadata?.openai?.prompt_tokens_details` (from the `step-finish` event), fallback reads `input.usage?.providerMetadata?.openai?.prompt_tokens_details` (from the `Usage` object directly)
  5. `message-v2.ts` (StepFinishPart schema) defines the `promptTokensDetails` field on the part
  6. Server → client sync: `step-finish` parts must survive the `SKIP_PARTS` filter. Both the real-time event path (`event-reducer.ts`) and initial load path (`directory-sync.ts`) gate parts through `SKIP_PARTS` — **step-finish must NOT be in this set** or `promptTokensDetails` is silently dropped before the UI sees it. Regression tests in `event-reducer.test.ts` and `directory-sync.test.ts`.
  7. `session-context-tab.tsx` (reads parts from sync store) → `session-context-breakdown.ts` (renders)
     The contract includes `messages[]`, `tools[]`, `agent_instructions[]`, `template_overhead`, and `image_tokens`; opencode marks instruction spans on OpenAI-compatible system messages with `_opencode_agent_instruction_spans` so model-server can attribute them without prompt-visible markers.
     See also `packages/llm/README.md` and `packages/web/src/content/docs/server.mdx`.
- Experimental tool behavior is opt-in via `RuntimeFlags`. Add tests proving both default and experimental registries.
- Instruction curation lives in `packages/opencode/src/session/instruction-*.ts` and is gated by `OPENCODE_AGENT_INSTRUCTION_MODE=curated`; keep raw mode as the fallback and cover routing/precedence changes in `packages/opencode/test/session/instruction.test.ts`.
- Tool param/description changes need `packages/opencode/test/tool/parameters.test.ts` coverage. Regenerate snapshots: `bun test -u test/tool/parameters.test.ts` from `packages/opencode`. Never hand-edit generated snapshot bodies.

### Tool Compaction Pipeline

Tool schema flow: **Effect Schema** → `ToolJsonSchema.fromSchema()` in `json-schema.ts` → `stripSchema()` strips noise → `compactJsonSchema()` → AI SDK `tool()`. When `experimentalCompactTools` is on, `session/tools.ts` strips schemas and swaps descriptions from `compactDescriptions` in `registry.ts`.

**`stripSchema()` (~line 493):** Recursively filters JSON Schema keys. Strips `"$schema"` and `"title"` only. **DO NOT add `"description"` to the strip filter** — it was previously stripped, which removed per-parameter guidance and caused Qwen 3.6 27B GGUF to loop with `SchemaError(Missing key at ["description"])` on bash. Local models depend on parameter descriptions.

**`compactDescriptions` (~line 65 of `registry.ts`):** 23 entries, one per builtin. Format: `<purpose>. Required: <param (purpose)>. Optional: <param (default)>.` Shell tool's `description` param goes FIRST in Required since local LLMs miss it otherwise: `"5-10 word summary of what the command does — e.g. 'List files in current directory'"`.

**Pipeline files:**

- `registry.ts` — compactDescriptions, stripSchema, tool registration
- `session/tools.ts` — applies compaction (lines 74-82)
- `json-schema.ts` — `fromSchema()`, `fromTool()`, `compactJsonSchema()`
- `tool/bash/prompt.ts` — full bash param annotations
- `tool/shell/shell.txt` — full bash description template

**Local LLM warning:** Small/quantized models (Qwen 3.6 27B Q6, etc.) break on missing descriptions that API models tolerate. Test compaction changes against at least one local model.

## Build & Binary

- Single-binary build: `bun run ./packages/opencode/script/build.ts --single` from the worktree. The parent `./cookiecode build opencode` targets the main checkout, not arbitrary worktrees.
- The build may repair optional native packages and emit Vite warnings. Check `git status --short` and lockfile diffs before staging.

## Fork Sync Helpers

- `script/sync-upstream-dev.sh`: merge `upstream/dev` into local `dev` with `--no-ff`.
- `script/sync-upstream-dev-with-backup.sh`: create a timestamped backup branch, verify it, prune older backup branches (keep newest only), then merge `upstream/dev`.
- Package aliases: `bun run sync:upstream-dev` and `bun run sync:upstream-dev:backup` from repo root.
- Helpers require clean working tree and configured `origin` + `upstream` remotes.

## Commits & PRs

Conventional: `type(scope): summary`. Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`. Scopes: `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, `plugin`.

## Style Guide

### General

- One function unless composable/reusable. Don't extract single-use helpers.
- No `try/catch` unless unavoidable. No `any`.
- Inline single-use values. Use `const`, ternaries, early returns.
- Prefer `Bun.file()`, type inference, functional methods (`flatMap`/`filter`/`map`) with type guards.
- `src/config`: use self-export pattern (`export * as ConfigAgent from "./agent"`).
- Destructure sparingly: `obj.a` > `const { a } = obj`.
- Comments: explain surprising behavior, not obvious code.

```ts
// Good — inline
const journal = await Bun.file(path.join(dir, "journal.json")).json()
```

```ts
// Good — no destructure
obj.a
obj.b
```

```ts
// Good — ternaries
const foo = condition ? 1 : 2
```

```ts
// Good — early return
function foo() {
  if (condition) return 1
  return 2
}
```

### Helpers

Happy path on top, helpers below. Extract only when naming a real concept (`requireConfig`, `readMetadata`). Don't return `Effect` from sync helpers. Prefer `Schema.UnknownFromJsonString` / `Schema.decodeUnknownOption` over manual `JSON.parse` + `Effect.try`.

```ts
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}
```

### Drizzle Schemas

Use `snake_case` field names — avoids string column redefinitions.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})
```

## Testing

- Avoid mocks. Test real implementation — don't duplicate logic.
- Tests must run from package dir (e.g. `packages/opencode`), not repo root.

## Type Checking

- `bun typecheck` from package dirs, never `tsc` directly.
- Resolve all typecheck failures before pushing any branch.
- Do not use `git push --no-verify` unless the user explicitly requests it for the current task.
