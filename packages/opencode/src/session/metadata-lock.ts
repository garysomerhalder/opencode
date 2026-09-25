// One lock per session for read-modify-writes of its metadata (docs/accuracy-e.md
// §11.8). Session.setMetadata replaces the whole object, so two writers that each
// read, change and write can lose the other's change: a client's metadata update
// could roll back the host's goal record. Every such writer runs under this lock.
// It is module state, so it is one per process however many times the services
// that use it are built, and an entry is dropped once nobody holds or waits for it.
import { Effect, Semaphore } from "effect"

const locks = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>()

export function withLock<A, E, R>(sessionID: string, fx: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.suspend(() => {
    const entry = locks.get(sessionID) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }
    locks.set(sessionID, entry)
    entry.users++
    return entry.semaphore.withPermits(1)(fx).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          entry.users--
          if (entry.users === 0 && locks.get(sessionID) === entry) locks.delete(sessionID)
        }),
      ),
    )
  })
}

/** Sessions with a lock held or awaited. */
export function size() {
  return locks.size
}

export * as SessionMetadataLock from "./metadata-lock"
