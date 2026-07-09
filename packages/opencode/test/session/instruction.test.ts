import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import path from "path"
import { Effect, FileSystem, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

import { Instruction } from "../../src/session/instruction"
import {
  InstructionParser,
  InstructionReconciler,
  InstructionRenderer,
  InstructionRouter,
} from "@cookielab/instruction"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Global } from "@opencode-ai/core/global"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Config } from "@/config/config"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [
      InstanceBootstrap.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

const configLayer = Layer.succeed(Config.Service, TestConfig.make())

const instructionLayer = (global: Partial<Global.Interface>, flags: Partial<RuntimeFlags.Info> = {}) =>
  AppNodeBuilder.build(Instruction.node, [
    [Config.node, configLayer],
    [Global.node, Global.layerWith(global)],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const provideInstruction =
  (global: Partial<Global.Interface>, flags?: Partial<RuntimeFlags.Info>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(instructionLayer(global, flags)))

const write = (filepath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(filepath), { recursive: true })
    yield* fs.writeFileString(filepath, content)
  })

const writeFiles = (dir: string, files: Record<string, string>) =>
  Effect.all(
    Object.entries(files).map(([file, content]) => write(path.join(dir, file), content)),
    { discard: true },
  )

const withFiles = <A, E, R>(files: Record<string, string>, self: (dir: string) => Effect.Effect<A, E, R>) =>
  provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      yield* writeFiles(dir, files)
      return yield* self(dir).pipe(provideInstruction({ home: dir, config: dir }))
    }),
  )

const tmpWithFiles = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* writeFiles(dir, files)
    return dir
  })

function loaded(filepath: string): SessionV1.WithParts[] {
  const sessionID = SessionID.make("session-loaded-1")
  const messageID = MessageID.make("msg_message-loaded-1")

  return [
    {
      info: {
        id: messageID,
        sessionID,
        role: "user",
        time: { created: 0 },
        agent: "build",
        model: {
          providerID: ProviderV2.ID.make("anthropic"),
          modelID: ModelV2.ID.make("claude-sonnet-4-20250514"),
        },
      },
      parts: [
        {
          id: PartID.make("prt_part-loaded-1"),
          messageID,
          sessionID,
          type: "tool",
          callID: "call-loaded-1",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: "done",
            title: "Read",
            metadata: { loaded: [filepath] },
            time: { start: 0, end: 1 },
          },
        },
      ],
    },
  ]
}

