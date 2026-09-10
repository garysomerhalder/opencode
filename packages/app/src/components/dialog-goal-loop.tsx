import { Component, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { tabHref, useTabs } from "@/context/tabs"
import { showToast } from "@/utils/toast"
import type { GoalLoopStartInput, GoalLoopState } from "@/goal-loop/types"

function loopServerKey(serverURL: string | null): ServerConnection.Key {
  try {
    const host = new URL(serverURL ?? "").hostname
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
      return ServerConnection.Key.make("sidecar")
    }
    return ServerConnection.Key.make(serverURL ?? "sidecar")
  } catch {
    return ServerConnection.Key.make("sidecar")
  }
}

export const DialogGoalLoop: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const navigate = useNavigate()
  const location = useLocation()
  const tabs = useTabs()

  const [goal, setGoal] = createSignal("")
  const [directory, setDirectory] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [state, setState] = createSignal<GoalLoopState | null>(null)

  const goalLoop = () => platform.goalLoop

  onMount(() => {
    const api = goalLoop()
    if (!api) return
    void api
      .status()
      .then((current) => {
        if (current?.status === "running") setState(current)
      })
      .catch(() => undefined)
    if (goal().trim().length === 0) {
      void Promise.resolve()
        .then(() => platform.goalLoop?.last?.())
        .then((last: GoalLoopStartInput | null | undefined) => {
          if (!last) return
          if (goal().trim().length === 0 && last.goal) setGoal(last.goal)
          if (directory().trim().length === 0 && last.directory) setDirectory(last.directory)
        })
        .catch(() => undefined)
    }
    const unsubscribe = api.subscribe((event) => setState(event.state.status === "running" ? event.state : null))
    onCleanup(unsubscribe)
  })

  const start = async () => {
    const api = goalLoop()
    if (!api) return
    const text = goal().trim()
    const dir = directory().trim()
    if (!text || !dir) return
    setBusy(true)
    try {
      const next = await api.start({ directory: dir, goal: text })
      setState(next)
      showToast({ title: language.t("toast.goalLoop.started.title") })
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    const api = goalLoop()
    if (!api) return
    setBusy(true)
    try {
      await api.stop()
      setState(null)
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }

  const openSession = () => {
    const current = state()
    if (!current?.sessionID) return
    dialog.close()
    try {
      // Goal-loop sessions run on the server the main controller dials,
      // which in the desktop shell is always the local sidecar. Opening
      // through tabs.select is the same path a tab-strip click uses: it
      // marks the tab active AND navigates. A bare navigate leaves the
      // recent tab active and the view on the draft composer.
      const tab = tabs.addSessionTab({ server: loopServerKey(current.serverURL), sessionId: current.sessionID })
      console.info("[goal-loop] opening session", tabHref(tab), "from", location.pathname)
      tabs.select(tab)
    } catch (err) {
      console.error("[goal-loop] open session failed", err)
      navigate(`/${base64Encode(current.directory)}/session/${current.sessionID}`)
    }
  }

  const browse = async () => {
    if (platform.platform !== "desktop") return
    try {
      const picked = await platform.openDirectoryPickerDialog()
      if (typeof picked === "string" && picked.length > 0) setDirectory(picked)
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <Dialog title={language.t("dialog.goalLoop.title")}>
      <div class="flex flex-col gap-3 px-4 py-3">
        <Show
          when={state()}
          fallback={
            <>
              <TextField
                label={language.t("dialog.goalLoop.goal.label")}
                placeholder={language.t("dialog.goalLoop.goal.placeholder")}
                multiline
                autofocus
                value={goal()}
                onChange={setGoal}
              />
              <TextField
                label={language.t("dialog.goalLoop.directory.label")}
                placeholder={language.t("dialog.goalLoop.directory.placeholder")}
                value={directory()}
                onChange={setDirectory}
              />
              <div class="flex justify-end gap-2">
                <Button variant="secondary" onClick={browse}>
                  {language.t("dialog.goalLoop.action.browse")}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy() || goal().trim().length === 0 || directory().trim().length === 0}
                  onClick={start}
                >
                  {language.t("dialog.goalLoop.action.start")}
                </Button>
              </div>
            </>
          }
        >
          {(running) => (
            <>
              <p class="text-sm">
                <Show
                  when={running().maxIterations !== null}
                  fallback={language.t("dialog.goalLoop.running.unbounded", {
                    current: running().iteration,
                    directory: running().directory,
                  })}
                >
                  {language.t("dialog.goalLoop.running", {
                    current: running().iteration,
                    max: running().maxIterations ?? 0,
                    directory: running().directory,
                  })}
                </Show>
              </p>
              <p class="text-sm text-text-weak truncate">{running().goal}</p>
              <div class="flex justify-end gap-2">
                <Show when={running().sessionID}>
                  <Button variant="secondary" onClick={openSession}>
                    {language.t("dialog.goalLoop.action.openSession")}
                  </Button>
                </Show>
                <Button variant="primary" disabled={busy()} onClick={stop}>
                  {language.t("dialog.goalLoop.action.stop")}
                </Button>
              </div>
            </>
          )}
        </Show>
      </div>
    </Dialog>
  )
}
