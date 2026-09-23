import { describe, expect, test } from "bun:test"
import { createSidecarSupervisor, type SidecarState, type StartedSidecar } from "./sidecar-supervisor"

type Fake = { url: string; exit: (code: number) => void; stopped: boolean }

function harness(options: { failStarts?: number[]; urls?: string[]; maxCrashes?: number } = {}) {
  const started: Fake[] = []
  const states: SidecarState[] = []
  const sleeps: number[] = []
  let clock = 0
  let starts = 0
  const supervisor = createSidecarSupervisor({
    start: async (previous) => {
      starts += 1
      if (options.failStarts?.includes(starts)) throw new Error(`start ${starts} failed`)
      let resolveExit!: (code: number) => void
      const exited = new Promise<number>((resolve) => (resolveExit = resolve))
      const fake: Fake = {
        url: options.urls?.[started.length] ?? previous?.url ?? "http://127.0.0.1:4096",
        exit: (code) => resolveExit(code),
        stopped: false,
      }
      started.push(fake)
      return {
        connection: { url: fake.url, username: "opencode", password: "pw" },
        exited,
        stop: async () => {
          fake.stopped = true
          resolveExit(0)
        },
      } satisfies StartedSidecar
    },
    onState: (state) => states.push(state),
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    now: () => clock,
    policy: { delays: [1000, 2000, 5000, 10_000], maxCrashes: options.maxCrashes ?? 3, windowMs: 60_000 },
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  return { supervisor, started, states, sleeps, settle, tick: (ms: number) => (clock += ms) }
}

describe("sidecar supervisor", () => {
  test("starts once and reports running with the connection", async () => {
    const { supervisor, states } = harness()
    const connection = await supervisor.start()
    expect(connection.url).toBe("http://127.0.0.1:4096")
    expect(states.map((state) => state.status)).toEqual(["starting", "running"])
  })

  test("a crash is restarted after a backoff, and the new connection is reported", async () => {
    const { supervisor, started, states, sleeps, settle } = harness()
    await supervisor.start()
    started[0]!.exit(3221225477) // 0xC0000005
    await settle()
    await settle()
    expect(started).toHaveLength(2)
    expect(sleeps).toEqual([1000])
    const statuses = states.map((state) => state.status)
    expect(statuses).toEqual(["starting", "running", "restarting", "starting", "running"])
    const restarting = states.find((state) => state.status === "restarting")!
    expect(restarting.lastExit?.code).toBe(3221225477)
    expect(restarting.restarts).toBe(1)
    expect(supervisor.state().status).toBe("running")
  })

  test("the restart reuses the previous connection when it can", async () => {
    const { supervisor, started, settle } = harness()
    await supervisor.start()
    started[0]!.exit(1)
    await settle()
    await settle()
    expect(started[1]!.url).toBe(started[0]!.url)
  })

  test("backoff follows 1s, 2s, 5s, 10s and stays at 10s", async () => {
    const { supervisor, started, sleeps, settle } = harness({ maxCrashes: 10 })
    await supervisor.start()
    for (let i = 0; i < 6; i++) {
      started.at(-1)!.exit(1)
      await settle()
      await settle()
    }
    expect(sleeps).toEqual([1000, 2000, 5000, 10_000, 10_000, 10_000])
  })

  test("too many crashes inside the window stops restarting and reports failed", async () => {
    const { supervisor, started, states, settle } = harness()
    await supervisor.start()
    for (let i = 0; i < 3; i++) {
      started.at(-1)!.exit(1)
      await settle()
      await settle()
    }
    expect(supervisor.state().status).toBe("failed")
    expect(started).toHaveLength(3)
    expect(states.at(-1)?.status).toBe("failed")
  })

  test("crashes spread out beyond the window keep restarting", async () => {
    const { supervisor, started, settle, tick } = harness()
    await supervisor.start()
    for (let i = 0; i < 5; i++) {
      tick(120_000)
      started.at(-1)!.exit(1)
      await settle()
      await settle()
    }
    expect(supervisor.state().status).toBe("running")
    expect(started).toHaveLength(6)
  })

  test("a failed restart attempt counts as a crash and is retried", async () => {
    const { supervisor, started, settle } = harness({ failStarts: [2] })
    await supervisor.start()
    started[0]!.exit(1)
    for (let i = 0; i < 6; i++) await settle()
    expect(supervisor.state().status).toBe("running")
    expect(started).toHaveLength(2)
  })

  test("a manual restart after failure starts it again", async () => {
    const { supervisor, started, settle } = harness()
    await supervisor.start()
    for (let i = 0; i < 3; i++) {
      started.at(-1)!.exit(1)
      await settle()
      await settle()
    }
    expect(supervisor.state().status).toBe("failed")
    await supervisor.restart()
    expect(supervisor.state().status).toBe("running")
  })

  test("a deliberate stop is not restarted", async () => {
    const { supervisor, started, settle } = harness()
    await supervisor.start()
    await supervisor.stop()
    await settle()
    await settle()
    expect(started).toHaveLength(1)
    expect(supervisor.state().status).toBe("stopped")
  })
})
