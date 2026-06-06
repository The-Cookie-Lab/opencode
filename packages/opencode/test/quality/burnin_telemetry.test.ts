import { describe, expect, test } from "bun:test"
import { BurnInTelemetry } from "@/quality/burnin-telemetry"

describe("burn-in telemetry normalization", () => {
  test("standard mode keeps safe scalar args and hashes unsafe strings", () => {
    const event = BurnInTelemetry.normalizeTelemetryEvent(
      {
        event: "tool.called",
        sessionID: "ses_1",
        messageID: "msg_1",
        callID: "call_1",
        entity: { kind: "tool", name: "bash" },
        args: {
          path: "/tmp/project",
          command: "curl https://example.test?token=secret",
          apiKey: "secret",
          limit: 3,
        },
      },
      { mode: "standard", runID: "run", sequence: 1, now: new Date("2026-06-05T00:00:00Z") },
    )

    expect(event.schema_version).toBe(1)
    expect(event.mode).toBe("standard")
    expect(event.session_id).toBe("ses_1")
    expect(event.args).toMatchObject({
      path: "/tmp/project",
      command: { type: "string" },
      apiKey: { redacted: true },
      limit: 3,
    })
  })

  test("verbose mode includes truncated redacted args", () => {
    const event = BurnInTelemetry.normalizeTelemetryEvent(
      {
        event: "tool.called",
        args: {
          command: "x".repeat(2_100),
          password: "secret",
        },
      },
      { mode: "verbose", runID: "run", sequence: 1 },
    )

    const args = event.args as Record<string, unknown>
    expect(String(args.command)).toContain("[truncated")
    expect(args.password).toEqual({ redacted: true })
  })

  test("caps event line size", () => {
    const event = BurnInTelemetry.normalizeTelemetryEvent(
      {
        event: "tool.settled",
        metadata: { payload: "x".repeat(100_000) },
      },
      { mode: "verbose", runID: "run", sequence: 1 },
    )

    expect(BurnInTelemetry.lineForEvent(event).length).toBeLessThanOrEqual(64 * 1024 + 1)
  })

  test("estimated tokens are deterministic", () => {
    expect(BurnInTelemetry.estimateTokens("12345678")).toBe(2)
    expect(BurnInTelemetry.outputSummary("hello", "verbose")).toMatchObject({
      chars: 5,
      preview: "hello",
    })
  })
})
