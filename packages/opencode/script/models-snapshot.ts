// Loads the models.dev snapshot that builds embed (OPENCODE_MODELS_DEV).
//
// Behind a TLS-intercepting proxy (Norton on this machine) Bun's bundled CA list
// does not trust the proxy's certificate and the fetch fails, which stopped the
// desktop `predev`. The build scripts now run Bun with --use-system-ca, and a
// failure says so and names MODELS_DEV_API_JSON, which reads a local snapshot
// instead. A non-OK response is an error rather than an error page embedded as
// the snapshot.

export async function loadModelsSnapshot(input: {
  jsonPath?: string
  url: string
  fetch: typeof fetch
  read: (file: string) => Promise<string>
}) {
  if (input.jsonPath) return input.read(input.jsonPath)
  const source = `${input.url}/api.json`
  const response = await input.fetch(source).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `could not fetch ${source}: ${reason}\n` +
        "Behind a TLS-intercepting proxy, run Bun with --use-system-ca, or set MODELS_DEV_API_JSON to a local api.json.",
    )
  })
  if (!response.ok) throw new Error(`models.dev returned ${response.status} for ${source}`)
  return response.text()
}
