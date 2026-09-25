import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { eq } from "drizzle-orm"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { HostToken } from "../../src/server/host-token"
import { Session } from "@/session/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Database } from "@opencode-ai/core/database/database"
import { AccountV2 } from "@opencode-ai/core/account"
import { AccountTable } from "@opencode-ai/core/account/sql"
import { Worktree } from "../../src/worktree"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([Session.node, Database.node])), httpApiLayer))
const testWorktreeMutations = process.platform === "win32" ? it.instance.skip : it.instance

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

function createSession(input?: Session.CreateInput) {
  return Session.use.create(input)
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

function waitReady(input: { directory?: string; name?: string }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const on = (event: GlobalEvent) => {
      if (event.payload.type !== Worktree.Event.Ready.type) return
      if (input.directory && event.directory !== input.directory) return
      if (input.name && event.payload.properties.name !== input.name) return
      Deferred.doneUnsafe(ready, Effect.void)
    }

    GlobalBus.on("event", on)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

    return yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for worktree.ready")),
      }),
    )
  })
}

function insertAccount() {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(AccountTable)
        .values({
          id: AccountV2.ID.make("account-test"),
          email: "test@example.com",
          url: "https://console.example.com",
          access_token: AccountV2.AccessToken.make("access"),
          refresh_token: AccountV2.RefreshToken.make("refresh"),
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      return "account-test"
    }),
    (id) =>
      Database.Service.use(({ db }) =>
        db
          .delete(AccountTable)
          .where(eq(AccountTable.id, AccountV2.ID.make(id)))
          .run()
          .pipe(Effect.orDie),
      ),
  )
}

function setSessionUpdated(session: Session.Info, updated: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({ time_updated: updated })
      .where(eq(SessionTable.id, session.id))
      .run()
      .pipe(Effect.orDie)
  })
}

