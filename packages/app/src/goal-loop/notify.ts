import { onCleanup, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { showToast } from "@/utils/toast"
import type { GoalLoopEvent } from "./types"

const notifiedLoops = new Set<string>()

function ticketIdentifier(state: GoalLoopEvent["state"]): string | null {
  const ticket = (state as { ticket?: { identifier?: string } | null } | null | undefined)?.ticket
  const identifier = typeof ticket?.identifier === "string" ? ticket.identifier.trim() : ""
  return identifier.length > 0 ? identifier : null
}

function withTicket(base: string, state: GoalLoopEvent["state"]): string {
  const identifier = ticketIdentifier(state)
  return identifier ? `${identifier}: ${base}` : base
}

function terminalToast(language: ReturnType<typeof useLanguage>, event: GoalLoopEvent) {
  const state = event.state
  switch (event.type) {
    case "completed":
      showToast({
        title: withTicket(language.t("toast.goalLoop.completed.title"), state),
        description: language.t("toast.goalLoop.completed.description", { count: state.iteration }),
      })
      return
    case "capped":
      showToast({
        variant: "error",
        title: withTicket(language.t("toast.goalLoop.capped.title"), state),
        description: language.t("toast.goalLoop.capped.description", { count: state.maxIterations ?? 0 }),
      })
      return
    case "failed":
      showToast({
        variant: "error",
        title: withTicket(language.t("toast.goalLoop.failed.title"), state),
        description: state.reason ?? undefined,
      })
      return
    case "stopped":
      showToast({ title: language.t("toast.goalLoop.stopped.title") })
      return
    default:
      return
  }
}

function terminalTitle(language: ReturnType<typeof useLanguage>, event: GoalLoopEvent): string {
  switch (event.type) {
    case "completed":
      return withTicket(language.t("toast.goalLoop.completed.title"), event.state)
    case "capped":
    case "stopped":
      return withTicket(language.t("toast.goalLoop.capped.title"), event.state)
    default:
      return withTicket(language.t("toast.goalLoop.failed.title"), event.state)
  }
}

function terminalBody(language: ReturnType<typeof useLanguage>, event: GoalLoopEvent): string | undefined {
  switch (event.type) {
    case "completed":
      return language.t("toast.goalLoop.completed.description", { count: event.state.iteration })
    case "capped":
      return language.t("toast.goalLoop.capped.description", { count: event.state.maxIterations ?? 0 })
    case "failed":
      return event.state.reason ?? undefined
    default:
      return undefined
  }
}

export function useGoalLoopNotifications() {
  const language = useLanguage()
  const platform = usePlatform()
  onMount(() => {
    const goalLoop = platform.goalLoop
    if (!goalLoop) return
    const unsubscribe = goalLoop.subscribe((event) => {
      if (event.type === "started" || event.type === "iteration") return
      if (notifiedLoops.has(event.loopID)) return
      notifiedLoops.add(event.loopID)
      terminalToast(language, event)
      void platform
        .notify(terminalTitle(language, event), terminalBody(language, event))
        .catch(() => undefined)
    })
    onCleanup(unsubscribe)
  })
}
