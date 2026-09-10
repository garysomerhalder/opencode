import { onCleanup, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { showToast } from "@/utils/toast"
import type { GoalLoopEvent } from "./types"

const notifiedLoops = new Set<string>()

function terminalToast(language: ReturnType<typeof useLanguage>, event: GoalLoopEvent) {
  const state = event.state
  switch (event.type) {
    case "completed":
      showToast({
        title: language.t("toast.goalLoop.completed.title"),
        description: language.t("toast.goalLoop.completed.description", { count: state.iteration }),
      })
      return
    case "capped":
      showToast({
        variant: "error",
        title: language.t("toast.goalLoop.capped.title"),
        description: language.t("toast.goalLoop.capped.description", { count: state.maxIterations ?? 0 }),
      })
      return
    case "failed":
      showToast({
        variant: "error",
        title: language.t("toast.goalLoop.failed.title"),
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
      return language.t("toast.goalLoop.completed.title")
    case "capped":
    case "stopped":
      return language.t("toast.goalLoop.capped.title")
    default:
      return language.t("toast.goalLoop.failed.title")
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
