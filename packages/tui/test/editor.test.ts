import { afterEach, expect, test } from "bun:test"
import { normalizePromptContent, normalizeTuiEditorStdio, openEditor } from "../src/editor"

const editor = process.env.EDITOR
const visual = process.env.VISUAL

afterEach(() => {
  process.env.EDITOR = editor
  process.env.VISUAL = visual
})

test("rejects when the external editor cannot start", async () => {
  delete process.env.VISUAL
  process.env.EDITOR = "opencode-editor-that-does-not-exist"
  const renderer = {
    suspend() {},
    resume() {},
    requestRender() {},
    currentRenderBuffer: { clear() {} },
  }

  await expect(openEditor({ value: "original", renderer: renderer as never })).rejects.toThrow()
})

test("normalizes a single trailing editor newline for one-line prompts", () => {
  expect(normalizePromptContent("hello\n")).toBe("hello")
  expect(normalizePromptContent("hello\r\n")).toBe("hello")
})

test("preserves multiline prompts that end with a newline", () => {
  expect(normalizePromptContent("hello\nworld\n")).toBe("hello\nworld\n")
})

test("maps inherited editor stdio to ignore during TUI mode", () => {
  const previousTui = process.env.OPENCODE_TUI
  const previousLogsValue = process.env.OPENCODE_PRINT_LOGS
  process.env.OPENCODE_TUI = "1"
  delete process.env.OPENCODE_PRINT_LOGS

  try {
    expect(normalizeTuiEditorStdio("inherit")).toBe("ignore")
    expect(normalizeTuiEditorStdio("pipe")).toBe("pipe")
    expect(normalizeTuiEditorStdio("ignore")).toBe("ignore")
  } finally {
    if (previousTui === undefined) delete process.env.OPENCODE_TUI
    else process.env.OPENCODE_TUI = previousTui

    if (previousLogsValue === undefined) delete process.env.OPENCODE_PRINT_LOGS
    else process.env.OPENCODE_PRINT_LOGS = previousLogsValue
  }
})

test("preserves editor stdio when OPENCODE_PRINT_LOGS is enabled", () => {
  const previousTui = process.env.OPENCODE_TUI
  const previousLogsValue = process.env.OPENCODE_PRINT_LOGS
  process.env.OPENCODE_TUI = "1"
  process.env.OPENCODE_PRINT_LOGS = "1"

  try {
    expect(normalizeTuiEditorStdio("inherit")).toBe("inherit")
  } finally {
    if (previousTui === undefined) delete process.env.OPENCODE_TUI
    else process.env.OPENCODE_TUI = previousTui

    if (previousLogsValue === undefined) delete process.env.OPENCODE_PRINT_LOGS
    else process.env.OPENCODE_PRINT_LOGS = previousLogsValue
  }
})
