# Tool migration

Practical reference for the current tool-migration state in `packages/opencode`.

## Status

`Tool.Def.execute` and `Tool.Info.init` already return `Effect` on this branch, and the built-in tool surface is now largely on the target shape.

The current exported tools in `src/tool` all use `Tool.define(...)` with Effect-based initialization, and nearly all of them already build their tool body with `Effect.gen(...)` and `Effect.fn(...)`.

So the remaining work is no longer "convert tools to Effect at all". The remaining work is mostly:

1. remove Promise and raw platform bridges inside individual tool bodies
2. swap tool internals to Effect-native services like `AppFileSystem`, `HttpClient`, and `ChildProcessSpawner`
3. keep tests and callers aligned with `yield* info.init()` and real service graphs

## Current shape

`Tool.define(...)` is already the Effect-native helper here.

- `init` is an `Effect`
- `info.init()` returns an `Effect`
- `execute(...)` returns an `Effect`

That means a tool does not need a separate `Tool.defineEffect(...)` helper to count as migrated. A tool is effectively migrated when its init and execute path stay Effect-native, even if some internals still bridge to Promise-based or raw APIs.

## Experimental compact core

`OPENCODE_EXPERIMENTAL_COMPACT_TOOLS=true` switches the built-in prompt surface to a smaller, enhanced core without changing the default tool set.

The compact surface keeps `bash`, `read`, support tools such as `task`, `skill`, `todowrite`, web tools, and optional gated tools. It replaces `glob` plus `grep` with `rg`, and replaces `edit`, `write`, and model-specific `apply_patch` with `write_patch`.

- `rg` uses the shared ripgrep service for both content search and file-name matching.
- `write_patch` uses Desktop Commander-style exact search/replace semantics: line-ending normalization, an expected replacement count, all-or-nothing mutation, and nearest-match feedback when exact text is missing.
- Built-in tool descriptions become compact imperative strings and their JSON Schema metadata drops prose fields. Custom and plugin tools are left unchanged.

## Experimental macro context tools

The Phase 1 macro context tools stay hidden by default and are registered only
under their documented opt-in flags:

- `OPENCODE_EXPERIMENTAL_MACRO_TOOLS=1` enables `project_dossier`,
  `view_outline`, and `semantic_search`.
- `OPENCODE_EXPERIMENTAL_CONTEXT_TOOLS=1` enables `project_dossier` and
  `view_outline`.
- `OPENCODE_EXPERIMENTAL_SEMANTIC_SEARCH=1` enables `semantic_search`.

These flags add the macro tools alongside the primitive read/search tools; they
do not replace tool defaults. `ContextIntel.Service` is part of the registry
graph whenever those tools are initialized, so macro telemetry and adoption can
be measured through the same production service path.

## Context intelligence burn-in

`opencode stats --context` appends a `CONTEXT INTELLIGENCE BURN-IN` section to
the normal stats report. The command reuses the existing session/message
traversal and summarizes shadow planner metadata, macro adoption, primitive
discovery, semantic-search cold/warm behavior, prompt pressure, projected
savings, and data gaps.

The burn-in planner is shadow-only. It can persist a compact
`step-start.metadata.contextPlan` record for observability, but it must not
change prompt content, compaction thresholds, tool defaults, `/compact`, or
active message pruning. Promotion beyond shadow mode requires sustained macro
adoption, lower primitive read/search pressure, usable `promptTokensDetails`
coverage, and no increase in re-read-after-drop or overflow-proximity signals.

## Tests

Tool tests should use the existing Effect helpers in `packages/opencode/test/lib/effect.ts`:

- Use `testEffect(...)` / `it.live(...)` instead of creating fake local wrappers around effectful tools.
- Yield the real tool export, then initialize it: `const info = yield* ReadTool`, `const tool = yield* info.init()`.
- Run tests inside a real instance with `provideTmpdirInstance(...)` or `provideInstance(tmpdirScoped(...))` so instance-scoped services resolve exactly as they do in production.

This keeps tool tests aligned with the production service graph and makes follow-up cleanup mostly mechanical.

## Exported tools

These exported tool definitions currently use `Tool.define(...)` in `src/tool`:

- [x] `apply_patch.ts`
- [x] `bash.ts`
- [x] `edit.ts`
- [x] `glob.ts`
- [x] `grep.ts`
- [x] `invalid.ts`
- [x] `lsp.ts`
- [x] `plan.ts`
- [x] `question.ts`
- [x] `read.ts`
- [x] `rg.ts`
- [x] `skill.ts`
- [x] `task.ts`
- [x] `todo.ts`
- [x] `webfetch.ts`
- [x] `websearch.ts`
- [x] `write.ts`
- [x] `write_patch.ts`

Notes:

- There is no current `ls.ts` tool file on this branch.
- `truncate.ts` is an Effect service used by tools, not a tool definition itself.
- `mcp-exa.ts`, `external-directory.ts`, and `schema.ts` are support modules, not standalone tool definitions.

## Follow-up cleanup

Most exported tools are already on the intended Effect-native shape. The remaining cleanup is narrower than the old checklist implied.

Current spot cleanups worth tracking:

- [x] `read.ts` — streams through `AppFileSystem.Service.stream` with `Stream.splitLines`; the legacy Node stream / `readline` helper is gone
- [ ] `bash.ts` — already uses Effect child-process primitives; only keep tracking shell-specific platform bridges and parser/loading details as they come up
- [ ] `webfetch.ts` — already uses `HttpClient`; remaining work is limited to smaller boundary helpers like HTML text extraction
- [ ] `file/ripgrep.ts` — adjacent to tool migration; still has raw fs/process usage that affects `grep.ts` and file-search routes
- [x] `patch/index.ts` — apply path now returns `Effect` over `AppFileSystem.Service`; the parser and chunk replacer stay pure

Notable items that are already effectively on the target path and do not need separate migration bullets right now:

- `apply_patch.ts`
- `grep.ts`
- `write.ts`
- `websearch.ts`
- `edit.ts`

## Filesystem notes

Current raw fs users that still appear relevant here:

- `file/ripgrep.ts` — `fs/promises`
