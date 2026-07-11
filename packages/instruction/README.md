# CookieLayer instruction curation

Shared agent instruction curation for CookieLab clients (OpenCode, Cursor, Codex).

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
| OpenCode | Native import `@cookielab/instruction` from `instruction.ts` |
| Cursor | `cookielayer-instruction.py` + `cookielayer-pre-tool-use.py` via `config sync cursor` |
| Codex | `codex-instruction-loader` with `CODEX_INSTRUCTION_MODE=curated` → CLI |

## Cursor sync

```sh
./cookielab model-server config sync cursor --json
./cookielab model-server config sync cursor --remove-instruction-hook --json
./cookielab model-server processors instruction client doctor cursor --json
```
