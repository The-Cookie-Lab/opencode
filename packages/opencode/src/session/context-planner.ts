import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { Provider } from "@/provider/provider"
import { Token } from "@/util/token"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Context, Effect, Layer } from "effect"
import { MessageV2 } from "./message-v2"
import { usable } from "./overflow"
import type { SessionID } from "./schema"

export type ContextPlannerDecision = "none" | "shadow"
export type ContextPlannerMode = "shadow"
export type ContextLedgerAction = "retain" | "summarize" | "externalize" | "refresh" | "drop"
export type ContextLedgerKind =
  | "instruction"
  | "user_request"
  | "decision"
  | "file_observation"
  | "tool_result"
  | "error"
  | "plan"
  | "retrieval"
  | "summary"

export type ContextLedgerItem = {
  kind: ContextLedgerKind
  source: { sessionID: string; messageID?: string; partID?: string; path?: string; uri?: string }
  tokens: number
  importance: number
  freshness: "fresh" | "stale" | "unknown"
  action: ContextLedgerAction
  reason: string
}

export type ContextPlan = {
  mode: ContextPlannerMode
  decision: ContextPlannerDecision
  trigger: "ratio" | "overflow-risk" | "manual-observation" | "none"
  ratio: number
  threshold: number
  projectedSavingsTokens: number
  ledger: ContextLedgerItem[]
}

export const DEFAULT_THRESHOLD = 0.5
export const OVERFLOW_RISK_THRESHOLD = 0.85
export const HYSTERESIS_DELTA = 0.05
export const HYSTERESIS_RESET_THRESHOLD = DEFAULT_THRESHOLD - HYSTERESIS_DELTA
export const LEDGER_LIMIT = 40
export const LARGE_TOOL_OUTPUT_TOKENS = 2_000
export const STALE_FILE_OBSERVATION_USER_TURNS = 3

type HysteresisState = {
  ratio: number
  userID: string | undefined
}

export interface Interface {
  readonly evaluate: (input: {
    sessionID: SessionID
    messages: SessionV1.WithParts[]
    model: Provider.Model
    agent: Agent.Info
    now: number
  }) => Effect.Effect<ContextPlan, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ContextPlanner") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const emitted = new Map<string, HysteresisState>()

    const evaluate: Interface["evaluate"] = Effect.fn("ContextPlanner.evaluate")(function* (input) {
      const modelMessages = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      const activeTokens = Token.estimate(JSON.stringify(modelMessages))
      const available = usable({
        cfg: yield* config.get(),
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
      const ratio = available > 0 ? activeTokens / available : 0
      const trigger =
        available === 0
          ? "none"
          : ratio >= OVERFLOW_RISK_THRESHOLD
            ? "overflow-risk"
            : ratio >= DEFAULT_THRESHOLD
              ? "ratio"
              : "none"
      const latestUserID = latestMessageID(input.messages, "user")
      const last = emitted.get(input.sessionID)
      const shouldEmit =
        trigger !== "none" && (!last || latestUserID !== last.userID || ratio >= last.ratio + HYSTERESIS_DELTA)
      if (ratio < HYSTERESIS_RESET_THRESHOLD) emitted.delete(input.sessionID)
      if (shouldEmit) emitted.set(input.sessionID, { ratio, userID: latestUserID })
      const ledger = buildLedger(input.messages, input.sessionID)
      return {
        mode: "shadow",
        decision: shouldEmit ? "shadow" : "none",
        trigger,
        ratio: roundRatio(ratio),
        threshold: DEFAULT_THRESHOLD,
        projectedSavingsTokens: projectedSavings(ledger),
        ledger,
      }
    })

    return Service.of({ evaluate })
  }),
)

export const defaultLayer = Layer.suspend(() => LayerNode.compile(node))

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Config.node, RuntimeFlags.node],
})

type LedgerCandidate = ContextLedgerItem & {
  order: number
  userTurnsAfter: number
}

function buildLedger(messages: SessionV1.WithParts[], sessionID: SessionID): ContextLedgerItem[] {
  const ordered = messages.toSorted((a, b) => a.info.id.localeCompare(b.info.id))
  const latestUserID = latestMessageID(ordered, "user")
  const latestAssistantID = latestMessageID(ordered, "assistant")
  const newestByPath = newestObservationByPath(ordered)
  const candidates: LedgerCandidate[] = []
  let userTurn = 0
  let order = 0
  const userTurnByMessage = new Map<string, number>()

  for (const message of ordered) {
    if (message.info.role === "user") userTurn++
    userTurnByMessage.set(message.info.id, userTurn)
  }
  const latestUserTurn = userTurn

  for (const message of ordered) {
    const turnsAfter = latestUserTurn - (userTurnByMessage.get(message.info.id) ?? latestUserTurn)
    if (message.info.role === "assistant" && message.info.error) {
      candidates.push({
        kind: "error",
        source: { sessionID, messageID: message.info.id },
        tokens: 0,
        importance: 0.95,
        freshness: "fresh",
        action: "retain",
        reason: "assistant error",
        order: order++,
        userTurnsAfter: turnsAfter,
      })
    }

    for (const part of message.parts) {
      if (part.type === "text") {
        const latest = message.info.id === latestUserID
        const assistantLatest = message.info.id === latestAssistantID
        candidates.push({
          kind: message.info.role === "user" ? "user_request" : "decision",
          source: { sessionID, messageID: message.info.id, partID: part.id },
          tokens: Token.estimate(part.text),
          importance: latest || assistantLatest ? 1 : 0.55,
          freshness: latest || assistantLatest ? "fresh" : "unknown",
          action: latest || assistantLatest ? "retain" : "summarize",
          reason: latest || assistantLatest ? "latest turn" : "older conversational text",
          order: order++,
          userTurnsAfter: turnsAfter,
        })
      }

      if (part.type === "compaction") {
        candidates.push({
          kind: "summary",
          source: { sessionID, messageID: message.info.id, partID: part.id },
          tokens: 0,
          importance: 0.9,
          freshness: "fresh",
          action: "retain",
          reason: "existing compaction marker",
          order: order++,
          userTurnsAfter: turnsAfter,
        })
      }

      if (part.type === "tool") {
        candidates.push(toolCandidate(part, message, sessionID, turnsAfter, order++, newestByPath))
      }
    }
  }

  return candidates
    .toSorted((a, b) => b.importance - a.importance || b.tokens - a.tokens || a.order - b.order)
    .slice(0, LEDGER_LIMIT)
    .map(({ order: _, userTurnsAfter: __, ...item }) => item)
}

