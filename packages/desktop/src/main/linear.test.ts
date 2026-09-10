import { describe, expect, test } from "bun:test"
import { assertValidLinearApiKey, createLinearClient, setLinearApiKey } from "./linear"

type CapturedRequest = {
  url: string
  init: RequestInit
  body: Record<string, unknown>
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function stubFetch(response: Response, captured: CapturedRequest[]) {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "{}"
    captured.push({ url: String(input), init: init ?? {}, body: JSON.parse(raw) as Record<string, unknown> })
    return response
  }) as typeof fetch
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>
}

function variablesOf(body: Record<string, unknown>): Record<string, unknown> {
  return (body["variables"] ?? {}) as Record<string, unknown>
}

describe("linear client", () => {
  test("posts the GraphQL envelope with the raw key", async () => {
    const captured: CapturedRequest[] = []
    const fetchImpl = stubFetch(
      json({ data: { viewer: { id: "u1", name: "Gary", email: "gary@example.com" } } }),
      captured,
    )
    const client = createLinearClient({ getKey: async () => "lin_test_key", fetchImpl })
    const viewer = await client.viewer()
    expect(viewer).toEqual({ id: "u1", name: "Gary", email: "gary@example.com" })
    expect(captured).toHaveLength(1)
    const first = captured[0]
    if (!first) throw new Error("expected a captured request")
    expect(first.url).toBe("https://api.linear.app/graphql")
    expect(first.init.method).toBe("POST")
    const headers = headersOf(first.init)
    expect(headers["Authorization"]).toBe("lin_test_key")
    expect(headers["Authorization"]).not.toContain("Bearer")
    expect(headers["Content-Type"]).toBe("application/json")
  })

  test("throws the first GraphQL error message truncated", async () => {
    const long = `boom ${"x".repeat(500)}`
    const fetchImpl = (async () => json({ errors: [{ message: long }] })) as typeof fetch
    const client = createLinearClient({ getKey: async () => "k", fetchImpl })
    const error = await client.viewer().then(
      () => null,
      (caught: unknown) => caught as Error,
    )
    if (!error) throw new Error("expected viewer to throw")
    expect(error.message).toHaveLength(300)
  })

  test("throws with status on non-2xx responses", async () => {
    const fetchImpl = (async () => new Response("bad key", { status: 401 })) as typeof fetch
    const client = createLinearClient({ getKey: async () => "bad", fetchImpl })
    const error = await client.viewer().then(
      () => null,
      (caught: unknown) => caught as Error,
    )
    if (!error) throw new Error("expected viewer to throw")
    expect(error.message).toContain("401")
    expect(error.message).toContain("bad key")
  })

  test("assignedIssues sends the assignee-me filter and parses nodes", async () => {
    const captured: CapturedRequest[] = []
    const nodes = [
      {
        id: "i1",
        identifier: "ENG-1",
        title: "Fix it",
        description: "details",
        priority: 2,
        estimate: 3,
        state: { name: "Todo", type: "unstarted" },
        labels: { nodes: [{ name: "bug" }, { name: "ui" }] },
        assignee: { id: "u1", name: "Gary", email: "gary@example.com" },
        team: { key: "ENG" },
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    ]
    const fetchImpl = stubFetch(json({ data: { issues: { nodes } } }), captured)
    const client = createLinearClient({ getKey: async () => "k", fetchImpl })
    const issues = await client.assignedIssues({ teamKey: "ENG", first: 10 })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.labels).toEqual(["bug", "ui"])
    expect(issues[0]?.identifier).toBe("ENG-1")
    const first = captured[0]
    if (!first) throw new Error("expected a captured request")
    const query = first.body["query"]
    if (typeof query !== "string") throw new Error("expected a query string")
    expect(query).toContain("orderBy: updatedAt")
    const variables = variablesOf(first.body)
    expect(variables["first"]).toBe(10)
    const filter = variables["filter"] as Record<string, unknown>
    const assignee = filter["assignee"] as Record<string, unknown>
    const isMe = assignee["isMe"] as Record<string, unknown>
    expect(isMe["eq"]).toBe(true)
    const team = filter["team"] as Record<string, unknown>
    const teamKey = team["key"] as Record<string, unknown>
    expect(teamKey["eq"]).toBe("ENG")
  })

  test("comment mutation shapes the input body", async () => {
    const captured: CapturedRequest[] = []
    const fetchImpl = stubFetch(json({ data: { commentCreate: { success: true, comment: { id: "c1" } } } }), captured)
    const client = createLinearClient({ getKey: async () => "k", fetchImpl })
    const result = await client.comment("issue-1", "hello")
    expect(result).toEqual({ id: "c1" })
    const first = captured[0]
    if (!first) throw new Error("expected a captured request")
    const query = first.body["query"]
    if (typeof query !== "string") throw new Error("expected a query string")
    expect(query).toContain("commentCreate")
    const variables = variablesOf(first.body)
    const input = variables["input"] as Record<string, unknown>
    expect(input["issueId"]).toBe("issue-1")
    expect(input["body"]).toBe("hello")
  })

  test("key validation rejects empty values", async () => {
    expect(() => assertValidLinearApiKey("")).toThrow("linear-invalid-key")
    expect(() => assertValidLinearApiKey("   ")).toThrow("linear-invalid-key")
    await expect(setLinearApiKey("")).rejects.toThrow("linear-invalid-key")
  })

  test("teams returns entries sorted by key", async () => {
    const captured: CapturedRequest[] = []
    const nodes = [
      { id: "t2", key: "ZEB", name: "Zebra" },
      { id: "t1", key: "ENG", name: "Engineering" },
      { id: "t3", key: "DES", name: "Design" },
    ]
    const fetchImpl = stubFetch(json({ data: { teams: { nodes } } }), captured)
    const client = createLinearClient({ getKey: async () => "k", fetchImpl })
    const teams = await client.teams()
    expect(teams.map((team) => team.key)).toEqual(["DES", "ENG", "ZEB"])
    expect(teams[0]).toEqual({ id: "t3", key: "DES", name: "Design" })
    const first = captured[0]
    if (!first) throw new Error("expected a captured request")
    const query = first.body["query"]
    if (typeof query !== "string") throw new Error("expected a query string")
    expect(query).toContain("teams(first: 50)")
    expect(query).toContain("nodes { id key name }")
  })

  test("teams returns an empty list when no nodes", async () => {
    const fetchImpl = (async () => json({ data: { teams: { nodes: [] } } })) as typeof fetch
    const client = createLinearClient({ getKey: async () => "k", fetchImpl })
    const teams = await client.teams()
    expect(teams).toEqual([])
  })

  test("teams propagates GraphQL errors", async () => {
    const fetchImpl = (async () => json({ errors: [{ message: "teams boom" }] })) as typeof fetch
    const client = createLinearClient({ getKey: async () => "k", fetchImpl })
    const error = await client.teams().then(
      () => null,
      (caught: unknown) => caught as Error,
    )
    if (!error) throw new Error("expected teams to throw")
    expect(error.message).toContain("teams boom")
  })
})
