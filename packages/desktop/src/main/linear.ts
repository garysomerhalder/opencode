import electron from "electron"

import { getStore, removeStoreFileIfEmpty } from "./store"
import { LINEAR_STORE } from "./store-keys"

const LINEAR_ENDPOINT = "https://api.linear.app/graphql"
const LINEAR_API_KEY_KEY = "apiKey"
const ERROR_SNIPPET_LIMIT = 300
const DEFAULT_ASSIGNED_FIRST = 25

export type LinearClientDeps = {
  getKey: () => Promise<string | null>
  fetchImpl?: typeof fetch
}

export type LinearViewer = {
  id: string
  name: string
  email: string
}

export type LinearIssueState = {
  name: string
  type: string
}

export type LinearIssueAssignee = {
  id: string
  name: string
  email: string
} | null

export type LinearIssue = {
  id: string
  identifier: string
  title: string
  description: string | null
  priority: number
  estimate: number | null
  state: LinearIssueState
  labels: string[]
  assignee: LinearIssueAssignee
  team: { key: string }
  updatedAt: string
}

export type LinearCommentUser = {
  id: string
  name: string
  email: string
} | null

export type LinearComment = {
  id: string
  body: string
  createdAt: string
  user: LinearCommentUser
}

export type LinearIssueDetail = LinearIssue & {
  comments: LinearComment[]
}

export type LinearTeam = {
  id: string
  key: string
  name: string
}

export type LinearAssignedInput = {
  teamKey?: string
  first?: number
}

export type LinearClient = {
  gql: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>
  viewer: () => Promise<LinearViewer>
  assignedIssues: (input?: LinearAssignedInput) => Promise<LinearIssue[]>
  issue: (id: string) => Promise<LinearIssueDetail>
  comment: (issueId: string, body: string) => Promise<{ id: string }>
  teams: () => Promise<LinearTeam[]>
}

const VIEWER_QUERY = "query LinearViewer { viewer { id name email } }"

const ASSIGNED_ISSUES_QUERY = `query LinearAssignedIssues($first: Int, $filter: IssueFilter) {
  issues(first: $first, filter: $filter, orderBy: updatedAt) {
    nodes {
      id
      identifier
      title
      description
      priority
      estimate
      state { name type }
      labels { nodes { name } }
      assignee { id name email }
      team { key }
      updatedAt
    }
  }
}`

const ISSUE_QUERY = `query LinearIssue($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    priority
    estimate
    state { name type }
    labels { nodes { name } }
    assignee { id name email }
    team { key }
    updatedAt
    comments(first: 5) {
      nodes {
        id
        body
        createdAt
        user { id name email }
      }
    }
  }
}`

const COMMENT_MUTATION = `mutation LinearCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id }
  }
}`

const TEAMS_QUERY = `query { teams(first: 50) { nodes { id key name } } }`