function toolCandidate(
  part: SessionV1.ToolPart,
  message: SessionV1.WithParts,
  sessionID: SessionID,
  userTurnsAfter: number,
  order: number,
  newestByPath: Map<string, string>,
): LedgerCandidate {
  const path = toolPath(part)
  const output =
    part.state.status === "completed" ? part.state.output : part.state.status === "error" ? part.state.error : ""
  const tokens = Token.estimate(output)
  const fileObservation = isFileObservationTool(part.tool)
  const macro = isMacroTool(part.tool)
  const currentObservation = !path || newestByPath.get(path) === part.id
  const stale = fileObservation && userTurnsAfter >= STALE_FILE_OBSERVATION_USER_TURNS
  const large =
    part.state.status === "completed" && (tokens >= LARGE_TOOL_OUTPUT_TOKENS || part.state.time.compacted !== undefined)
  const action: ContextLedgerAction =
    part.state.status === "error"
      ? "retain"
      : fileObservation && !currentObservation
        ? "drop"
        : stale
          ? "refresh"
          : large
            ? "externalize"
            : macro && userTurnsAfter === 0
              ? "retain"
              : tokens > 0
                ? "summarize"
                : "retain"
  return {
    kind: part.state.status === "error" ? "error" : fileObservation ? "file_observation" : "tool_result",
    source: { sessionID, messageID: message.info.id, partID: part.id, path },
    tokens,
    importance: part.state.status === "error" ? 0.95 : macro ? 0.8 : fileObservation ? 0.7 : 0.45,
    freshness: stale ? "stale" : userTurnsAfter === 0 ? "fresh" : "unknown",
    action,
    reason: actionReason(action, part.tool),
    order,
    userTurnsAfter,
  }
}

function newestObservationByPath(messages: SessionV1.WithParts[]) {
  const result = new Map<string, string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || !isFileObservationTool(part.tool)) continue
      const path = toolPath(part)
      if (!path) continue
      result.set(path, part.id)
    }
  }
  return result
}

function latestMessageID(messages: SessionV1.WithParts[], role: "user" | "assistant") {
  return messages
    .filter((message) => message.info.role === role)
    .toSorted((a, b) => b.info.id.localeCompare(a.info.id))[0]?.info.id
}

function toolPath(part: SessionV1.ToolPart) {
  const input = part.state.input
  const fromInput = stringField(input, "filePath") ?? stringField(input, "path")
  const metadata =
    part.state.status === "completed" || part.state.status === "running" || part.state.status === "error"
      ? part.state.metadata
      : undefined
  return fromInput ?? stringField(metadata, "path") ?? stringField(metadata, "cwd")
}

function stringField(input: Record<string, unknown> | undefined, key: string) {
  const value = input?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isMacroTool(tool: string) {
  return tool === "project_dossier" || tool === "view_outline" || tool === "semantic_search"
}

function isFileObservationTool(tool: string) {
  return (
    tool === "read" ||
    tool === "view_outline" ||
    tool === "semantic_search" ||
    tool === "grep" ||
    tool === "glob" ||
    tool === "rg"
  )
}

function actionReason(action: ContextLedgerAction, tool: string) {
  switch (action) {
    case "retain":
      return `${tool} remains relevant`
    case "summarize":
      return `${tool} can be summarized`
    case "externalize":
      return `${tool} output is large`
    case "refresh":
      return `${tool} observation may be stale`
    case "drop":
      return `${tool} has a newer duplicate observation`
  }
}

function projectedSavings(ledger: ContextLedgerItem[]) {
  return Math.round(
    ledger.reduce((total, item) => {
      if (item.action === "drop") return total + item.tokens
      if (item.action === "externalize") return total + Math.round(item.tokens * 0.9)
      if (item.action === "summarize") return total + Math.round(item.tokens * 0.7)
      return total
    }, 0),
  )
}

function roundRatio(value: number) {
  return Math.round(value * 1_000) / 1_000
}

export * as ContextPlanner from "./context-planner"
