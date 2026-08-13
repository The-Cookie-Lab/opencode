# CAT instruction curation

Shared agent instruction curation for CookieLab clients.

## Layout

- `src/` — parser, reconciler, router, renderer, resolve-sources v2, session deltas, suppress manifest
- `cli/instruction-cli.ts` — JSON CLI used by thin client hook adapters
- `tests/` — unit tests

## CLI

```sh
bun run cli/instruction-cli.ts render --cwd "$PWD" --mode curated --json
bun run cli/instruction-cli.ts render --cwd "$PWD" --prompt "open a PR" --delta --json
bun run cli/instruction-cli.ts resolve-sources --cwd "$PWD" --prompt "use sdl-mcp" --json
bun run cli/instruction-cli.ts suppress-patterns --global-agents ~/.codex/AGENTS.md --json
bun run cli/instruction-cli.ts doctor-smoke --cwd "$PWD" --json
```

Render stdin JSON:

```json
{
  "mode": "curated",
  "cwd": "/path/to/workspace",
  "prompt": "optional",
  "event": "preToolUse",
  "delta": true,
  "previous_profile": null,
  "global_agents_paths": ["~/.codex/AGENTS.md"],
  "client": "cursor"
}
```

Output:

```json
{
  "blocks": ["<agent-instructions mode=\"curated\" update=\"snapshot\" ...>..."],
  "telemetry": { "event": "agent_instruction_injection", "injectionHash": "..." },
  "source_paths": ["/abs/AGENTS.md"],
  "update": "snapshot",
  "profile": { "profileHash": "...", "sourcePaths": [] }
}
```

`resolve-sources` v2 ports Codex always-loaded and context-routed file selection into this package. It resolves selected route files before rendering; OMP delegates the selected bodies to this shared renderer without sending instruction bodies through a model-server asset path.

OMP prompt curation transforms exactly one later, line-delimited native
`<repo-rules>` block. It preserves system-prompt block 0 and every suffix
block, parses exact `<file>` children, applies bounded `$CODEX_HOME` route
resolution, and fails open for malformed or ambiguous regions. Recuration is
idempotent. The branch `cat-instruction-profile` custom entry carries a
complete task-domain snapshot; model-facing output omits source paths and
telemetry, while the owner-side event retains only hashes, counts, lengths,
and safe domains.

## Client adapters

| Client | Adapter |
| --- | --- |
| OpenCode | Build-integrated mirror with `.cat-source.json` hash/parity guard |
| Cursor | CAT Python adapter; curated mode invokes this packaged CLI directly |
| Codex | CAT lifecycle adapter; curated mode invokes this packaged CLI directly |
| OMP | `before_agent_start` adapter; curated prompt replacement is default-on |

`CAT_INSTRUCTION_MODE=curated` selects the shared CLI for adapters that expose
that switch. OMP uses `CAT_OMP_INSTRUCTION_MODE=curated` by default; setting
`CAT_OMP_INSTRUCTION_MODE=native` leaves the native prompt unchanged as the
explicit rollback.

## Client sync

```sh
./cookielab clients sync all --json
./cookielab status --verbose --json
```