describe("structured instruction curation", () => {
  test("extracts addressable IDs, replacement notes, and unstructured fallback text", () => {
    const parsed = InstructionParser.parse([
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

    const reconciled = InstructionReconciler.reconcile(parsed.entries)
    expect(reconciled.entries.some((entry) => entry.id === "USR.RULE.OLD")).toBe(false)
    expect(reconciled.entries.some((entry) => entry.id === "USR.RULE.NEW")).toBe(true)
    expect(reconciled.replacementSuppressions).toBe(1)
  })

  test("uses narrower same-ID entries and preserves source order for remaining rules", () => {
    const parsed = InstructionParser.parse([
      { filepath: "/home/AGENTS.md", order: 0, content: "- `USR.RULE.GREEN_BUILD`: Run every build." },
      { filepath: "/repo/AGENTS.md", order: 1, content: "- `USR.RULE.GREEN_BUILD`: Run the repo build." },
      { filepath: "/repo/pkg/AGENTS.md", order: 2, content: "- `PKG.RULE.TESTS`: Run package tests." },
    ])

    const reconciled = InstructionReconciler.reconcile(parsed.entries)
    expect(reconciled.sameIdOverrides).toBe(1)
    expect(reconciled.entries.flatMap((entry) => (entry.id ? [entry.id] : []))).toEqual([
      "USR.RULE.GREEN_BUILD",
      "PKG.RULE.TESTS",
    ])
    expect(reconciled.entries[0].text).toContain("repo build")
  })

  test("routes test, PR, git, and mixed task domains conservatively", () => {
    const parsed = InstructionParser.parse([
      { filepath: "/repo/AGENTS.md", order: 0, content: "- `VER.RULE.TESTS`: Run unit tests." },
      { filepath: "/repo/AGENTS.md", order: 0, content: "- `PR.RULE.REVIEW`: Audit PR review threads." },
      { filepath: "/repo/AGENTS.md", order: 0, content: "- `GIT.RULE.WORKTREE`: Use worktrees." },
    ])
    const reconciled = InstructionReconciler.reconcile(parsed.entries)

    expect(
      InstructionRouter.route(reconciled.entries, "add unit test coverage").selected.map((entry) => entry.id),
    ).toEqual(["VER.RULE.TESTS"])
    expect(
      InstructionRouter.route(reconciled.entries, "prepare a PR review closeout").selected.map((entry) => entry.id),
    ).toEqual(["PR.RULE.REVIEW"])
    expect(
      InstructionRouter.route(reconciled.entries, "create a git worktree branch").selected.map((entry) => entry.id),
    ).toEqual(["GIT.RULE.WORKTREE"])
    expect(
      InstructionRouter.route(reconciled.entries, "create a worktree and run unit tests").selected.map(
        (entry) => entry.id,
      ),
    ).toEqual(["VER.RULE.TESTS", "GIT.RULE.WORKTREE"])
  })

  test("keeps user-level rules selected across routed task domains", () => {
    const parsed = InstructionParser.parse([
      {
        filepath: "/home/AGENTS.md",
        order: 0,
        content: "- `USR.RULE.GREEN_BUILD`: Tasks must conclude with the required passing build.",
      },
      { filepath: "/repo/AGENTS.md", order: 1, content: "- `PR.RULE.REVIEW`: Audit PR review threads." },
    ])
    const reconciled = InstructionReconciler.reconcile(parsed.entries)

    expect(
      InstructionRouter.route(reconciled.entries, "prepare a PR review closeout").selected.map((entry) => entry.id),
    ).toEqual(["USR.RULE.GREEN_BUILD", "PR.RULE.REVIEW"])
  })

  test("renders raw fallback blocks or curated compact blocks based on mode", () => {
    const sources = [
      {
        filepath: "/repo/AGENTS.md",
        order: 0,
        content: ["- `VER.RULE.TESTS`: Run unit tests.", "- `PR.RULE.REVIEW`: Audit PR review threads."].join("\n"),
      },
    ]

    const raw = InstructionRenderer.render(sources, { mode: "raw", prompt: "add unit tests" })
    expect(raw.blocks).toEqual([`Instructions from: /repo/AGENTS.md\n${sources[0].content}`])

    const curated = InstructionRenderer.render(sources, { mode: "curated", prompt: "add unit tests" })
    expect(curated.blocks).toHaveLength(1)
    expect(curated.blocks[0]).toContain("[VER.RULE.TESTS]")
    expect(curated.blocks[0]).not.toContain("[PR.RULE.REVIEW]")
    expect(curated.blocks[0]).toContain("<agent-instruction-telemetry>")
    expect(curated.telemetry?.omittedIds).toEqual(["PR.RULE.REVIEW"])
  })
})

describe("Instruction.resolve", () => {
  it.live("returns empty when AGENTS.md is at project root (already in systemPaths)", () =>
    withFiles({ "AGENTS.md": "# Root Instructions", "src/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "AGENTS.md"))).toBe(true)

        const results = yield* svc.resolve([], path.join(dir, "src", "file.ts"), MessageID.make("msg_message-test-1"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("returns AGENTS.md from subdirectory (not in systemPaths)", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "subdir", "AGENTS.md"))).toBe(false)

        const results = yield* svc.resolve(
          [],
          path.join(dir, "subdir", "nested", "file.ts"),
          MessageID.make("msg_message-test-2"),
        )
        expect(results.length).toBe(1)
        expect(results[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
      }),
    ),
  )

  it.live("doesn't reload AGENTS.md when reading it directly", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "AGENTS.md")
        const system = yield* svc.systemPaths()
        expect(system.has(filepath)).toBe(false)

        const results = yield* svc.resolve([], filepath, MessageID.make("msg_message-test-3"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("does not reattach the same nearby instructions twice for one message", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-1")

        const first = yield* svc.resolve([], filepath, id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(first[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
        expect(second).toEqual([])
      }),
    ),
  )

  it.live("clear allows nearby instructions to be attached again for the same message", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-2")

        const first = yield* svc.resolve([], filepath, id)
        yield* svc.clear(id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(second).toHaveLength(1)
        expect(second[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
      }),
    ),
  )

  it.live("skips instructions already reported by prior read metadata", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const agents = path.join(dir, "subdir", "AGENTS.md")
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-3")

        const results = yield* svc.resolve(loaded(agents), filepath, id)
        expect(results).toEqual([])
      }),
    ),
  )

  test.todo("fetches remote instructions from config URLs via HttpClient", () => {})
})

describe("Instruction.system", () => {
  it.live("loads both project and global AGENTS.md when both exist", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpWithFiles({ "AGENTS.md": "# Project Instructions" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(projectTmp, "AGENTS.md"))).toBe(true)
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)

        const rules = yield* svc.system()
        expect(rules).toHaveLength(2)
        expect(rules[0]).toBe(`Instructions from: ${path.join(globalTmp, "AGENTS.md")}\n# Global Instructions`)
        expect(rules[1]).toBe(`Instructions from: ${path.join(projectTmp, "AGENTS.md")}\n# Project Instructions`)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )

  it.live("loads hierarchical project instructions broad-to-narrow and prefers AGENTS.md within a directory", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpdirScoped()
      const projectTmp = yield* tmpdirScoped({ git: true })
      const nested = path.join(projectTmp, "pkg", "nested")
      yield* writeFiles(projectTmp, {
        "AGENTS.md": "# Root Instructions",
        "pkg/CLAUDE.md": "# Package Claude",
        "pkg/AGENTS.md": "# Package Agents",
        "pkg/nested/AGENTS.md": "# Nested Agents",
      })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = Array.from(yield* svc.systemPaths())
        expect(paths).toEqual([
          path.join(projectTmp, "AGENTS.md"),
          path.join(projectTmp, "pkg", "AGENTS.md"),
          path.join(projectTmp, "pkg", "nested", "AGENTS.md"),
        ])

        const rules = yield* svc.system()
        expect(rules).toHaveLength(3)
        expect(rules[1]).toContain("Package Agents")
        expect(rules.join("\n")).not.toContain("Package Claude")
      }).pipe(provideInstance(nested), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )

  it.live("skips project and global CLAUDE.md when Claude Code prompt is disabled", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ ".claude/CLAUDE.md": "# Global Claude" })
      const projectTmp = yield* tmpWithFiles({ "CLAUDE.md": "# Project Claude" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, ".claude", "CLAUDE.md"))).toBe(false)
        expect(paths.has(path.join(projectTmp, "CLAUDE.md"))).toBe(false)
        expect(yield* svc.system()).toEqual([])
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }, { disableClaudeCodePrompt: true }),
      )
    }),
  )
})

describe("Instruction.systemPaths global config", () => {
  it.live("uses Global.Service config AGENTS.md", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )
})
