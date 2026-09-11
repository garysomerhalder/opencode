import { beforeEach, describe, expect, test } from "bun:test"
import { advance, begin, clear, get, halt, setQueue, subscribe } from "./queue-status"

beforeEach(() => {
  clear()
})

function threeTickets() {
  return [
    { identifier: "ABC-1", title: "First" },
    { identifier: "ABC-2", title: "Second" },
    { identifier: "ABC-3", title: "Third" },
  ]
}

function statuses() {
  return get()?.items.map((item) => `${item.identifier}:${item.status}`)
}

describe("queue-status", () => {
  test("set marks all pending with index -1", () => {
    setQueue([
      { identifier: "ABC-1", title: "First" },
      { identifier: "ABC-2", title: "Second" },
    ])
    const snapshot = get()
    expect(snapshot?.items).toEqual([
      { identifier: "ABC-1", title: "First", status: "pending" },
      { identifier: "ABC-2", title: "Second", status: "pending" },
    ])
    expect(snapshot?.index).toBe(-1)
    expect(snapshot?.total).toBe(2)
    expect(snapshot?.done).toBe(false)
    expect(snapshot?.ok).toBe(true)
    expect(snapshot?.reason).toBeNull()
    expect(snapshot?.nextIdentifier).toBe("ABC-1")
  })

  test("set with empty items clears to null", () => {
    setQueue([{ identifier: "ABC-1", title: "Only" }])
    setQueue([])
    expect(get()).toBeNull()
  })

  test("begin marks one ticket active", () => {
    setQueue(threeTickets())
    begin("ABC-1")
    expect(statuses()).toEqual(["ABC-1:active", "ABC-2:pending", "ABC-3:pending"])
    const snapshot = get()
    expect(snapshot?.index).toBe(0)
    expect(snapshot?.total).toBe(3)
    expect(snapshot?.done).toBe(false)
    expect(snapshot?.nextIdentifier).toBe("ABC-2")
  })

  test("begin moves the active marker to the newly started ticket", () => {
    setQueue([
      { identifier: "ABC-1", title: "First" },
      { identifier: "ABC-2", title: "Second" },
    ])
    begin("ABC-1")
    begin("ABC-2")
    expect(statuses()).toEqual(["ABC-1:pending", "ABC-2:active"])
    expect(get()?.index).toBe(1)
    expect(get()?.nextIdentifier).toBe("ABC-1")
  })

  test("begin with unknown identifier is ignored without notification", () => {
    setQueue([{ identifier: "ABC-1", title: "Only" }])
    let calls = 0
    const unsubscribe = subscribe(() => {
      calls += 1
    })
    try {
      begin("UNKNOWN-9")
      expect(statuses()).toEqual(["ABC-1:pending"])
      expect(get()?.index).toBe(-1)
      expect(calls).toBe(0)
    } finally {
      unsubscribe()
    }
  })

  test("advance chain across three items verifies statuses at each step", () => {
    setQueue(threeTickets())
    expect(statuses()).toEqual(["ABC-1:pending", "ABC-2:pending", "ABC-3:pending"])
    expect(get()?.index).toBe(-1)
    expect(get()?.nextIdentifier).toBe("ABC-1")

    advance("ABC-1")
    expect(statuses()).toEqual(["ABC-1:done", "ABC-2:active", "ABC-3:pending"])
    expect(get()?.index).toBe(1)
    expect(get()?.done).toBe(false)
    expect(get()?.nextIdentifier).toBe("ABC-3")

    advance("ABC-2")
    expect(statuses()).toEqual(["ABC-1:done", "ABC-2:done", "ABC-3:active"])
    expect(get()?.index).toBe(2)
    expect(get()?.done).toBe(false)
    expect(get()?.nextIdentifier).toBeNull()

    advance("ABC-3")
    expect(statuses()).toEqual(["ABC-1:done", "ABC-2:done", "ABC-3:done"])
    const snapshot = get()
    expect(snapshot?.done).toBe(true)
    expect(snapshot?.ok).toBe(true)
    expect(snapshot?.reason).toBeNull()
    expect(snapshot?.index).toBe(-1)
    expect(snapshot?.total).toBe(3)
    expect(snapshot?.nextIdentifier).toBeNull()
  })

  test("advance follows a begin-first flow", () => {
    setQueue([
      { identifier: "ABC-1", title: "First" },
      { identifier: "ABC-2", title: "Second" },
    ])
    begin("ABC-1")
    advance("ABC-1")
    expect(statuses()).toEqual(["ABC-1:done", "ABC-2:active"])
    expect(get()?.index).toBe(1)
    expect(get()?.done).toBe(false)
    expect(get()?.nextIdentifier).toBeNull()
    advance("ABC-2")
    expect(statuses()).toEqual(["ABC-1:done", "ABC-2:done"])
    expect(get()?.done).toBe(true)
    expect(get()?.index).toBe(-1)
  })

  test("unknown advance is ignored without notification", () => {
    setQueue([{ identifier: "ABC-1", title: "Only" }])
    let calls = 0
    const unsubscribe = subscribe(() => {
      calls += 1
    })
    try {
      advance("UNKNOWN-9")
      expect(statuses()).toEqual(["ABC-1:pending"])
      expect(get()?.index).toBe(-1)
      expect(get()?.done).toBe(false)
      expect(calls).toBe(0)
    } finally {
      unsubscribe()
    }
  })

  test("repeat advance of a done item is ignored without notification", () => {
    setQueue([{ identifier: "ABC-1", title: "Only" }])
    advance("ABC-1")
    expect(get()?.done).toBe(true)
    let calls = 0
    const unsubscribe = subscribe(() => {
      calls += 1
    })
    try {
      advance("ABC-1")
      expect(statuses()).toEqual(["ABC-1:done"])
      expect(calls).toBe(0)
    } finally {
      unsubscribe()
    }
  })

  test("halt marks the active ticket failed", () => {
    setQueue([
      { identifier: "ABC-1", title: "First" },
      { identifier: "ABC-2", title: "Second" },
    ])
    begin("ABC-1")
    halt("boom")
    expect(statuses()).toEqual(["ABC-1:failed", "ABC-2:pending"])
    const snapshot = get()
    expect(snapshot?.done).toBe(true)
    expect(snapshot?.ok).toBe(false)
    expect(snapshot?.reason).toBe("boom")
    expect(snapshot?.index).toBe(-1)
    expect(snapshot?.nextIdentifier).toBe("ABC-2")
  })

  test("halt without reason sets reason null", () => {
    setQueue([{ identifier: "ABC-1", title: "Only" }])
    begin("ABC-1")
    halt()
    const snapshot = get()
    expect(snapshot?.done).toBe(true)
    expect(snapshot?.ok).toBe(false)
    expect(snapshot?.reason).toBeNull()
    expect(statuses()).toEqual(["ABC-1:failed"])
    expect(snapshot?.index).toBe(-1)
    expect(snapshot?.nextIdentifier).toBeNull()
  })

  test("nextIdentifier tracks the first pending ticket", () => {
    setQueue(threeTickets())
    expect(get()?.nextIdentifier).toBe("ABC-1")
    begin("ABC-1")
    expect(get()?.nextIdentifier).toBe("ABC-2")
    advance("ABC-1")
    expect(get()?.nextIdentifier).toBe("ABC-3")
    advance("ABC-2")
    expect(get()?.nextIdentifier).toBeNull()
    advance("ABC-3")
    expect(get()?.nextIdentifier).toBeNull()
  })

  test("done flag turns true only when every item is done", () => {
    setQueue([
      { identifier: "ABC-1", title: "First" },
      { identifier: "ABC-2", title: "Second" },
    ])
    expect(get()?.done).toBe(false)
    advance("ABC-1")
    expect(get()?.done).toBe(false)
    expect(get()?.ok).toBe(true)
    advance("ABC-2")
    const snapshot = get()
    expect(snapshot?.done).toBe(true)
    expect(snapshot?.ok).toBe(true)
    expect(snapshot?.reason).toBeNull()
    expect(snapshot?.index).toBe(-1)
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
      expect(seen[0]?.index).toBe(-1)
      expect(seen[0]?.nextIdentifier).toBe("ABC-1")
      expect(seen[1]?.done).toBe(true)
    } finally {
      unsubscribe()
    }
    setQueue([{ identifier: "ABC-2", title: "Other" }])
    expect(seen.length).toBe(2)
  })
})
