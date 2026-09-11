export type Difficulty = "trivial" | "easy" | "medium" | "hard"

export type Route = "main" | "small"

export type Decision = {
  difficulty: Difficulty
  route: Route
  effort: string | null
}

export type ClassifyInput = {
  text: string
  fileCount: number
  wordCount: number
}

export type AdaptiveEffortOptions = {
  enabled?: boolean
  classifier?: "rules" | "hybrid"
  smallModel?: string
  efforts?: Partial<Record<Difficulty, string | null>>
}
