// Phase 3 of accuracy E (docs/accuracy-e.md §11.8): the goal record. The server
// takes the snapshot the goal starts from, and every change to the goal is
// appended to its history, never rewritten.
import { describe, expect } from "bun:test"
import { createHash } from "crypto"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit, Layer, Schema } from "effect"
import { Session } from "@/session/session"
import { SessionGoal } from "../../src/session/goal"
import { SessionMetadataLock } from "../../src/session/metadata-lock"
import { Snapshot } from "../../src/snapshot"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const nodes = [Session.node, SessionGoal.node, Snapshot.node, SessionProjector.node, CrossSpawnSpawner.node] as const
const it = testEffect(LayerNode.compile(LayerNode.group(nodes)))

// Snapshot.track() returns undefined when git cannot write a snapshot.
const noSnapshot = testEffect(
  LayerNode.compile(LayerNode.group(nodes), [
    [
      Snapshot.node,
      Layer.effect(
        Snapshot.Service,
        Effect.gen(function* () {
          const real = yield* Snapshot.Service
          return Snapshot.Service.of({ ...real, track: () => Effect.succeed(undefined) })
        }),
      ).pipe(Layer.provide(LayerNode.compile(Snapshot.node))),
    ],
  ]),
)

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")
const write = (directory: string, text: string) =>
  Effect.promise(() => fs.writeFile(path.join(directory, "a.txt"), text))

