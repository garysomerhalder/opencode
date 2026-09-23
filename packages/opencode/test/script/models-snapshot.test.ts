import { describe, expect, test } from "bun:test"
import { loadModelsSnapshot } from "../../script/models-snapshot"

const never = (() => {
  throw new Error("fetch must not be called")
}) as unknown as typeof fetch

describe("loadModelsSnapshot", () => {
  test("MODELS_DEV_API_JSON wins and nothing is fetched", async () => {
    const text = await loadModelsSnapshot({
      jsonPath: "C:/snapshots/api.json",
      url: "https://models.dev",
      fetch: never,
      read: async (file) => `read:${file}`,
    })
    expect(text).toBe("read:C:/snapshots/api.json")
  })

  test("fetches the snapshot when no file is given", async () => {
    const text = await loadModelsSnapshot({
      url: "https://models.dev",
      fetch: (async (input: string) => {
        expect(input).toBe("https://models.dev/api.json")
        return new Response('{"openai":{}}', { status: 200 })
      }) as unknown as typeof fetch,
      read: async () => "",
    })
    expect(text).toBe('{"openai":{}}')
  })

  test("an HTTP error is an error, not an error page used as the snapshot", async () => {
    const run = loadModelsSnapshot({
      url: "https://models.dev",
      fetch: (async () => new Response("<html>blocked</html>", { status: 403 })) as unknown as typeof fetch,
      read: async () => "",
    })
    await expect(run).rejects.toThrow("models.dev returned 403")
  })

  test("a TLS or network failure says how to get past it", async () => {
    const run = loadModelsSnapshot({
      url: "https://models.dev",
      fetch: (async () => {
        throw new Error("unable to get local issuer certificate")
      }) as unknown as typeof fetch,
      read: async () => "",
    })
    await expect(run).rejects.toThrow(
      /unable to get local issuer certificate[\s\S]*--use-system-ca[\s\S]*MODELS_DEV_API_JSON/,
    )
  })
})
