import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { ToolJsonSchema } from "../../src/tool/json-schema"

// Each tool exports its parameters schema at module scope so this test can
// import them without running the tool's Effect-based init. The JSON Schema
// snapshot captures what the LLM sees; the parse assertions pin down the
// accepts/rejects contract. `ToolJsonSchema.fromSchema` is the same helper `session/
// prompt.ts` uses to emit tool schemas to the LLM, so the snapshots stay
// provider-compatible while tools use Effect Schema internally.

import { Parameters as ApplyPatch } from "../../src/tool/apply_patch"
import { Parameters as Edit } from "../../src/tool/edit"
import { Parameters as Glob } from "../../src/tool/glob"
import { Parameters as Grep } from "../../src/tool/grep"
import { Parameters as Invalid } from "../../src/tool/invalid"
import { Parameters as Lsp } from "../../src/tool/lsp"
import { Parameters as MemRead } from "../../src/tool/memread"
import { Parameters as MemSearch } from "../../src/tool/memsearch"
import { Parameters as Plan } from "../../src/tool/plan"
import { Parameters as ProjectDossier } from "../../src/tool/project_dossier"
import { Parameters as Question } from "../../src/tool/question"
import { Parameters as Read } from "../../src/tool/read"
import { Parameters as Rg } from "../../src/tool/rg"
import { Parameters as SemanticSearch } from "../../src/tool/semantic_search"
import { Parameters as Shell } from "../../src/tool/shell"
import { Parameters as Skill } from "../../src/tool/skill"
import { Parameters as Task } from "../../src/tool/task"
import { Parameters as Todo } from "../../src/tool/todo"
import { Parameters as ViewOutline } from "../../src/tool/view_outline"
import { Parameters as WebFetch } from "../../src/tool/webfetch"
import { Parameters as WebSearch } from "../../src/tool/websearch"
import { Parameters as Write } from "../../src/tool/write"
import { Parameters as WritePatch } from "../../src/tool/write_patch"

const parse = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema)(input)

const accepts = (schema: Schema.Decoder<unknown>, input: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(input))

const toJsonSchema = ToolJsonSchema.fromSchema

