import { describe, expect, test } from "bun:test"
import { SKIP_PARTS } from "./directory-sync"

describe("directory-sync SKIP_PARTS", () => {
  test("does not skip step-finish parts (regression: step-finish was in SKIP_PARTS)", () => {
    expect(SKIP_PARTS.has("step-finish")).toBe(false)
  })

  test("still skips patch parts", () => {
    expect(SKIP_PARTS.has("patch")).toBe(true)
  })

  test("still skips step-start parts", () => {
    expect(SKIP_PARTS.has("step-start")).toBe(true)
  })

  test("only contains the expected skip types", () => {
    // If a new type is added to SKIP_PARTS, this test forces a deliberate review.
    // step-finish must NEVER be re-added because it carries promptTokensDetails
    // needed by the context breakdown UI.
    expect([...SKIP_PARTS].sort()).toEqual(["patch", "step-start"])
  })
})
