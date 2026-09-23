import { activeBrand, feedbackHref } from "@/brand"

/**
 * The click handler for a feedback button, or `undefined` when the active brand has no feedback
 * destination; callers hide the button then. With the brand off it opens upstream's page as before.
 */
export function openFeedback(platform: { openExternal: (url: string) => void }) {
  const href = feedbackHref(activeBrand())
  if (!href) return undefined
  return () => platform.openExternal(href)
}