function withCreatedWorktree(
  directory: string,
  use: (info: Worktree.Info) => Effect.Effect<void, unknown, HttpClient.HttpClient>,
) {
  const name = "api-test"
  const headers = { "content-type": "application/json" }
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const ready = yield* waitReady({ name }).pipe(Effect.forkScoped)
      const created = yield* request(ExperimentalPaths.worktree, directory, {
        method: "POST",
        headers,
        body: JSON.stringify({ name }),
      })

      expect(created.status).toBe(200)
      const info = yield* json<Worktree.Info>(created)
      expect(info).toMatchObject({ name, branch: "opencode/api-test" })
      yield* Fiber.join(ready)
      return info
    }),
    use,
    (info) =>
      Effect.gen(function* () {
        const removed = yield* request(ExperimentalPaths.worktree, directory, {
          method: "DELETE",
          headers,
          body: JSON.stringify({ directory: info.directory }),
        })
        if (removed.status !== 200) return yield* Effect.fail(new Error(`failed to remove worktree: ${removed.status}`))
        const ok = yield* json<boolean>(removed)
        if (!ok) return yield* Effect.fail(new Error(`failed to remove worktree ${info.directory}`))
      }),
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("experimental HttpApi", () => {
  it.instance(
    "serves read-only experimental endpoints through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const directory = tmp.directory
        const [consoleState, consoleOrgs, toolList, toolIDs, worktrees, resources] = yield* Effect.all(
          [
            request(ExperimentalPaths.console, directory),
            request(ExperimentalPaths.consoleOrgs, directory),
            request(`${ExperimentalPaths.tool}?provider=opencode&model=gpt-5`, directory),
            request(ExperimentalPaths.toolIDs, directory),
            request(ExperimentalPaths.worktree, directory),
            request(ExperimentalPaths.resource, directory),
          ],
          { concurrency: "unbounded" },
        )

        expect(consoleState.status).toBe(200)
        expect(yield* json(consoleState)).toEqual({
          consoleManagedProviders: [],
          switchableOrgCount: 0,
        })

        expect(consoleOrgs.status).toBe(200)
        expect(yield* json(consoleOrgs)).toEqual({ orgs: [] })

        expect(toolList.status).toBe(200)
        expect(yield* json<unknown[]>(toolList)).toContainEqual(
          expect.objectContaining({
            id: "bash",
            description: expect.any(String),
            parameters: expect.any(Object),
          }),
        )

        expect(toolIDs.status).toBe(200)
        expect(yield* json(toolIDs)).toContain("bash")

        expect(worktrees.status).toBe(200)
        expect(yield* json(worktrees)).toEqual([])

        expect(resources.status).toBe(200)
        expect(yield* json(resources)).toEqual({})
      }),
    {
      config: {
        formatter: false,
        lsp: false,
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  // The served app builds its own service graph, so these cover routing, the
  // query shape and the response schema rather than live task state; the task
  // lifecycle itself is covered in test/tool/shell-tasks.test.ts.
  it.instance("serves the background shell task endpoints", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const session = yield* createSession()

      const listed = yield* request(ExperimentalPaths.shellTasks, tmp.directory)
      expect(listed.status).toBe(200)
      expect(yield* json(listed)).toEqual([])

      const scoped = yield* request(`${ExperimentalPaths.shellTasks}?sessionID=${session.id}`, tmp.directory)
      expect(scoped.status).toBe(200)
      expect(yield* json(scoped)).toEqual([])

      const stopped = yield* request(ExperimentalPaths.shellTasksStop, tmp.directory, { method: "POST" })
      expect(stopped.status).toBe(200)
      expect(yield* json(stopped)).toEqual([])

      const stoppedScoped = yield* request(
        `${ExperimentalPaths.shellTasksStop}?sessionID=${session.id}`,
        tmp.directory,
        {
          method: "POST",
        },
      )
      expect(stoppedScoped.status).toBe(200)
      expect(yield* json(stoppedScoped)).toEqual([])

      // One task, by id, scoped to its session: an unknown id is a 404, not a silent success.
      const one = yield* request(
        `${ExperimentalPaths.shellTaskStop.replace(":taskID", "shl_missing")}?sessionID=${session.id}`,
        tmp.directory,
        { method: "POST" },
      )
      expect(one.status).toBe(404)
    }),
  )

  // Phase 3 of accuracy E (docs/accuracy-e.md §11.8): the goal endpoint.
  it.instance(
    "sets, replaces, reads and ends a session's goal, only with the host token",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const session = yield* createSession({ title: "worker" })
        const goalPath = ExperimentalPaths.sessionGoal.replace(":sessionID", session.id)
        const host = { [HostToken.HEADER]: HostToken.issue() }
        const post = (body: unknown, headers: Record<string, string> = host) =>
          request(goalPath, tmp.directory, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body),
          })

        // the goal is the host's to write: without its token (the worker has only the
        // server password), or with a wrong one, a write is refused
        expect((yield* post({ text: "goal" }, {})).status).toBe(403)
        expect((yield* post({ text: "goal" }, { [HostToken.HEADER]: "not-the-token" })).status).toBe(403)
        expect((yield* request(goalPath, tmp.directory, { method: "DELETE" })).status).toBe(403)

        expect((yield* request(goalPath, tmp.directory)).status).toBe(404)
        expect((yield* request(goalPath, tmp.directory, { method: "DELETE", headers: host })).status).toBe(404)
        expect((yield* post({ text: "" })).status).toBe(400)
        expect((yield* post({ text: "x".repeat(4_001) })).status).toBe(400)
        // the base is the server's snapshot, never one the client names
        const forged = "0000000000000000000000000000000000000000"
        const set = yield* post({ text: "cap the output", criteria: ["capped at 4 KB"], base: forged })
        expect(set.status).toBe(200)
        const started = yield* json<{ id: string; base: string | null; startedAt: number }>(set)
        expect(started.base).toMatch(/^[0-9a-f]{40}$/)
        expect(started.base).not.toBe(forged)
        const replaced = yield* json<{ id: string }>(yield* post({ text: "cap it lower" }))

        const read = yield* request(goalPath, tmp.directory)
        expect(read.status).toBe(200)
        const goal = yield* json<{ id: string; text: string; history: Array<Record<string, unknown>> }>(read)
        expect(goal.id).toBe(replaced.id)
        expect(goal.text).toBe("cap it lower")
        expect(JSON.stringify(goal)).not.toContain(forged)
        expect(goal.history.map((change) => [change.type, change.via])).toEqual([
          ["set", "host"],
          ["replace", "host"],
        ])

        const ended = yield* request(goalPath, tmp.directory, { method: "DELETE", headers: host })
        expect(ended.status).toBe(200)
        const after = yield* json<{ endedAt?: number; history: Array<Record<string, unknown>> }>(ended)
        expect(after.endedAt).toBeNumber()
        expect(after.history.at(-1)).toMatchObject({ type: "end", via: "host", goal: replaced.id })

        const missing = ExperimentalPaths.sessionGoal.replace(":sessionID", "ses_missing")
        expect((yield* request(missing, tmp.directory)).status).toBe(404)

        // at most 10 changes a minute per session (3 made above), then 429
        for (let i = 0; i < 7; i++) expect((yield* post({ text: `goal ${i}` })).status).toBe(200)
        const limited = yield* post({ text: "one too many" })
        expect(limited.status).toBe(429)
        expect(yield* json(limited)).toMatchObject({ _tag: "GoalRateLimited" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance("returns declared worktree errors", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* request(ExperimentalPaths.worktree, tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(400)
      expect(yield* json(response)).toEqual({
        name: "WorktreeNotGitError",
        data: { message: "Worktrees are only supported for git projects" },
      })
    }),
  )

  it.instance(
    "serves Console org switch through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const accountID = yield* insertAccount()
        const switched = yield* request(ExperimentalPaths.consoleSwitch, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountID, orgID: "org-test" }),
        })

        expect(switched.status).toBe(200)
        expect(yield* json(switched)).toBe(true)
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves global session list through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const first = yield* createSession({ title: "page-one" })
        const second = yield* createSession({ title: "page-two" })
        yield* setSessionUpdated(first, 1)
        yield* setSessionUpdated(second, 2)

        const page = yield* request(
          `${ExperimentalPaths.session}?${new URLSearchParams({ directory: tmp.directory, limit: "1" })}`,
          tmp.directory,
        )
        expect(page.status).toBe(200)
        expect(page.headers["x-next-cursor"]).toBeTruthy()

        const body = yield* json<Session.GlobalInfo[]>(page)
        expect(body.map((session) => session.id)).toEqual([second.id])
        expect(body[0].project?.id).toBe(second.projectID)

        const next = yield* request(
          `${ExperimentalPaths.session}?${new URLSearchParams({
            directory: tmp.directory,
            limit: "10",
            cursor: body[0].time.updated.toString(),
          })}`,
          tmp.directory,
        )
        expect(next.status).toBe(200)
        expect((yield* json<Session.GlobalInfo[]>(next)).map((session) => session.id)).toContain(first.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  testWorktreeMutations(
    "serves worktree mutations through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* withCreatedWorktree(tmp.directory, (info) =>
          Effect.gen(function* () {
            const listed = yield* request(ExperimentalPaths.worktree, tmp.directory)
            expect(listed.status).toBe(200)
            expect(yield* json(listed)).toContain(info.directory)

            const reset = yield* request(ExperimentalPaths.worktreeReset, tmp.directory, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ directory: info.directory }),
            })

            expect(reset.status).toBe(200)
            expect(yield* json(reset)).toBe(true)
          }),
        )

        const afterRemove = yield* request(ExperimentalPaths.worktree, tmp.directory)
        expect(afterRemove.status).toBe(200)
        expect(yield* json(afterRemove)).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
