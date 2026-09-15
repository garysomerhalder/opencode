import { Component, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useTabs } from "@/context/tabs"
import { get as getQueueStatus, subscribe as subscribeQueueStatus } from "@/goal-loop/queue-status"
import type { QueueStatusSnapshot } from "@/goal-loop/queue-status"
import { openLoopSession } from "@/goal-loop/open-session"
import { showToast } from "@/utils/toast"
import type { GoalLoopStartInput, GoalLoopState } from "@/goal-loop/types"

const VISIBLE_MAX = 8

function glyph(status: string): string {
  switch (status) {
    case "done":
      return "✓"
    case "active":
      return "…"
    case "failed":
      return "✕"
    default:
      return "○"
  }
}

export const DialogGoalManager: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const navigate = useNavigate()
  const tabs = useTabs()

  const [tab, setTab] = createSignal<"active" | "new">("active")
  const [loop, setLoop] = createSignal<GoalLoopState | null>(null)
  const [queue, setQueue] = createSignal<QueueStatusSnapshot | null>(getQueueStatus())
  const [goal, setGoal] = createSignal("")
  const [directory, setDirectory] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const api = () => platform.goalLoop
  const snapshot = () => queue()
  const hasQueue = () => {
    const current = snapshot()
    return !!current && current.items.length > 0 && !current.done
  }

  onMount(() => {
    const current = api()
    if (!current) return
    void current
      .status()
      .then((state) => {
        if (state?.status === "running") {
          setLoop(state)
          setTab("active")
        } else {
          setTab("new")
        }
      })
      .catch(() => undefined)
    void Promise.resolve()
      .then(() => current.last?.())
      .then((last: GoalLoopStartInput | null | undefined) => {
        if (!last) return
        if (goal().trim().length === 0 && last.goal) setGoal(last.goal)
        if (directory().trim().length === 0 && last.directory) setDirectory(last.directory)
      })
      .catch(() => undefined)
    const unsubscribe = current.subscribe((event) =>
      setLoop(event.state.status === "running" ? event.state : null),
    )
    const unsubscribeQueue = subscribeQueueStatus((next) => setQueue(next))
    onCleanup(unsubscribe)
    onCleanup(unsubscribeQueue)
  })

  const start = async () => {
    const current = api()
    if (!current) return
    const text = goal().trim()
    const dir = directory().trim()
    if (!text || !dir) return
    setBusy(true)
    try {
      const next = await current.start({ directory: dir, goal: text })
      setLoop(next)
      setTab("active")
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
    const current = api()
    if (!current) return
    setBusy(true)
    try {
      await current.stop()
      setLoop(null)
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
    const current = loop()
    if (!current?.sessionID) return
    dialog.close()
    openLoopSession({
      tabs: tabs as unknown as Parameters<typeof openLoopSession>[0]["tabs"],
      navigate,
      state: { sessionID: current.sessionID, serverURL: current.serverURL, directory: current.directory },
    })
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

  const openTicket = () => {
    void import("@/components/dialog-goal-ticket").then((x) => {
      dialog.show(() => <x.DialogGoalTicket />)
    })
  }

  const openWizard = () => {
    void import("@/components/dialog-goal-wizard").then((x) => {
      dialog.show(() => <x.DialogGoalWizard />)
    })
  }

  const running = () => loop()

  return (
    <Dialog title={language.t("dialog.goalLoop.queue.header")}>
      <div class="flex flex-col gap-3 px-4 py-3">
        <div class="flex gap-2">
          <Button variant={tab() === "active" ? "primary" : "secondary"} onClick={() => setTab("active")}>
            {language.t("dialog.goalLoop.queue.header")}
          </Button>
          <Button variant={tab() === "new" ? "primary" : "secondary"} onClick={() => setTab("new")}>
            {language.t("dialog.goalLoop.title")}
          </Button>
        </div>
        <Show when={tab() === "active"}>
          <Show
            when={running() ?? (hasQueue() ? ({} as GoalLoopState) : null)}
            fallback={
              <div class="flex flex-col gap-2">
                <p class="text-sm text-text-weak">{language.t("dialog.goalLoop.goal.placeholder")}</p>
                <div class="flex justify-end">
                  <Button variant="primary" onClick={() => setTab("new")}>
                    {language.t("dialog.goalLoop.title")}
                  </Button>
                </div>
              </div>
            }
          >
            <Show when={running()}>
              {(active) => (
                <div class="flex flex-col gap-2">
                  <Show when={active().ticket?.identifier}>
                    <p class="truncate text-sm">
                      <strong>{active().ticket?.identifier}</strong>
                      <span class="text-text-weak"> {active().ticket?.title ?? ""}</span>
                    </p>
                  </Show>
                  <p class="text-sm">
                    <Show
                      when={active().maxIterations !== null}
                      fallback={language.t("dialog.goalLoop.running.unbounded", {
                        current: active().iteration,
                        directory: active().directory,
                      })}
                    >
                      {language.t("dialog.goalLoop.running", {
                        current: active().iteration,
                        max: active().maxIterations ?? 0,
                        directory: active().directory,
                      })}
                    </Show>
                  </p>
                  <p class="truncate text-sm text-text-weak">{active().goal}</p>
                </div>
              )}
            </Show>
            <Show when={snapshot() && snapshot()!.items.length > 0}>
              <div class="flex flex-col gap-1">
                <Show when={!snapshot()!.done}>
                  <p class="text-xs text-text-weak">
                    {language.t("dialog.goalLoop.queue.position", {
                      current: (snapshot()!.index >= 0 ? snapshot()!.index : 0) + 1,
                      total: snapshot()!.total,
                    })}
                  </p>
                </Show>
                <ul class="flex flex-col gap-0.5">
                  <For each={snapshot()!.items.slice(0, VISIBLE_MAX)}>
                    {(item) => (
                      <li
                        class="flex items-baseline gap-1.5 truncate text-xs"
                        classList={{ "opacity-60": item.status === "pending" }}
                      >
                        <span aria-hidden="true" class="text-text-weak">
                          {glyph(item.status)}
                        </span>
                        <strong class="shrink-0">{item.identifier}</strong>
                        <span class="truncate text-text-weak">{item.title}</span>
                      </li>
                    )}
                  </For>
                </ul>
                <Show when={snapshot()!.items.length > VISIBLE_MAX}>
                  <p class="text-xs text-text-weak">
                    {language.t("dialog.goalLoop.queue.more", { count: snapshot()!.items.length - VISIBLE_MAX })}
                  </p>
                </Show>
                <Show when={snapshot()!.nextIdentifier}>
                  <p class="text-xs text-text-weak">
                    {language.t("dialog.goalLoop.queue.next", { identifier: snapshot()!.nextIdentifier ?? "" })}
                  </p>
                </Show>
                <Show when={snapshot()!.done}>
                  <p class="text-xs text-text-weak">
                    <Show
                      when={snapshot()!.ok}
                      fallback={`${language.t("dialog.goalLoop.queue.halted")}${snapshot()!.reason ? `: ${snapshot()!.reason}` : ""}`}
                    >
                      {language.t("dialog.goalLoop.queue.doneAll")}
                    </Show>
                  </p>
                </Show>
              </div>
            </Show>
            <div class="flex justify-end gap-2">
              <Show when={running()?.sessionID}>
                <Button variant="secondary" onClick={openSession}>
                  {language.t("dialog.goalLoop.action.openSession")}
                </Button>
              </Show>
              <Show when={running()}>
                <Button variant="primary" disabled={busy()} onClick={() => void stop()}>
                  {language.t("prompt.action.stop")}
                </Button>
              </Show>
            </div>
          </Show>
        </Show>
        <Show when={tab() === "new"}>
          <div class="flex flex-col gap-3">
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
              <Button variant="secondary" onClick={() => void browse()}>
                {language.t("dialog.goalLoop.action.browse")}
              </Button>
              <Button
                variant="primary"
                disabled={busy() || goal().trim().length === 0 || directory().trim().length === 0}
                onClick={() => void start()}
              >
                {language.t("dialog.goalLoop.action.start")}
              </Button>
            </div>
            <div class="flex flex-col gap-2 border-t border-border-weaker-base pt-3">
              <Button variant="secondary" onClick={openTicket}>
                {language.t("dialog.goalTicket.title")}
              </Button>
              <Button variant="secondary" onClick={openWizard}>
                {language.t("dialog.goalWizard.title")}
              </Button>
            </div>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
