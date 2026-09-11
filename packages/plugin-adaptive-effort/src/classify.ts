import type { ClassifyInput, Decision, Difficulty, Route } from "./types.js"

const GRUNT_PATTERNS: RegExp[] = [
  /\b(summarize|summarise|explain what|what does .* do|how does .* work)\b/i,
  /\b(rename|format|organize|organise)\b/i,
  /\b(write a test|add a test|generate a test|test file)\b/i,
  /\b(boilerplate|scaffold|stub|skeleton)\b/i,
  /\b(convert|translate)\b/i,
  /\b(fix typo|fix the typo|correct grammar|fix grammar)\b/i,
  /\b(update (the )?(readme|docs|documentation))\b/i,
]

const HARD_PATTERNS: RegExp[] = [
  /\b(debug|investigate|troubleshoot|root cause|why is .* (broken|failing|crashing))\b/i,
  /\b(refactor|rearchitect|redesign|architecture)\b/i,
  /\b(race condition|deadlock|thread.?safety|concurrency)\b/i,
  /\b(security|vulnerability|CVE|exploit|injection)\b/i,
  /\b(performance|optimize|optimise|memory leak|latency|bottleneck)\b/i,
  /\b(migrate|migration|schema change|breaking change)\b/i,
  /\b(implement|build|design) .*(feature|system|module|service)\b/i,
]

const FILE_GRUNT_THRESHOLD = 3
const WORD_GRUNT_THRESHOLD = 120

const EFFORT_BY_DIFFICULTY: Record<Difficulty, string | null> = {
  trivial: "low",
  easy: "low",
  medium: null,
  hard: "high",
}

export function defaultEffort(difficulty: Difficulty): string | null {
  return EFFORT_BY_DIFFICULTY[difficulty]
}

export function analyze(input: ClassifyInput): { difficulty: Difficulty; grunt: boolean } {
  const text = input.text
  const gruntPatternHit = GRUNT_PATTERNS.some((re) => re.test(text))
  const hardPatternHit = HARD_PATTERNS.some((re) => re.test(text))
  const heavyFiles = input.fileCount >= FILE_GRUNT_THRESHOLD
  const longPrompt = input.wordCount >= WORD_GRUNT_THRESHOLD

  const grunt = gruntPatternHit || heavyFiles

  let difficulty: Difficulty
  if (hardPatternHit) difficulty = "hard"
  else if (grunt) difficulty = "easy"
  else if (longPrompt) difficulty = "medium"
  else if (input.wordCount <= 10) difficulty = "trivial"
  else difficulty = "medium"

  return { difficulty, grunt }
}

export function decide(input: ClassifyInput, efforts: Partial<Record<Difficulty, string | null>>): Decision {
  const { difficulty, grunt } = analyze(input)
  const route: Route = grunt ? "small" : "main"
  const effort = efforts[difficulty] !== undefined ? efforts[difficulty]! : defaultEffort(difficulty)
  return { difficulty, route, effort }
}
