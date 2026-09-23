import { describe, expect, test } from "bun:test"
import { appEnvDefaults } from "./app-env"

describe("appEnvDefaults", () => {
  test("keeps the experimental working-tree watcher off on Windows", () => {
    const env = appEnvDefaults("win32")
    expect(env.OPENCODE_EXPERIMENTAL_FILEWATCHER).toBeUndefined()
    expect(env.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY).toBe("true")
    expect(env.OPENCODE_CLIENT).toBe("desktop")
  })

  test("keeps the experimental working-tree watcher on elsewhere", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const env = appEnvDefaults(platform)
      expect(env.OPENCODE_EXPERIMENTAL_FILEWATCHER).toBe("true")
      expect(env.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY).toBe("true")
      expect(env.OPENCODE_CLIENT).toBe("desktop")
    }
  })
})