type SafeStorageLike = {
  isEncryptionAvailable: () => boolean
  encryptString: (plain: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

function getSafeStorage(): SafeStorageLike | undefined {
  try {
    const candidate = (electron as unknown as { safeStorage?: SafeStorageLike }).safeStorage
    if (!candidate || typeof candidate.isEncryptionAvailable !== "function") return undefined
    return candidate
  } catch {
    return undefined
  }
}

function encryptionAvailable(): boolean {
  const storage = getSafeStorage()
  if (!storage) return false
  try {
    return storage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function assertValidLinearApiKey(key: unknown): asserts key is string {
  if (typeof key !== "string") throw new Error("linear-invalid-key")
  if (key.trim().length === 0) throw new Error("linear-invalid-key")
}

export async function getLinearApiKey(): Promise<string | null> {
  const store = getStore(LINEAR_STORE)
  const stored = store.get(LINEAR_API_KEY_KEY) as unknown
  if (typeof stored !== "string") return null
  if (stored.length === 0) return null
  const storage = getSafeStorage()
  if (!storage || !encryptionAvailable()) return stored
  try {
    return storage.decryptString(Buffer.from(stored, "base64"))
  } catch {
    return null
  }
}

export async function setLinearApiKey(key: string): Promise<void> {
  assertValidLinearApiKey(key)
  const value = key.trim()
  const store = getStore(LINEAR_STORE)
  const storage = getSafeStorage()
  if (!storage || !encryptionAvailable()) {
    store.set(LINEAR_API_KEY_KEY, value)
    return
  }
  const encrypted = storage.encryptString(value)
  store.set(LINEAR_API_KEY_KEY, encrypted.toString("base64"))
}

export async function clearLinearApiKey(): Promise<void> {
  const store = getStore(LINEAR_STORE)
  store.delete(LINEAR_API_KEY_KEY)
  void removeStoreFileIfEmpty(LINEAR_STORE)
}

async function readSnippet(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.slice(0, ERROR_SNIPPET_LIMIT)
  } catch {
    return ""
  }
}

function parseLabels(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return []
  const nodes = (value as Record<string, unknown>)["nodes"]
  if (!Array.isArray(nodes)) return []
  const names: string[] = []
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue
    const name = (node as Record<string, unknown>)["name"]
    if (typeof name === "string") names.push(name)
  }
  return names
}

function parseAssignee(value: unknown): LinearIssueAssignee {
  if (typeof value !== "object" || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record["id"] !== "string") return null
  if (typeof record["name"] !== "string") return null
  if (typeof record["email"] !== "string") return null
  return { id: record["id"], name: record["name"], email: record["email"] }
}

function parseCommentUser(value: unknown): LinearCommentUser {
  if (typeof value !== "object" || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record["id"] !== "string") return null
  if (typeof record["name"] !== "string") return null
  if (typeof record["email"] !== "string") return null
  return { id: record["id"], name: record["name"], email: record["email"] }
}

function parseIssueNode(node: unknown): LinearIssue | null {
  if (typeof node !== "object" || node === null) return null
  const record = node as Record<string, unknown>
  if (typeof record["id"] !== "string") return null
  if (typeof record["identifier"] !== "string") return null
  if (typeof record["title"] !== "string") return null
  if (typeof record["updatedAt"] !== "string") return null
  const state = record["state"] as Record<string, unknown> | null | undefined
  const team = record["team"] as Record<string, unknown> | null | undefined
  return {
    id: record["id"],
    identifier: record["identifier"],
    title: record["title"],
    description: typeof record["description"] === "string" ? record["description"] : null,
    priority: typeof record["priority"] === "number" ? record["priority"] : 0,
    estimate: typeof record["estimate"] === "number" ? record["estimate"] : null,
    state: {
      name: typeof state?.["name"] === "string" ? state["name"] : "",
      type: typeof state?.["type"] === "string" ? state["type"] : "",
    },
    labels: parseLabels(record["labels"]),
    assignee: parseAssignee(record["assignee"]),
    team: { key: typeof team?.["key"] === "string" ? team["key"] : "" },
    updatedAt: record["updatedAt"],
  }
}

function parseComments(value: unknown): LinearComment[] {
  if (typeof value !== "object" || value === null) return []
  const nodes = (value as Record<string, unknown>)["nodes"]
  if (!Array.isArray(nodes)) return []
  const comments: LinearComment[] = []
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue
    const record = node as Record<string, unknown>
    if (typeof record["id"] !== "string") continue
    if (typeof record["body"] !== "string") continue
    if (typeof record["createdAt"] !== "string") continue
    comments.push({
      id: record["id"],
      body: record["body"],
      createdAt: record["createdAt"],
      user: parseCommentUser(record["user"]),
    })
  }
  return comments
}

function parseIssueDetail(value: unknown): LinearIssueDetail | null {
  const base = parseIssueNode(value)
  if (!base) return null
  if (typeof value !== "object" || value === null) return null
  const comments = parseComments((value as Record<string, unknown>)["comments"])
  return { ...base, comments }
}

function parseTeamNode(node: unknown): LinearTeam | null {
  if (typeof node !== "object" || node === null) return null
  const record = node as Record<string, unknown>
  if (typeof record["id"] !== "string") return null
  if (typeof record["key"] !== "string") return null
  if (typeof record["name"] !== "string") return null
  return { id: record["id"], key: record["key"], name: record["name"] }
}

export function createLinearClient(deps: LinearClientDeps): LinearClient {
  const fetchImpl = deps.fetchImpl ?? fetch

  async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const key = await deps.getKey()
    if (!key) throw new Error("linear-not-configured")
    const response = await fetchImpl(LINEAR_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: key,
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
    })
    if (!response.ok) {
      const snippet = await readSnippet(response)
      throw new Error(`linear request failed (${response.status}): ${snippet}`)
    }
    const payload = (await response.json()) as unknown as {
      data?: T
      errors?: Array<{ message?: unknown }>
    }
    if (payload && typeof payload === "object" && Array.isArray(payload.errors) && payload.errors.length > 0) {
      const first = payload.errors[0]?.message
      const message = typeof first === "string" && first.length > 0 ? first : "unknown Linear error"
      throw new Error(message.slice(0, ERROR_SNIPPET_LIMIT))
    }
    if (!payload || typeof payload !== "object" || payload.data === undefined) {
      throw new Error("linear request failed: missing data")
    }
    return payload.data
  }

  async function viewer(): Promise<LinearViewer> {
    const data = await gql<{ viewer: { id?: unknown; name?: unknown; email?: unknown } }>(VIEWER_QUERY)
    const item = data.viewer
    if (!item || typeof item.id !== "string") throw new Error("linear request failed: missing viewer")
    if (typeof item.name !== "string") throw new Error("linear request failed: missing viewer")
    if (typeof item.email !== "string") throw new Error("linear request failed: missing viewer")
    return { id: item.id, name: item.name, email: item.email }
  }

  async function assignedIssues(input: LinearAssignedInput = {}): Promise<LinearIssue[]> {
    const first =
      typeof input.first === "number" && Number.isFinite(input.first) && input.first > 0
        ? Math.floor(input.first)
        : DEFAULT_ASSIGNED_FIRST
    const filter: Record<string, unknown> = { assignee: { isMe: { eq: true } } }
    if (typeof input.teamKey === "string" && input.teamKey.trim().length > 0) {
      filter["team"] = { key: { eq: input.teamKey.trim() } }
    }
    const data = await gql<{ issues: { nodes?: unknown } }>(ASSIGNED_ISSUES_QUERY, { first, filter })
    const nodes = data.issues?.nodes
    if (!Array.isArray(nodes)) return []
    const issues: LinearIssue[] = []
    for (const node of nodes) {
      const parsed = parseIssueNode(node)
      if (!parsed) continue
      issues.push(parsed)
    }
    return issues
  }

  async function issue(id: string): Promise<LinearIssueDetail> {
    if (typeof id !== "string" || id.trim().length === 0) throw new Error("linear-invalid-issue-id")
    const data = await gql<{ issue: unknown }>(ISSUE_QUERY, { id })
    const parsed = parseIssueDetail(data.issue)
    if (!parsed) throw new Error("linear issue not found")
    return parsed
  }

  async function comment(issueId: string, body: string): Promise<{ id: string }> {
    if (typeof issueId !== "string" || issueId.trim().length === 0) throw new Error("linear-invalid-issue-id")
    if (typeof body !== "string" || body.trim().length === 0) throw new Error("linear-invalid-comment-body")
    const data = await gql<{ commentCreate: { success?: unknown; comment?: unknown } }>(COMMENT_MUTATION, {
      input: { issueId, body },
    })
    const result = data.commentCreate
    if (!result || result.success !== true) throw new Error("linear comment creation failed")
    if (typeof result.comment !== "object" || result.comment === null) {
      throw new Error("linear comment creation failed")
    }
    const id = (result.comment as Record<string, unknown>)["id"]
    if (typeof id !== "string") throw new Error("linear comment creation failed")
    return { id }
  }

  async function teams(): Promise<LinearTeam[]> {
    const data = await gql<{ teams: { nodes?: unknown } }>(TEAMS_QUERY)
    const nodes = data.teams?.nodes
    if (!Array.isArray(nodes)) return []
    const result: LinearTeam[] = []
    for (const node of nodes) {
      const parsed = parseTeamNode(node)
      if (!parsed) continue
      result.push(parsed)
    }
    result.sort((a, b) => a.key.localeCompare(b.key))
    return result
  }

  return { gql, viewer, assignedIssues, issue, comment, teams }
}
