import { RuntimeFlags } from "@/effect/runtime-flags"
import { Global } from "@opencode-ai/core/global"
import { Log } from "@opencode-ai/core/util/log"
import { createHash } from "crypto"
import { Context, Effect, Layer } from "effect"
import { appendFile, mkdir } from "fs/promises"
import path from "path"

export type Mode = "off" | "standard" | "verbose"

export type EventName =
  | "turn.started"
  | "tool.called"
  | "tool.settled"
  | "skill.loaded"
  | "memory.search"
  | "memory.read"
  | "turn.summary"
  | "session.summary"
  | "sink.health"

export type TokenValue =
  | number
  | {
      value: number
      exact: boolean
      source?: string
    }

export type Entity = {
  kind?: string
  name?: string
  uri?: string
}

export type RecordInput = {
  event: EventName
  sessionID?: string
  messageID?: string
  stepIndex?: number
  callID?: string
  entity?: Entity
  status?: string
  durationMs?: number
  tokens?: Record<string, TokenValue>
  args?: unknown
  metadata?: Record<string, unknown>
  error?: unknown
}

export type TelemetryHealth = {
  queued: number
  dropped: number
  sinkErrors: number
  written: number
  file: string
}

export type TelemetryEvent = {
  schema_version: 1
  mode: Exclude<Mode, "off">
  run_id: string
  sequence: number
  time: string
  event: EventName
  session_id?: string
  message_id?: string
  step_index?: number
  call_id?: string
  entity?: Entity
  status?: string
  duration_ms?: number
  tokens?: Record<string, TokenValue>
  args?: unknown
  metadata?: Record<string, unknown>
  error?: Record<string, unknown>
}

export interface Interface {
  readonly mode: Mode
  readonly record: (input: RecordInput) => Effect.Effect<void>
  readonly health: () => Effect.Effect<TelemetryHealth>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BurnInTelemetry") {}

const log = Log.create({ service: "burnin.telemetry" })
const queueLimit = 1_000
const drainBatchSize = 100
const maxStandardEventBytes = 16 * 1024
const maxVerboseEventBytes = 64 * 1024
const maxVerboseStringChars = 2_048
const maxPreviewChars = 512
const safeScalarKeys = new Set([
  "cwd",
  "file",
  "filePath",
  "level",
  "limit",
  "mode",
  "name",
  "path",
  "pattern",
  "source",
  "status",
  "target_uri",
  "uri",
])
const secretKeyPattern = /(?:api[_-]?key|authorization|credential|password|secret|token)/i

export const noop: Interface = {
  mode: "off",
  record: () => Effect.void,
  health: () => Effect.succeed({ queued: 0, dropped: 0, sinkErrors: 0, written: 0, file: "" }),
}

export function modeFromValue(value: unknown): Mode {
  if (value === "standard" || value === "verbose") return value
  return "off"
}

export function estimateTokens(input: unknown) {
  const text = typeof input === "string" ? input : stableStringify(input)
  return Math.max(0, Math.ceil(text.length / 4))
}

export function sanitizeForPersistence(input: unknown) {
  return sanitizeValue(input, "verbose", 0)
}

export function outputSummary(input: unknown, mode: Exclude<Mode, "off">) {
  const text = typeof input === "string" ? input : stableStringify(input)
  const result: Record<string, unknown> = {
    chars: text.length,
    sha256: sha256(text),
  }
  if (mode === "verbose") result.preview = truncate(text, maxPreviewChars)
  return result
}

export function normalizeTelemetryEvent(
  input: RecordInput,
  options: {
    mode: Exclude<Mode, "off">
    runID: string
    sequence: number
    now?: Date
  },
): TelemetryEvent {
  const event: TelemetryEvent = {
    schema_version: 1,
    mode: options.mode,
    run_id: options.runID,
    sequence: options.sequence,
    time: (options.now ?? new Date()).toISOString(),
    event: input.event,
    session_id: input.sessionID,
    message_id: input.messageID,
    step_index: input.stepIndex,
    call_id: input.callID,
    entity: compactEntity(input.entity),
    status: input.status,
    duration_ms: finiteNumber(input.durationMs),
    tokens: compactTokenRecord(input.tokens),
    args: input.args === undefined ? undefined : sanitizeValue(input.args, options.mode, 0),
    metadata: sanitizeMetadata(input.metadata, options.mode),
    error: errorEnvelope(input.error),
  }
  return compactRecord(event) as TelemetryEvent
}

export function lineForEvent(input: TelemetryEvent) {
  return JSON.stringify(capEvent(input)) + "\n"
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    const mode = modeFromValue(flags.burnInTelemetry)
    const runID = safeRunID(process.env.OPENCODE_RUN_ID ?? `${process.pid}-${new Date().toISOString()}`)
    const directory = path.join(Global.Path.log, "burnin")
    const file = path.join(directory, `${runID}.ndjson`)
    const state = {
      queue: [] as string[],
      draining: false,
      dropped: 0,
      sinkErrors: 0,
      written: 0,
      sequence: 0,
    }

    const health = () => ({
      queued: state.queue.length,
      dropped: state.dropped,
      sinkErrors: state.sinkErrors,
      written: state.written,
      file,
    })

    const drain = async () => {
      try {
        await mkdir(directory, { recursive: true })
        while (state.queue.length > 0) {
          const batch = state.queue.splice(0, drainBatchSize)
          await appendFile(file, batch.join(""), "utf8")
          state.written += batch.length
        }
      } catch (cause) {
        const lost = state.queue.length
        state.dropped += lost
        state.queue.length = 0
        state.sinkErrors++
        log.warn("sink failed", {
          file,
          lost,
          error: cause instanceof Error ? cause.message : String(cause),
        })
      } finally {
        state.draining = false
        if (state.queue.length > 0) scheduleDrain()
      }
    }

    const scheduleDrain = () => {
      if (state.draining) return
      state.draining = true
      queueMicrotask(() => {
        void drain()
      })
    }

    const enqueue = (input: RecordInput) => {
      if (mode === "off") return
      const event = normalizeTelemetryEvent(input, {
        mode,
        runID,
        sequence: ++state.sequence,
      })
      const line = lineForEvent(event)
      if (state.queue.length >= queueLimit) {
        state.dropped++
        return
      }
      state.queue.push(line)
      scheduleDrain()
    }

    return Service.of({
      mode,
      record: (input) => Effect.sync(() => enqueue(input)),
      health: () => Effect.sync(health),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(RuntimeFlags.defaultLayer))

function compactEntity(entity: Entity | undefined) {
  if (!entity) return undefined
  return compactRecord(entity)
}

function sanitizeMetadata(input: Record<string, unknown> | undefined, mode: Exclude<Mode, "off">) {
  if (!input) return undefined
  const sanitized = sanitizeValue(input, mode, 0)
  return typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : undefined
}

function sanitizeValue(input: unknown, mode: Exclude<Mode, "off">, depth: number): unknown {
  if (input === undefined) return undefined
  if (input === null) return null
  if (typeof input === "number" || typeof input === "boolean") return input
  if (typeof input === "string") {
    if (mode === "verbose") return truncate(input, maxVerboseStringChars)
    return stringSummary(input)
  }
  if (typeof input !== "object") return { type: typeof input }
  if (depth >= 4) return structuralSummary(input)
  if (Array.isArray(input)) {
    if (mode === "standard") return structuralSummary(input)
    return input.slice(0, 20).map((item) => sanitizeValue(item, mode, depth + 1))
  }
  const object = input as Record<string, unknown>
  if (mode === "standard") return sanitizeStandardObject(object)
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(object).slice(0, 80)) {
    result[key] = secretKeyPattern.test(key) ? { redacted: true } : sanitizeValue(value, mode, depth + 1)
  }
  return result
}

function sanitizeStandardObject(input: Record<string, unknown>) {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input).slice(0, 80)) {
    if (secretKeyPattern.test(key)) {
      result[key] = { redacted: true }
      continue
    }
    if (safeScalarKeys.has(key) && isScalar(value)) {
      result[key] = typeof value === "string" ? truncate(value, 256) : value
      continue
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      result[key] = value
      continue
    }
    result[key] = structuralSummary(value)
  }
  return result
}