describe("tool parameters", () => {
  describe("JSON Schema (wire shape)", () => {
    test("apply_patch", () => expect(toJsonSchema(ApplyPatch)).toMatchSnapshot())
    test("bash", () => expect(toJsonSchema(Shell)).toMatchSnapshot())
    test("edit", () => expect(toJsonSchema(Edit)).toMatchSnapshot())
    test("glob", () => expect(toJsonSchema(Glob)).toMatchSnapshot())
    test("grep", () => expect(toJsonSchema(Grep)).toMatchSnapshot())
    test("invalid", () => expect(toJsonSchema(Invalid)).toMatchSnapshot())
    test("lsp", () => expect(toJsonSchema(Lsp)).toMatchSnapshot())
    test("memread", () => expect(toJsonSchema(MemRead)).toMatchSnapshot())
    test("memsearch", () => expect(toJsonSchema(MemSearch)).toMatchSnapshot())
    test("plan", () => expect(toJsonSchema(Plan)).toMatchSnapshot())
    test("project_dossier", () => expect(toJsonSchema(ProjectDossier)).toMatchSnapshot())
    test("question", () => expect(toJsonSchema(Question)).toMatchSnapshot())
    test("read", () => expect(toJsonSchema(Read)).toMatchSnapshot())
    test("rg", () => expect(toJsonSchema(Rg)).toMatchSnapshot())
    test("semantic_search", () => expect(toJsonSchema(SemanticSearch)).toMatchSnapshot())
    test("skill", () => expect(toJsonSchema(Skill)).toMatchSnapshot())
    test("task", () => expect(toJsonSchema(Task)).toMatchSnapshot())
    test("todo", () => expect(toJsonSchema(Todo)).toMatchSnapshot())
    test("view_outline", () => expect(toJsonSchema(ViewOutline)).toMatchSnapshot())
    test("webfetch", () => expect(toJsonSchema(WebFetch)).toMatchSnapshot())
    test("websearch", () => expect(toJsonSchema(WebSearch)).toMatchSnapshot())
    test("write", () => expect(toJsonSchema(Write)).toMatchSnapshot())
    test("write_patch", () => expect(toJsonSchema(WritePatch)).toMatchSnapshot())

    test("inlines named child schemas for provider compatibility", () => {
      const schema = toJsonSchema(Question)
      expect(schema).not.toHaveProperty("$defs")
      expect(schema).toMatchObject({
        properties: {
          questions: { items: { properties: { options: { items: { properties: { label: { type: "string" } } } } } } },
        },
      })
    })

    test("preserves required nullable fields", () => {
      expect(toJsonSchema(Schema.Struct({ value: Schema.NullOr(Schema.String) }))).toMatchObject({
        properties: { value: { anyOf: expect.arrayContaining([{ type: "null" }]) } },
      })
    })

    test("keeps repeated allOf constraints instead of dropping duplicates", () => {
      expect(
        toJsonSchema(
          Schema.Struct({ value: Schema.String.check(Schema.isPattern(/^a/)).check(Schema.isPattern(/z$/)) }),
        ),
      ).toMatchObject({ properties: { value: { allOf: [{ pattern: "^a" }, { pattern: "z$" }] } } })
    })

    test("bounds bare integer fields to safe integer range", () => {
      expect(toJsonSchema(Schema.Struct({ value: Schema.Int }))).toMatchObject({
        properties: { value: { minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER } },
      })
    })

    test("does not expose defaulted optional keys as nullable", () => {
      expect(toJsonSchema(WebFetch)).toMatchObject({
        properties: { format: { type: "string", enum: ["text", "markdown", "html"], default: "markdown" } },
      })
      expect(toJsonSchema(WebFetch).properties?.format).not.toHaveProperty("anyOf")
    })
  })

  describe("apply_patch", () => {
    test("accepts patchText", () => {
      expect(parse(ApplyPatch, { patchText: "*** Begin Patch\n*** End Patch" })).toEqual({
        patchText: "*** Begin Patch\n*** End Patch",
      })
    })
    test("rejects missing patchText", () => {
      expect(accepts(ApplyPatch, {})).toBe(false)
    })
    test("rejects non-string patchText", () => {
      expect(accepts(ApplyPatch, { patchText: 123 })).toBe(false)
    })
  })

  describe("shell", () => {
    test("accepts command", () => {
      expect(parse(Shell, { command: "ls" })).toEqual({ command: "ls" })
    })
    test("accepts optional timeout + workdir", () => {
      const parsed = parse(Shell, { command: "ls", timeout: 5000, workdir: "/tmp" })
      expect(parsed.timeout).toBe(5000)
      expect(parsed.workdir).toBe("/tmp")
    })
    test("rejects missing command", () => {
      expect(accepts(Shell, {})).toBe(false)
    })
  })

  describe("edit", () => {
    test("accepts all four fields", () => {
      expect(parse(Edit, { filePath: "/a", oldString: "x", newString: "y", replaceAll: true })).toEqual({
        filePath: "/a",
        oldString: "x",
        newString: "y",
        replaceAll: true,
      })
    })
    test("replaceAll is optional", () => {
      const parsed = parse(Edit, { filePath: "/a", oldString: "x", newString: "y" })
      expect(parsed.replaceAll).toBeUndefined()
    })
    test("rejects missing filePath", () => {
      expect(accepts(Edit, { oldString: "x", newString: "y" })).toBe(false)
    })
  })

  describe("glob", () => {
    test("accepts pattern-only", () => {
      expect(parse(Glob, { pattern: "**/*.ts" })).toEqual({ pattern: "**/*.ts" })
    })
    test("accepts optional path", () => {
      expect(parse(Glob, { pattern: "**/*.ts", path: "/tmp" }).path).toBe("/tmp")
    })
    test("rejects missing pattern", () => {
      expect(accepts(Glob, {})).toBe(false)
    })
  })

  describe("grep", () => {
    test("accepts pattern-only", () => {
      expect(parse(Grep, { pattern: "TODO" })).toEqual({ pattern: "TODO" })
    })
    test("accepts optional path + include", () => {
      const parsed = parse(Grep, { pattern: "TODO", path: "/tmp", include: "*.ts" })
      expect(parsed.path).toBe("/tmp")
      expect(parsed.include).toBe("*.ts")
    })
    test("rejects missing pattern", () => {
      expect(accepts(Grep, {})).toBe(false)
    })
  })

  describe("invalid", () => {
    test("accepts tool + error", () => {
      expect(parse(Invalid, { tool: "foo", error: "bar" })).toEqual({ tool: "foo", error: "bar" })
    })
    test("rejects missing fields", () => {
      expect(accepts(Invalid, { tool: "foo" })).toBe(false)
      expect(accepts(Invalid, { error: "bar" })).toBe(false)
    })
  })

  describe("lsp", () => {
    test("accepts all fields", () => {
      const parsed = parse(Lsp, { operation: "hover", filePath: "/a.ts", line: 1, character: 1 })
      expect(parsed.operation).toBe("hover")
    })
    test("rejects line < 1", () => {
      expect(accepts(Lsp, { operation: "hover", filePath: "/a.ts", line: 0, character: 1 })).toBe(false)
    })
    test("rejects character < 1", () => {
      expect(accepts(Lsp, { operation: "hover", filePath: "/a.ts", line: 1, character: 0 })).toBe(false)
    })
    test("rejects unknown operation", () => {
      expect(accepts(Lsp, { operation: "bogus", filePath: "/a.ts", line: 1, character: 1 })).toBe(false)
    })
  })

  describe("memread", () => {
    test("accepts uri-only", () => {
      expect(parse(MemRead, { uri: "viking://resources/codex-memories/MEMORY.md" })).toEqual({
        uri: "viking://resources/codex-memories/MEMORY.md",
      })
    })
    test("accepts optional level", () => {
      expect(parse(MemRead, { uri: "viking://resources/skills-library", level: "overview" }).level).toBe(
        "overview",
      )
    })
    test("rejects unknown level", () => {
      expect(accepts(MemRead, { uri: "viking://resources/skills-library", level: "full" })).toBe(false)
    })
    test("rejects missing uri", () => {
      expect(accepts(MemRead, {})).toBe(false)
    })
  })

  describe("memsearch", () => {
    test("accepts query-only", () => {
      expect(parse(MemSearch, { query: "prior decision" })).toEqual({ query: "prior decision" })
    })
    test("accepts all optional fields", () => {
      const parsed = parse(MemSearch, {
        query: "prior decision",
        target_uri: "viking://resources/codex-memories",
        mode: "deep",
        limit: 5,
        score_threshold: 0.2,
      })
      expect(parsed.mode).toBe("deep")
      expect(parsed.limit).toBe(5)
      expect(parsed.score_threshold).toBe(0.2)
    })
    test("rejects unknown mode", () => {
      expect(accepts(MemSearch, { query: "prior decision", mode: "semantic" })).toBe(false)
    })
    test("rejects non-positive limit", () => {
      expect(accepts(MemSearch, { query: "prior decision", limit: 0 })).toBe(false)
    })
    test("rejects missing query", () => {
      expect(accepts(MemSearch, {})).toBe(false)
    })
  })

  describe("plan", () => {
    test("accepts empty object", () => {
      expect(parse(Plan, {})).toEqual({})
    })
  })

  describe("project_dossier", () => {
    test("accepts empty object", () => {
      expect(parse(ProjectDossier, {})).toEqual({})
    })
    test("allows legacy extra fields as ignored no-op input", () => {
      expect(parse(ProjectDossier, { unused: true })).toEqual({ unused: true })
    })
  })

  describe("question", () => {
    test("accepts questions array", () => {
      const parsed = parse(Question, {
        questions: [
          {
            question: "pick one",
            header: "Header",
            custom: false,
            options: [{ label: "a", description: "desc" }],
          },
        ],
      })
      expect(parsed.questions.length).toBe(1)
    })
    test("rejects missing questions", () => {
      expect(accepts(Question, {})).toBe(false)
    })
  })

  describe("read", () => {
    test("accepts filePath-only", () => {
      expect(parse(Read, { filePath: "/a" }).filePath).toBe("/a")
    })
    test("accepts optional offset + limit", () => {
      const parsed = parse(Read, { filePath: "/a", offset: 10, limit: 100 })
      expect(parsed.offset).toBe(10)
      expect(parsed.limit).toBe(100)
    })
  })

  describe("rg", () => {
    test("accepts content search", () => {
      expect(parse(Rg, { pattern: "TODO", path: "/tmp", glob: "*.ts" })).toEqual({
        pattern: "TODO",
        path: "/tmp",
        glob: "*.ts",
      })
    })
    test("accepts files mode and search options", () => {
      const parsed = parse(Rg, {
        pattern: "**/*.ts",
        mode: "files",
        literal: true,
        ignoreCase: true,
        hidden: false,
        max: 10,
      })
      expect(parsed.mode).toBe("files")
      expect(parsed.max).toBe(10)
    })
    test("rejects missing pattern and invalid mode", () => {
      expect(accepts(Rg, {})).toBe(false)
      expect(accepts(Rg, { pattern: "x", mode: "bad" })).toBe(false)
    })
  })

  describe("semantic_search", () => {
    test("accepts query-only", () => {
      expect(parse(SemanticSearch, { query: "auth token refresh" })).toEqual({ query: "auth token refresh" })
    })
    test("accepts optional scope, max, and mode", () => {
      const parsed = parse(SemanticSearch, { query: "runner", path: "src", max: 5, mode: "semantic" })
      expect(parsed.mode).toBe("semantic")
      expect(parsed.max).toBe(5)
    })
    test("rejects missing query, invalid mode, and non-positive max", () => {
      expect(accepts(SemanticSearch, {})).toBe(false)
      expect(accepts(SemanticSearch, { query: "x", mode: "bad" })).toBe(false)
      expect(accepts(SemanticSearch, { query: "x", max: 0 })).toBe(false)
    })
  })

  describe("skill", () => {
    test("accepts name", () => {
      expect(parse(Skill, { name: "foo" }).name).toBe("foo")
    })
    test("rejects missing name", () => {
      expect(accepts(Skill, {})).toBe(false)
    })
  })

  describe("task", () => {
    test("accepts description + prompt + subagent_type", () => {
      const parsed = parse(Task, { description: "d", prompt: "p", subagent_type: "general" })
      expect(parsed.subagent_type).toBe("general")
    })
    test("accepts optional background flag", () => {
      const parsed = parse(Task, { description: "d", prompt: "p", subagent_type: "general", background: true })
      expect(parsed.background).toBe(true)
    })
    test("rejects missing prompt", () => {
      expect(accepts(Task, { description: "d", subagent_type: "general" })).toBe(false)
    })
  })

  describe("todo", () => {
    test("accepts todos array", () => {
      const parsed = parse(Todo, {
        todos: [{ id: "t1", content: "do x", status: "pending", priority: "medium" }],
      })
      expect(parsed.todos.length).toBe(1)
    })
    test("rejects missing todos", () => {
      expect(accepts(Todo, {})).toBe(false)
    })
  })

  describe("view_outline", () => {
    test("accepts path-only", () => {
      expect(parse(ViewOutline, { path: "src/index.ts" })).toEqual({ path: "src/index.ts" })
    })
    test("accepts maxSymbols and includePrivate", () => {
      const parsed = parse(ViewOutline, { path: "src/index.ts", maxSymbols: 20, includePrivate: true })
      expect(parsed.maxSymbols).toBe(20)
      expect(parsed.includePrivate).toBe(true)
    })
    test("rejects missing path and non-positive maxSymbols", () => {
      expect(accepts(ViewOutline, {})).toBe(false)
      expect(accepts(ViewOutline, { path: "src/index.ts", maxSymbols: 0 })).toBe(false)
    })
  })

  describe("webfetch", () => {
    test("defaults omitted format to markdown", () => {
      expect(parse(WebFetch, { url: "https://example.com" })).toEqual({
        url: "https://example.com",
        format: "markdown",
      })
      expect(parse(WebFetch, { url: "https://example.com", format: undefined })).toEqual({
        url: "https://example.com",
        format: "markdown",
      })
    })
  })

  describe("websearch", () => {
    test("accepts query", () => {
      expect(parse(WebSearch, { query: "opencode" }).query).toBe("opencode")
    })
  })

  describe("write", () => {
    test("accepts content + filePath", () => {
      expect(parse(Write, { content: "hi", filePath: "/a" })).toEqual({ content: "hi", filePath: "/a" })
    })
    test("rejects missing filePath", () => {
      expect(accepts(Write, { content: "hi" })).toBe(false)
    })
  })

  describe("write_patch", () => {
    test("accepts exact replacement", () => {
      expect(parse(WritePatch, { path: "/a", old: "before", new: "after" })).toEqual({
        path: "/a",
        old: "before",
        new: "after",
      })
    })
    test("accepts positive replacement count", () => {
      expect(parse(WritePatch, { path: "/a", old: "x", new: "y", count: 2 }).count).toBe(2)
    })
    test("rejects missing fields and non-positive count", () => {
      expect(accepts(WritePatch, { path: "/a", old: "x" })).toBe(false)
      expect(accepts(WritePatch, { path: "/a", old: "x", new: "y", count: 0 })).toBe(false)
    })
  })
})