describe("SessionGoal", () => {
  it.instance(
    "start takes the snapshot on the server and records a set, with the text's hash",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* write(directory, "a0")
        const sessions = yield* Session.Service
        const goals = yield* SessionGoal.Service
        const session = yield* sessions.create({})
        const started = yield* goals.start(session.id, { text: "cap the output", criteria: ["capped at 4 KB"] })
        expect(started.base).toMatch(/^[0-9a-f]{40}$/)
        const goal = yield* goals.get(session.id)
        expect(goal).toEqual({
          id: started.id,
          text: "cap the output",
          criteria: ["capped at 4 KB"],
          base: started.base!,
          startedAt: started.startedAt,
          origin: { goal: started.id, base: started.base! },
          history: [
            {
              type: "set",
              at: started.startedAt,
              via: "host",
              goal: started.id,
              base: started.base!,
              sha256: sha256("cap the output"),
              length: 14,
            },
          ],
        })
        // the base is a real snapshot of the workspace
        const snapshot = yield* Snapshot.Service
        yield* write(directory, "a1")
        expect(yield* snapshot.diff(started.base!)).toContain("+a1")
      }),
    { git: true },
  )

  it.instance(
    "replace and end append to the history and never rewrite an entry; a new base is counted",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const sessions = yield* Session.Service
        const goals = yield* SessionGoal.Service
        const session = yield* sessions.create({})
        yield* write(directory, "a0")
        const first = yield* goals.start(session.id, { text: "first" })
        const before = (yield* goals.get(session.id))!.history
        yield* write(directory, "a1")
        const second = yield* goals.start(session.id, { text: "second" })
        expect(second.id).not.toBe(first.id)
        expect(second.base).not.toBe(first.base)
        const replaced = (yield* goals.get(session.id))!
        expect(replaced.text).toBe("second")
        expect(replaced.history.slice(0, 1)).toEqual([...before])
        expect(replaced.history[1]).toMatchObject({ type: "replace", via: "host", goal: second.id, base: second.base! })
        // the base the goal was first set on stays; a change of base is counted
        expect(replaced.origin).toEqual({ goal: first.id, base: first.base! })
        expect(replaced.baseChanges).toBe(1)

        const ended = yield* goals.end(session.id)
        expect(ended?.endedAt).toBeNumber()
        expect(ended?.history.slice(0, 2)).toEqual([...replaced.history])
        expect(ended?.history[2]).toMatchObject({ type: "end", via: "host", goal: second.id })
        // nothing active: nothing to end, nothing appended
        expect(yield* goals.end(session.id)).toBeUndefined()
        expect((yield* goals.get(session.id))!.history).toHaveLength(3)

        // a goal after an ended one is a set, and the history carries on
        const third = yield* goals.start(session.id, { text: "third" })
        const after = (yield* goals.get(session.id))!
        expect(after.endedAt).toBeUndefined()
        expect(after.history.slice(0, 3)).toEqual([...ended!.history])
        expect(after.history[3]).toMatchObject({ type: "set", goal: third.id, sha256: sha256("third") })
        expect(after.origin).toEqual({ goal: first.id, base: first.base! })
      }),
    { git: true },
  )

  it.instance(
    "keeps the session's other metadata",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const goals = yield* SessionGoal.Service
        const session = yield* sessions.create({})
        yield* sessions.setMetadata({ sessionID: session.id, metadata: { note: "kept" } })
        yield* goals.start(session.id, { text: "goal" })
        yield* goals.end(session.id)
        expect((yield* sessions.get(session.id)).metadata?.note).toBe("kept")
      }),
    { git: true },
  )

  // Security review of Phase 3: a worker that loops on the endpoint can neither
  // grow the record without limit nor change the goal faster than 10 a minute.
  it.instance(
    "changes are limited to 10 a minute per session, then refused",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const goals = yield* SessionGoal.Service
        const session = yield* sessions.create({})
        const other = yield* sessions.create({})
        for (let i = 0; i < 10; i++) yield* goals.start(session.id, { text: `goal ${i}` })
        const refused = yield* goals.start(session.id, { text: "one too many" }).pipe(Effect.flip)
        expect(refused).toBeInstanceOf(SessionGoal.RateLimited)
        expect((yield* goals.end(session.id).pipe(Effect.flip))._tag).toBe("GoalRateLimited")
        const goal = (yield* goals.get(session.id))!
        expect(goal.text).toBe("goal 9")
        expect(goal.history).toHaveLength(10)
        // per session
        yield* goals.start(other.id, { text: "fine" })
      }),
    { git: true },
  )

  it.instance(
    "the history keeps the latest 200 changes and counts the rest in a monotonic elided",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const goals = yield* SessionGoal.Service
        const session = yield* sessions.create({})
        const old = Array.from({ length: 200 }, (_, i) => ({
          type: "replace" as const,
          at: 1_000 + i,
          via: "host" as const,
          goal: `goal_${i}`,
          sha256: sha256(`goal ${i}`),
          length: `goal ${i}`.length,
        }))
        const seeded = {
          id: "goal_199",
          text: "goal 199",
          startedAt: 1_199,
          origin: { goal: "goal_0" },
          history: old,
          elided: 5,
        }
        yield* sessions.setMetadata({ sessionID: session.id, metadata: { goal: seeded } })
        const next = yield* goals.start(session.id, { text: "goal 200" })
        const goal = (yield* goals.get(session.id))!
        expect(goal.history).toHaveLength(200)
        expect(goal.elided).toBe(6)
        expect(goal.history[0]).toEqual(old[1]!)
        expect(goal.history.at(-1)).toMatchObject({ type: "replace", goal: next.id, sha256: sha256("goal 200") })
        // only the current goal's text is kept in full
        expect(JSON.stringify(goal.history)).not.toContain("goal 200")
      }),
    { git: true },
  )

  it.instance("criteria may not hold line breaks or control characters", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownExit(SessionGoal.Input)
      expect(Exit.isSuccess(decode({ text: "goal", criteria: ["capped at 4 KB"] }))).toBe(true)
      for (const bad of ["a\nb", "a\rb", "a\u0000b", "a\u001bb", "a\u007fb"])
        expect([bad, Exit.isFailure(decode({ text: "goal", criteria: [bad] }))]).toEqual([bad, true])
    }),
  )

  // Two separately built layers (the app runtime and the HTTP server) share one
  // lock per session, and a lock is dropped once nobody holds or waits for it.
  it.instance(
    "changes through separately built services are serialized, and locks are released",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const goals = yield* SessionGoal.Service
        const other = yield* Effect.provide(SessionGoal.Service, LayerNode.compile(SessionGoal.node))
        const session = yield* sessions.create({})
        yield* Effect.all(
          Array.from({ length: 8 }, (_, i) => (i % 2 ? goals : other).start(session.id, { text: `goal ${i}` })),
          { concurrency: "unbounded" },
        )
        expect((yield* goals.get(session.id))!.history).toHaveLength(8)
        expect(SessionMetadataLock.size()).toBe(0)
      }),
    { git: true },
  )

  noSnapshot.instance(
    "with no snapshot the goal has no base, and start says so",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const goals = yield* SessionGoal.Service
        const session = yield* sessions.create({})
        const started = yield* goals.start(session.id, { text: "goal" })
        expect(started.base).toBeNull()
        const goal = yield* goals.get(session.id)
        expect(goal && "base" in goal).toBe(false)
      }),
    { git: true },
  )
})
