export type QueueItemStatus = "pending" | "active" | "done" | "failed"

export type QueueStatusItem = {
  identifier: string
  title: string
  status: QueueItemStatus
}

export type QueueStatusSnapshot = {
  items: QueueStatusItem[]
  index: number
  total: number
  done: boolean
  ok: boolean
  reason: string | null
  nextIdentifier: string | null
}

type Listener = (snapshot: QueueStatusSnapshot | null) => void

let current: QueueStatusSnapshot | null = null
const listeners = new Set<Listener>()

function copy(snapshot: QueueStatusSnapshot | null): QueueStatusSnapshot | null {
  if (!snapshot) return null
  return { ...snapshot, items: snapshot.items.map((item) => ({ ...item })) }
}

function emit() {
  const snapshot = copy(current)
  for (const cb of Array.from(listeners)) {
    try {
      cb(snapshot)
    } catch {
      // Listener errors must never break queue tracking.
    }
  }
}

function firstPendingIdentifier(items: QueueStatusItem[]): string | null {
  const found = items.find((item) => item.status === "pending")
  if (!found) return null
  return found.identifier
}

function activePosition(items: QueueStatusItem[]): number {
  return items.findIndex((item) => item.status === "active")
}

export function setQueue(items: Array<{ identifier: string; title: string }>): void {
  if (items.length === 0) {
    current = null
    emit()
    return
  }
  const copied: QueueStatusItem[] = items.map((item) => ({
    identifier: item.identifier,
    title: item.title,
    status: "pending",
  }))
  current = {
    items: copied,
    index: -1,
    total: copied.length,
    done: false,
    ok: true,
    reason: null,
    nextIdentifier: firstPendingIdentifier(copied),
  }
  emit()
}

export function begin(identifier: string): void {
  if (!current || current.done) return
  const target = current.items.find((item) => item.identifier === identifier)
  if (!target) return
  if (target.status === "done" || target.status === "failed") return
  if (target.status === "active") return
  const items = current.items.map((item): QueueStatusItem => {
    if (item.identifier === identifier) return { ...item, status: "active" }
    if (item.status === "active") return { ...item, status: "pending" }
    return { ...item }
  })
  current = { ...current, items, index: activePosition(items), nextIdentifier: firstPendingIdentifier(items) }
  emit()
}

export function advance(identifier: string): void {
  if (!current || current.done) return
  const target = current.items.find((item) => item.identifier === identifier)
  if (!target) return
  if (target.status === "done" || target.status === "failed") return
  const settled = current.items.map((item): QueueStatusItem => {
    if (item.identifier === identifier) return { ...item, status: "done" }
    if (item.status === "active") return { ...item, status: "pending" }
    return { ...item }
  })
  const upcoming = settled.find((item) => item.status === "pending")
  if (upcoming) upcoming.status = "active"
  const finished = settled.every((item) => item.status === "done" || item.status === "failed")
  current = {
    ...current,
    items: settled,
    index: activePosition(settled),
    total: settled.length,
    done: finished,
    ok: true,
    nextIdentifier: firstPendingIdentifier(settled),
  }
  emit()
}

export function halt(reason?: string): void {
  if (!current || current.done) return
  const items = current.items.map((item): QueueStatusItem => ({ ...item }))
  const running = items.find((item) => item.status === "active")
  if (running) running.status = "failed"
  current = {
    ...current,
    items,
    index: -1,
    total: items.length,
    done: true,
    ok: false,
    reason: reason ?? null,
    nextIdentifier: firstPendingIdentifier(items),
  }
  emit()
}

export function clear(): void {
  if (!current) return
  current = null
  emit()
}

export function get(): QueueStatusSnapshot | null {
  return copy(current)
}

export function subscribe(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
