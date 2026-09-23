import { describe, expect, test } from "bun:test"
import { serverStatusView } from "./view"

describe("server status banner", () => {
  test("nothing while the server runs, starts or was stopped on purpose", () => {
    expect(serverStatusView({ status: "running", restarts: 2 }, 0)).toBeUndefined()
    expect(serverStatusView({ status: "starting", restarts: 0 }, 0)).toBeUndefined()
    expect(serverStatusView({ status: "stopped", restarts: 0 }, 0)).toBeUndefined()
    expect(serverStatusView(null, 0)).toBeUndefined()
  })

  test("restarting after a crash says so, with the exit code and when it retries", () => {
    const view = serverStatusView(
      { status: "restarting", restarts: 1, lastExit: { code: 3221225477, at: 1_000 }, nextAt: 6_000 },
      1_500,
    )
    expect(view).toEqual({
      tone: "warning",
      key: "serverStatus.restarting",
      params: { code: "0xC0000005", seconds: 5, attempt: 1 },
      canRestart: false,
    })
  })

  test("failed says the server stopped and offers a restart", () => {
    const view = serverStatusView(
      { status: "failed", restarts: 4, lastExit: { code: 1, at: 0 }, error: "server exited 5 times in a row" },
      0,
    )
    expect(view).toEqual({
      tone: "error",
      key: "serverStatus.failed",
      params: { code: "1", reason: "server exited 5 times in a row" },
      canRestart: true,
    })
  })
})
