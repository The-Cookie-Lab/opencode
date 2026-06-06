import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Log } from "@opencode-ai/core/util/log"
import { Context, Effect, Layer, Option } from "effect"

export const providerID = ProviderV2.ID.make("local-model-server")
const defaultBaseURL = "http://127.0.0.1:8080/v1"
const log = Log.create({ service: "local-model-server.memory" })

type JsonObject = Record<string, unknown>

export type Role = "user" | "assistant"

export type CaptureMessageInput = {
  sessionID: string
  messageID: string
  providerID: ProviderV2.ID
  role: Role
  content: string
  synthetic?: boolean
}

export type CaptureMessagePart = JsonObject

export type CaptureMessagePartsInput = {
  sessionID: string
  messageID: string
  providerID: ProviderV2.ID
  role: Role
  content?: string
  parts: CaptureMessagePart[]
  synthetic?: boolean
}

export type SearchInput = {
  sessionID: string
  providerID: ProviderV2.ID
  query: string
  target_uri?: string
  mode?: "auto" | "fast" | "deep"
  limit?: number
  score_threshold?: number
  signal?: AbortSignal
}

export type ReadInput = {
  providerID: ProviderV2.ID
  uri: string
  level?: "auto" | "abstract" | "overview" | "read"
  signal?: AbortSignal
}

export interface Interface {
  readonly captureMessage: (input: CaptureMessageInput) => Effect.Effect<void, Error>
  readonly captureMessageParts: (input: CaptureMessagePartsInput) => Effect.Effect<void, Error>
  readonly commitSession: (input: {
    sessionID: string
    providerID: ProviderV2.ID
  }) => Effect.Effect<JsonObject>
  readonly search: (input: SearchInput) => Effect.Effect<JsonObject, Error>
  readonly read: (input: ReadInput) => Effect.Effect<JsonObject, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LocalModelServerMemory") {}

export function isLocalModelServerProvider(input: ProviderV2.ID | string | undefined) {
  return input === providerID
}

function isJsonObject(input: unknown): input is JsonObject {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function rootFromBaseURL(baseURL: unknown) {
  const raw = typeof baseURL === "string" && baseURL.trim() ? baseURL.trim() : defaultBaseURL
  const normalized = raw.replace(/\/+$/, "")
  return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized
}

function compactBody(input: JsonObject) {
  return Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== undefined && entry[1] !== ""))
}

function responseError(payload: JsonObject) {
  const error = payload.error
  if (typeof error === "string") return error
  if (isJsonObject(error)) {
    const message = error.message
    if (typeof message === "string") return message
    const code = error.code
    if (typeof code === "string") return code
  }
  return JSON.stringify(payload)
}

function errorMessage(error: Error) {
  return error.message || error.name
}

function persistenceSignal() {
  return typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(1_500) : undefined
}

const root = Effect.fn("LocalModelServerMemory.root")(function* (id: ProviderV2.ID) {
  const providers = yield* Effect.serviceOption(Provider.Service)
  if (Option.isNone(providers)) return rootFromBaseURL(undefined)
  const provider = yield* providers.value.getProvider(id).pipe(Effect.catch(() => Effect.succeed(undefined)))
  return rootFromBaseURL(provider?.options.baseURL ?? provider?.options.endpoint)
})

const post = Effect.fn("LocalModelServerMemory.post")(function* (
  id: ProviderV2.ID,
  endpoint: string,
  body: JsonObject,
  signal?: AbortSignal,
) {
  if (!isLocalModelServerProvider(id)) {
    return yield* Effect.fail(new Error("memory tools require the local-model-server provider"))
  }
  const base = yield* root(id)
  return yield* Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${base}/v1/openviking${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(compactBody(body)),
        signal,
      })
      const text = await response.text()
      const payload = text ? JSON.parse(text) : {}
      if (!isJsonObject(payload)) throw new Error("model-server returned a non-object response")
      if (!response.ok) throw new Error(responseError(payload))
      return payload
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })
})

const captureMessage: Interface["captureMessage"] = (input) => {
  const content = input.content.trim()
  if (!isLocalModelServerProvider(input.providerID) || !content) return Effect.void
  return post(
    input.providerID,
    `/sessions/${encodeURIComponent(input.sessionID)}/messages`,
    {
      message_id: input.messageID,
      role: input.role,
      content,
      synthetic: input.synthetic,
    },
    persistenceSignal(),
  ).pipe(
    Effect.tapError((error) =>
      Effect.sync(() =>
        log.warn("capture failed", {
          sessionID: input.sessionID,
          messageID: input.messageID,
          role: input.role,
          contentChars: content.length,
          error: errorMessage(error),
        }),
      ),
    ),
    Effect.ignore,
  )
}

const captureMessageParts: Interface["captureMessageParts"] = (input) => {
  const content = input.content?.trim()
  const parts = input.parts.filter(isJsonObject)
  if (!isLocalModelServerProvider(input.providerID) || (!content && parts.length === 0)) return Effect.void
  return post(
    input.providerID,
    `/sessions/${encodeURIComponent(input.sessionID)}/messages`,
    {
      message_id: input.messageID,
      role: input.role,
      content,
      parts,
      synthetic: input.synthetic,
    },
    persistenceSignal(),
  ).pipe(
    Effect.tapError((error) =>
      Effect.sync(() =>
        log.warn("structured capture failed", {
          sessionID: input.sessionID,
          messageID: input.messageID,
          role: input.role,
          contentChars: content?.length ?? 0,
          partsCount: parts.length,
          error: errorMessage(error),
        }),
      ),
    ),
    Effect.ignore,
  )
}

const commitSession: Interface["commitSession"] = (input) => {
  if (!isLocalModelServerProvider(input.providerID)) return Effect.succeed({ status: "skipped", reason: "provider" })
  return post(input.providerID, `/sessions/${encodeURIComponent(input.sessionID)}/commit`, {}).pipe(
    Effect.catch((error) => Effect.succeed({ status: "fallback", reason: error.message })),
  )
}

const search: Interface["search"] = (input) =>
  post(
    input.providerID,
    "/search",
    {
      opencode_session_id: input.sessionID,
      query: input.query,
      target_uri: input.target_uri,
      mode: input.mode ?? "auto",
      limit: input.limit,
      score_threshold: input.score_threshold,
    },
    input.signal,
  ).pipe(
    Effect.tapError((error) =>
      Effect.sync(() =>
        log.warn("search failed", {
          sessionID: input.sessionID,
          queryChars: input.query.trim().length,
          mode: input.mode ?? "auto",
          targetUriChars: input.target_uri?.length,
          error: errorMessage(error),
        }),
      ),
    ),
  )

const read: Interface["read"] = (input) =>
  post(input.providerID, "/read", { uri: input.uri, level: input.level ?? "auto" }, input.signal).pipe(
    Effect.tapError((error) =>
      Effect.sync(() =>
        log.warn("read failed", {
          uriChars: input.uri.trim().length,
          level: input.level ?? "auto",
          error: errorMessage(error),
        }),
      ),
    ),
  )

export const layer = Layer.succeed(Service, Service.of({ captureMessage, captureMessageParts, commitSession, search, read }))

export const defaultLayer = layer

export * as LocalModelServerMemory from "./local-model-server"
