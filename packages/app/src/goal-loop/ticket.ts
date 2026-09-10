export interface TicketIssue {
  id: string
  identifier: string
  title: string
  description?: string | null
  priority?: number | null
  estimate?: number | null
  state?: { name: string; type?: string } | null
  labels?: string[]
  team?: { key?: string } | null
}

const DESCRIPTION_LIMIT = 2000

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

export function buildTicketGoal(issue: TicketIssue, directory: string): string {
  const priority = issue.priority ?? "?"
  const rawStateName = issue.state?.name?.trim()
  const stateName = rawStateName ? rawStateName : "unknown"
  const header = `${issue.identifier}: ${issue.title} (P${priority}, ${stateName})`.trimEnd()

  const labelsLine = (issue.labels ?? [])
    .map((label) => label.trim())
    .filter((label) => label.length > 0)
    .join(", ")

  const rawDescription = normalizeLineEndings(issue.description ?? "").trim()
  const truncated = rawDescription.slice(0, DESCRIPTION_LIMIT).trimEnd()
  const description = truncated
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")

  const lines: string[] = [header]
  if (labelsLine.length > 0) {
    lines.push(labelsLine.trimEnd())
  }
  if (description.length > 0) {
    lines.push("")
    lines.push(description)
  }
  lines.push("---")
  lines.push(
    `Work this Linear ticket to done in ${directory}. Follow the repository's own workflow (tests before/after, verify your work). When the ticket's acceptance criteria are fully met, reply with GOAL_COMPLETE on its own line and stop.`.trimEnd(),
  )

  return `${lines.join("\n")}\n`
}
