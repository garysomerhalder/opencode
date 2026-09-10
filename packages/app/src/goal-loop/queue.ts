import { buildTicketGoal, type TicketIssue } from "./ticket"

export type QueueItem = {
  ticket: TicketIssue
  directory: string
  instructions: string
}

export type QueueProgressPhase = "started" | "completed" | "halted"

export type QueueProgress = {
  index: number
  total: number
  ticketIdentifier: string
  phase: QueueProgressPhase
  done: boolean
  ok: boolean
  reason?: string
}

export type QueueLoopEvent = {
  loopID: string
  type: string
  state: { status: string; reason: string | null }
}

export type QueueDeps = {
  start(input: { directory: string; goal: string }): Promise<{ id: string }>
  subscribe(cb: (event: QueueLoopEvent) => void): () => void
  stop?: () => Promise<unknown> | unknown
}

export type QueueRunner = {
  start(items: QueueItem[]): void
  stop(): void
  onProgress(cb: (progress: QueueProgress) => void): () => void
}

function progressFor(
  items: QueueItem[],
  index: number,
  phase: QueueProgressPhase,
  done: boolean,
  ok: boolean,
  reason?: string,
): QueueProgress {
  const progress: QueueProgress = {
    index,
    total: items.length,
    ticketIdentifier: items[index]?.ticket.identifier ?? "",
    phase,
    done,
    ok,
  }
  if (reason !== undefined) progress.reason = reason
  return progress
}

export function createQueueRunner(deps: QueueDeps): QueueRunner {
  const listeners = new Set<(progress: QueueProgress) => void>()
  let items: QueueItem[] = []
  let index = -1
  let currentLoopID: string | null = null
  let generation = 0
  let running = false
  let halted = false
  let done = false

  function emit(progress: QueueProgress) {
    for (const cb of Array.from(listeners)) {
      try {
        cb(progress)
      } catch {
        // Listener errors must never break queue advancement.
      }
    }
  }

  async function runCurrent(gen: number) {
    if (halted || done || gen !== generation) return
    const item = items[index]
    if (!item) return
    emit(progressFor(items, index, "started", false, true))
    let goal = buildTicketGoal(item.ticket, item.directory)
    if (item.instructions.trim().length > 0) {
      goal += `\n\nRun instructions: ${item.instructions}`
    }
    try {
      const result = await deps.start({ directory: item.directory, goal })
      if (halted || done || gen !== generation) return
      currentLoopID = result.id
    } catch (err) {
      if (halted || done || gen !== generation) return
      halted = true
      emit(progressFor(items, index, "halted", true, false, err instanceof Error ? err.message : String(err)))
    }
  }

  deps.subscribe((event) => {
    if (!running || halted || done) return
    if (event.loopID !== currentLoopID) return
    const item = items[index]
    if (!item) return
    if (event.type === "completed") {
      const last = index >= items.length - 1
      if (last) {
        done = true
        emit(progressFor(items, index, "completed", true, true))
        return
      }
      emit(progressFor(items, index, "completed", false, true))
      index += 1
      void runCurrent(generation)
      return
    }
    if (event.type === "capped" || event.type === "failed" || event.type === "stopped") {
      halted = true
      emit(progressFor(items, index, "halted", true, false, event.state.reason ?? undefined))
    }
  })

  return {
    start(next: QueueItem[]) {
      generation += 1
      items = [...next]
      index = -1
      currentLoopID = null
      running = items.length > 0
      halted = false
      done = items.length === 0
      if (!running) return
      index = 0
      void runCurrent(generation)
    },
    stop() {
      if (!running || halted || done) return
      halted = true
      try {
        const result = deps.stop?.()
        if (result instanceof Promise) void result.catch(() => undefined)
      } catch {
        // Halting the queue matters more than stopping the loop.
      }
      emit(progressFor(items, Math.max(index, 0), "halted", true, false))
    },
    onProgress(cb: (progress: QueueProgress) => void) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}
