import { describe, expect, test } from "bun:test"
import { appEnvDefaults } from "./app-env"

describe("appEnvDefaults", () => {
  test("turns the native file watcher off entirely on Windows", () => {
    const env = appEnvDefaults("win32")
    expect(env.OPENCODE_EXPERIMENTAL_FILEWATCHER).toBeUndefined()
    expect(env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER).toBe("true")
    expect(env.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY).toBe("true")
    expect(env.OPENCODE_CLIENT).toBe("desktop")
  })

  test("keeps the watcher on elsewhere", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const env = appEnvDefaults(platform)
      expect(env.OPENCODE_EXPERIMENTAL_FILEWATCHER).toBe("true")
      expect(env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER).toBeUndefined()
      expect(env.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY).toBe("true")
      expect(env.OPENCODE_CLIENT).toBe("desktop")
    }
  })

  test("a value already in the environment re-enables the watcher on Windows", () => {
    const env = appEnvDefaults("win32", {
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "false",
      OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    })
    expect(env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER).toBe("false")
    // not set by the defaults, so the environment's "true" stays in place
    expect(env.OPENCODE_EXPERIMENTAL_FILEWATCHER).toBeUndefined()
  })
})
