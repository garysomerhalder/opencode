import type { GoalLoopStartInput } from "./types"

// Max characters for the remembered-goal line in the always-visible goal
// section. The section also truncates with CSS; this keeps the DOM small.
export const LAST_GOAL_SNIPPET_MAX = 140

export type LastInputView = {
  // Ticket identifier (e.g. "ABC-123"), or "" when the input has no ticket.
  strong: string
  // Ticket title, or the goal snippet when there is no ticket.
  rest: string
  // Working directory the loop would restart in (may be "").
  detail: string
}

export function snippetGoal(goal: string, max: number = LAST_GOAL_SNIPPET_MAX): string {
  const collapsed = goal.trim().replace(/\s+/g, " ")
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1).trimEnd()}…`
}

// Maps platform.goalLoop.last() to the idle section view. Returns null when
// there is nothing worth showing (no ticket and a blank goal).
export function describeLastInput(last: GoalLoopStartInput | null | undefined): LastInputView | null {
  if (!last) return null
  const detail = last.directory.trim()
  const ticket = last.ticket
  if (ticket && ticket.identifier.trim().length > 0) {
    return { strong: ticket.identifier.trim(), rest: ticket.title.trim(), detail }
  }
  const rest = snippetGoal(last.goal)
  if (rest.length === 0) return null
  return { strong: "", rest, detail }
}
