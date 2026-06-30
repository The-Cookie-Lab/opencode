/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { JSX } from "solid-js"
import type { AssistantMessage, Part, Provider, Session } from "@opencode-ai/sdk/v2"
import { AssistantMetadataFooter } from "../../../../tui/src/routes/session/index"
import { ContextSidebarView } from "../../../../tui/src/feature-plugins/sidebar/context"
import {
  assistantContextDetailSegments,
  contextTokenDetails,
  type EnrichedStepFinishPart,
  latestStepFinish,
  sidebarContextDetailRows,
} from "../../../../tui/src/util/context-details"
import { createTuiPluginApi } from "../../fixture/tui-plugin"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

const theme = {
  text: RGBA.fromHex("#ffffff"),
  textMuted: RGBA.fromHex("#888888"),
}

const provider = {
  id: "local",
  name: "Local",
  source: "custom",
  env: [],
  options: {},
  models: {
    qwen: {
      id: "qwen",
      providerID: "local",
      api: {
        id: "qwen",
        url: "http://localhost",
        npm: "@ai-sdk/openai-compatible",
      },
      name: "Qwen",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: {
          text: true,
          audio: false,
          image: true,
          video: false,
          pdf: true,
        },
        output: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        interleaved: false,
      },
      cost: {
        input: 0,
        output: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
      limit: {
        context: 10_000,
        output: 8_192,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
    },
  },
} satisfies Provider

const assistant = {
  id: "msg_assistant",
  sessionID: "ses_test",
  role: "assistant",
  time: {
    created: 1_000,
    completed: 3_000,
  },
  parentID: "msg_user",
  modelID: "qwen",
  providerID: "local",
  mode: "build",
  agent: "build",
  path: {
    cwd: "/tmp",
    root: "/tmp",
  },
  cost: 0,
  tokens: {
    input: 1_000,
    output: 50,
    reasoning: 10,
    cache: {
      read: 500,
      write: 10,
    },
  },
  finish: "stop",
} satisfies AssistantMessage

const session = {
  id: "ses_test",
  slug: "test",
  projectID: "proj_test",
  directory: "/tmp",
  title: "Test",
  version: "1",
  cost: 0.25,
  time: {
    created: 1_000,
    updated: 2_000,
  },
} satisfies Session

const contextTokenSummary = `${(
  assistant.tokens.input +
  assistant.tokens.output +
  assistant.tokens.reasoning +
  assistant.tokens.cache.read +
  assistant.tokens.cache.write
).toLocaleString()} tokens`

function stepFinish(input: { id: string; prompt?: EnrichedStepFinishPart["promptTokensDetails"] }) {
  return {
    id: input.id,
    sessionID: "ses_test",
    messageID: assistant.id,
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: {
      input: 1_000,
      output: 50,
      reasoning: 10,
      cache: {
        read: 500,
        write: 10,
      },
    },
    promptTokensDetails: input.prompt,
  } satisfies EnrichedStepFinishPart
}

async function renderFrame(component: () => JSX.Element, options: { width?: number; height?: number } = {}) {
  testSetup = await testRender(component, {
    width: options.width ?? 80,
    height: options.height ?? 12,
  })
  await testSetup.renderOnce()
  await Bun.sleep(25)
  await testSetup.renderOnce()
  return testSetup.captureCharFrame()
}

function sidebar(parts: Part[]) {
  const api = createTuiPluginApi({
    state: {
      provider: [provider],
      session: {
        get: () => session,
        messages: () => [assistant],
      },
      part: () => parts,
    },
  })
  return <ContextSidebarView api={api} session_id="ses_test" />
}

describe("TUI context token details", () => {
  test("formats latest step-finish prompt details", () => {
    const first = stepFinish({ id: "part_1" })
    const last = stepFinish({
      id: "part_2",
      prompt: {
        messages: [{ role: "user", tokens: 900, cached: 100 }],
        tools: [{ name: "read", tokens: 300 }],
        agent_instructions: [{ tokens: 200, cached: 25 }],
        template_overhead: 40,
        image_tokens: 12,
      },
    })
    const details = contextTokenDetails(latestStepFinish([first, last]))

    expect(details).toMatchObject({
      input: 1_000,
      output: 50,
      reasoning: 10,
      cacheRead: 500,
      cacheWrite: 10,
      cachedPrompt: 125,
      tools: 300,
      instructions: 200,
      overhead: 40,
      images: 12,
      hasPromptDetails: true,
    })
    expect(assistantContextDetailSegments(details)).toContain("instructions 200")
    expect(sidebarContextDetailRows(details)).toContainEqual({ label: "instructions", value: "200" })
  })

  test("footer hides token details when collapsed and shows them after toggle", async () => {
    let toggle = () => {}

    function Harness() {
      const [open, setOpen] = createSignal(false)
      toggle = () => setOpen((prev) => !prev)
      return (
        <AssistantMetadataFooter
          accent={theme.text}
          mode="build"
          model="Qwen"
          duration={2_000}
          open={open()}
          tokenSegments={["input 1.0K↑", "output 50↓", "instructions 200"]}
          onToggle={toggle}
          theme={theme}
        />
      )
    }

    const collapsed = await renderFrame(() => <Harness />)
    expect(collapsed).toContain("Build")
    expect(collapsed).toContain("▸")
    expect(collapsed).not.toContain("instructions 200")

    toggle()
    await testSetup!.renderOnce()
    const expanded = testSetup!.captureCharFrame()
    expect(expanded).toContain("▾")
    expect(expanded).toContain("instructions 200")
  })

  test("sidebar renders prompt token details when available", async () => {
    const frame = await renderFrame(
      () =>
        sidebar([
          stepFinish({
            id: "part_1",
            prompt: {
              messages: [{ role: "user", tokens: 900, cached: 100 }],
              tools: [{ name: "read", tokens: 300 }],
              agent_instructions: [{ tokens: 200 }],
              template_overhead: 40,
              image_tokens: 0,
            },
          }),
        ]),
      { width: 42, height: 14 },
    )

    expect(frame).toContain("Context")
    expect(frame).toContain(contextTokenSummary)
    expect(frame).toContain("input")
    expect(frame).toContain("tools")
    expect(frame).toContain("instructions")
    expect(frame).toContain("overhead")
  })

  test("sidebar falls back to aggregate context when prompt details are absent", async () => {
    const frame = await renderFrame(() => sidebar([stepFinish({ id: "part_1" })]), { width: 42, height: 8 })

    expect(frame).toContain("Context")
    expect(frame).toContain(contextTokenSummary)
    expect(frame).not.toContain("input")
    expect(frame).not.toContain("instructions")
  })
})