function structuralSummary(input: unknown) {
  const text = stableStringify(input)
  if (Array.isArray(input)) {
    return { type: "array", items: input.length, bytes: text.length, sha256: sha256(text) }
  }
  if (typeof input === "object" && input !== null) {
    return { type: "object", keys: Object.keys(input).length, bytes: text.length, sha256: sha256(text) }
  }
  if (typeof input === "string") return stringSummary(input)
  return { type: typeof input, bytes: text.length, sha256: sha256(text) }
}

function stringSummary(input: string) {
  return { type: "string", chars: input.length, sha256: sha256(input) }
}

function capEvent(input: TelemetryEvent) {
  const max = input.mode === "verbose" ? maxVerboseEventBytes : maxStandardEventBytes
  const text = JSON.stringify(input)
  if (text.length <= max) return input
  const capped = {
    ...input,
    args: input.args === undefined ? undefined : structuralSummary(input.args),
    metadata:
      input.metadata === undefined
        ? undefined
        : {
            truncated: true,
            original_bytes: text.length,
            keys: Object.keys(input.metadata).length,
          },
  }
  const cappedText = JSON.stringify(capped)
  if (cappedText.length <= max) return capped
  return {
    schema_version: input.schema_version,
    mode: input.mode,
    run_id: input.run_id,
    sequence: input.sequence,
    time: input.time,
    event: input.event,
    session_id: input.session_id,
    message_id: input.message_id,
    step_index: input.step_index,
    call_id: input.call_id,
    entity: input.entity,
    status: input.status,
    metadata: {
      truncated: true,
      original_bytes: text.length,
    },
  }
}

function errorEnvelope(input: unknown) {
  if (input === undefined) return undefined
  if (input instanceof Error) {
    return {
      class: input.name,
      message: truncate(input.message, 300),
    }
  }
  if (typeof input === "string") {
    return {
      class: "Error",
      message: truncate(input, 300),
    }
  }
  return {
    class: "Error",
    summary: structuralSummary(input),
  }
}

function compactRecord<T extends Record<string, unknown>>(input: T | undefined) {
  if (!input) return undefined
  const result = Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== undefined))
  return Object.keys(result).length === 0 ? undefined : result
}

function compactTokenRecord(input: Record<string, TokenValue> | undefined) {
  if (!input) return undefined
  const result = Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== undefined)) as Record<
    string,
    TokenValue
  >
  return Object.keys(result).length === 0 ? undefined : result
}

function finiteNumber(input: number | undefined) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function isScalar(input: unknown) {
  return input === null || typeof input === "string" || typeof input === "number" || typeof input === "boolean"
}

function truncate(input: string, max: number) {
  if (input.length <= max) return input
  return `${input.slice(0, max)}...[truncated ${input.length - max} chars]`
}

function stableStringify(input: unknown) {
  try {
    return JSON.stringify(input, (_key, value) => {
      if (typeof value === "bigint") return value.toString()
      return value
    })
  } catch {
    return String(input)
  }
}

function sha256(input: string) {
  return createHash("sha256").update(input).digest("hex")
}

function safeRunID(input: string) {
  return input.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120)
}

export * as BurnInTelemetry from "./burnin-telemetry"
