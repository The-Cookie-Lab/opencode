import { beforeEach, describe, expect, test, mock } from "bun:test"

const toastState = {
  customCalls: [] as Array<{ id?: string | number; data: { id?: string | number } }>,
  toastCalls: [] as Array<{ id?: string | number; data: { id?: string | number } }>,
  dismissCalls: [] as Array<string | number | undefined>,
}

mock.module("solid-sonner", () => {
  const toast = (message: unknown, data: { id?: string | number } = {}) => {
    const id = data.id ?? `toast-${toastState.toastCalls.length + 1}`
    toastState.toastCalls.push({ id, data })
    return id
  }

  ;(toast as any).custom = (render: unknown, data: { id?: string | number } = {}) => {
    const id = data.id ?? `custom-${toastState.customCalls.length + 1}`
    toastState.customCalls.push({ id, data })
    return id
  }

  ;(toast as any).getToasts = () =>
    [...toastState.customCalls, ...toastState.toastCalls].map((entry) => ({ id: entry.id }))

  ;(toast as any).dismiss = (id?: string | number) => {
    toastState.dismissCalls.push(id)
    return [] as string[]
  }

  return {
    toast,
    Toaster: (_props: unknown) => null,
  }
})

mock.module("../../context/i18n", () => ({
  useI18n: () => ({
    locale: () => "en",
    t: (key: string) => key,
  }),
}))

const { showToastV2, toasterV2 } = await import("./toast-v2")

beforeEach(() => {
  toastState.customCalls.length = 0
  toastState.toastCalls.length = 0
  toastState.dismissCalls.length = 0
})

describe("toast-v2", () => {
  test("reuses the active toast for matching content", () => {
    const firstId = showToastV2({ title: "Session saved", description: "Everything is good" })
    const secondId = showToastV2({ title: "Session saved", description: "Everything is good" })

    expect(firstId).toBe(secondId)
    expect(toastState.toastCalls).toHaveLength(2)
    expect(toastState.toastCalls[0].id).toBe(firstId)
    expect(toastState.toastCalls[1].id).toBe(secondId)
  })

  test("creates a custom toast with a distinct negative identifier", () => {
    const firstId = toasterV2.show(() => "toast")
    const secondId = toasterV2.show(() => "toast")

    expect(firstId).not.toBe(secondId)
    expect(firstId).toBeLessThan(0)
    expect(secondId).toBeLessThan(firstId)
    expect(toastState.customCalls).toHaveLength(2)
    expect(toastState.customCalls[0].id).toBe(firstId)
    expect(toastState.customCalls[1].id).toBe(secondId)
  })

  test("creates a fresh id after explicit dismiss", () => {
    const firstId = showToastV2("Upload complete")
    toasterV2.dismiss(firstId)
    const secondId = showToastV2("Upload complete")

    expect(firstId).not.toBe(secondId)
    expect(toastState.dismissCalls).toEqual([firstId])
  })

  test("supports bulk dismiss to clear state", () => {
    const firstId = showToastV2("Build started")
    const secondId = showToastV2("Build finished")

    toasterV2.dismiss()

    const thirdId = showToastV2("Build started")
    const fourthId = showToastV2("Build finished")

    expect(firstId).not.toBe(thirdId)
    expect(secondId).not.toBe(fourthId)
    expect(toastState.dismissCalls).toEqual([undefined])
  })
})
