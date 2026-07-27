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

`resolve-sources` v2 ports Codex always-loaded / context-routed file selection into this package. Codex curated mode calls the CLI without shipping file bodies from Python.

## Client adapters

| Client | Adapter |
| --- | --- |
| OpenCode | Build-integrated mirror with `.cat-source.json` hash/parity guard |
| Cursor | CAT Python adapter; curated mode invokes this packaged CLI directly |
| Codex | CAT lifecycle adapter; curated mode invokes this packaged CLI directly |

The compatibility renderer remains the default until the planned instruction
correctness review. Setting `CAT_INSTRUCTION_MODE=curated` selects the shared
CLI without returning ownership to model-server.

## Client sync

```sh
./cookielab clients sync all --json
./cookielab status --verbose --json
```
