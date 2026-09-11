import { beforeEach, describe, expect, test } from "bun:test"
import { advance, clear, get, halt, setQueue, subscribe } from "./queue-status"

beforeEach(() => {
  clear()
})

describe("queue-status", () => {
  test("set initializes items at index zero", () => {
    setQueue([
      { identifier: "ABC-1", title: "First" },
      { identifier: "ABC-2", title: "Second" },
    ])
    const snapshot = get()
    expect(snapshot?.items).toEqual([
      { identifier: "ABC-1", title: "First" },
      { identifier: "ABC-2", title: "Second" },
    ])
    expect(snapshot?.index).toBe(0)
    expect(snapshot?.done).toBe(false)
    expect(snapshot?.ok).toBe(true)
  })

  test("set respects startIndex with clamping", () => {
    setQueue(
      [
        { identifier: "ABC-1", title: "First" },
        { identifier: "ABC-2", title: "Second" },
      ],
      1,
    )
    expect(get()?.index).toBe(1)
    setQueue([{ identifier: "ABC-1", title: "First" }], 9)
    expect(get()?.index).toBe(0)
  })

  test("advance moves to next ticket on current identifier", () => {
    setQueue([
      { identifier: "ABC-1", title: "First" },
      { identifier: "ABC-2", title: "Second" },
    ])
    advance("ABC-1")
    const snapshot = get()
    expect(snapshot?.index).toBe(1)
    expect(snapshot?.done).toBe(false)
  })

  test("advance on last ticket marks done", () => {
    setQueue([{ identifier: "ABC-1", title: "Only" }])
    advance("ABC-1")
    const snapshot = get()
    expect(snapshot?.done).toBe(true)
    expect(snapshot?.ok).toBe(true)
    expect(snapshot?.index).toBe(0)
  })

  test("unknown advance is ignored without notification", () => {
    setQueue([{ identifier: "ABC-1", title: "Only" }])
    let calls = 0
    const unsubscribe = subscribe(() => {
      calls += 1
    })
    try {
      advance("UNKNOWN-9")
      expect(get()?.index).toBe(0)
      expect(get()?.done).toBe(false)
      expect(calls).toBe(0)
    } finally {
      unsubscribe()
    }
  })

  test("halt marks done with reason", () => {
    setQueue([{ identifier: "ABC-1", title: "Only" }])
    halt("boom")
    const snapshot = get()
    expect(snapshot?.done).toBe(true)
    expect(snapshot?.ok).toBe(false)
    expect(snapshot?.reason).toBe("boom")
  })

  test("halt without reason omits reason", () => {
    setQueue([{ identifier: "ABC-1", title: "Only" }])
    halt()
    const snapshot = get()
    expect(snapshot?.done).toBe(true)
    expect(snapshot?.ok).toBe(false)
    expect(snapshot?.reason).toBeUndefined()
  })

  test("clear resets to null", () => {
    setQueue([{ identifier: "ABC-1", title: "Only" }])
    clear()
    expect(get()).toBeNull()
  })

  test("subscribe notifies on mutations and unsubscribes", () => {
    const seen: Array<ReturnType<typeof get>> = []
    const unsubscribe = subscribe((snapshot) => {
      seen.push(snapshot)
    })
    try {
      setQueue([{ identifier: "ABC-1", title: "Only" }])
      advance("ABC-1")
      expect(seen.length).toBe(2)
      expect(seen[0]?.index).toBe(0)
      expect(seen[1]?.done).toBe(true)
    } finally {
      unsubscribe()
    }
    setQueue([{ identifier: "ABC-2", title: "Other" }])
    expect(seen.length).toBe(2)
  })
})
