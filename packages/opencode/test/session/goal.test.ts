// Phase 3 of accuracy E (docs/accuracy-e.md §11.8): the goal record. The server
// takes the snapshot the goal starts from, and every change to the goal is
// appended to its history, never rewritten.
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { SessionGoal } from "../../src/session/goal"
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

describe("SessionGoal", () => {
  it.instance(
    "start takes the snapshot on the server and records a set",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "a.txt"), "a0"))
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
          history: [{ type: "set", at: started.startedAt, via: "api", goal: started.id, text: "cap the output" }],
        })
        // the base is a real snapshot of the workspace
        const snapshot = yield* Snapshot.Service
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "a.txt"), "a1"))
        expect(yield* snapshot.diff(started.base!)).toContain("+a1")
      }),
    { git: true },
  )

  it.instance(
    "replace and end append to the history and never rewrite an entry",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const goals = yield* SessionGoal.Service
        const session = yield* sessions.create({})
        const first = yield* goals.start(session.id, { text: "first" })
        const before = (yield* goals.get(session.id))!.history
        const second = yield* goals.start(session.id, { text: "second" })
        expect(second.id).not.toBe(first.id)
        const replaced = (yield* goals.get(session.id))!
        expect(replaced.text).toBe("second")
        expect(replaced.history.slice(0, 1)).toEqual([...before])
        expect(replaced.history[1]).toMatchObject({ type: "replace", via: "api", goal: second.id, text: "second" })

        const ended = yield* goals.end(session.id)
        expect(ended?.endedAt).toBeNumber()
        expect(ended?.history.slice(0, 2)).toEqual([...replaced.history])
        expect(ended?.history[2]).toMatchObject({ type: "end", via: "api", goal: second.id })
        // nothing active: nothing to end, nothing appended
        expect(yield* goals.end(session.id)).toBeUndefined()
        expect((yield* goals.get(session.id))!.history).toHaveLength(3)

        // a goal after an ended one is a set, and the history carries on
        const third = yield* goals.start(session.id, { text: "third" })
        const after = (yield* goals.get(session.id))!
        expect(after.endedAt).toBeUndefined()
        expect(after.history.slice(0, 3)).toEqual([...ended!.history])
        expect(after.history[3]).toMatchObject({ type: "set", goal: third.id, text: "third" })
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
