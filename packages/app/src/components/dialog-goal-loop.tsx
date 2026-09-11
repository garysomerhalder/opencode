import { Component, createSignal, For, onCleanup, onMount, Show } from "solid-js"
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
import { get as getQueueStatus, subscribe as subscribeQueueStatus } from "@/goal-loop/queue-status"
import type { QueueStatusSnapshot } from "@/goal-loop/queue-status"
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

const QUEUE_VISIBLE_MAX = 8

type QueueItemStatus = "pending" | "active" | "done" | "failed"

type QueueItemView = {
  identifier: string
  title: string
  status: QueueItemStatus
}

type QueueView = {
  items: QueueItemView[]
  index: number
  total: number
  done: boolean
  ok: boolean
  reason?: string
  nextIdentifier?: string
}

function isQueueItemStatus(value: unknown): value is QueueItemStatus {
  return value === "pending" || value === "active" || value === "done" || value === "failed"
}

// The queue-status store is being enriched in parallel to
// { items: [{ identifier, title, status }], index, total, done, ok, reason, nextIdentifier }.
// Every new field is treated as optional so this view keeps working against the old shape.
function toQueueView(snapshot: QueueStatusSnapshot | null): QueueView | null {
  if (!snapshot) return null
  const raw = snapshot as QueueStatusSnapshot & {
    items?: Array<{ identifier?: unknown; title?: unknown; status?: unknown } | null>
    total?: unknown
    nextIdentifier?: unknown
    reason?: unknown
    index?: unknown
    done?: unknown
    ok?: unknown
  }
  if (!Array.isArray(raw.items) || raw.items.length === 0) return null
  const count = raw.items.length
  const total =
    typeof raw.total === "number" && Number.isFinite(raw.total) && raw.total > 0 ? Math.floor(raw.total) : count
  const requested = typeof raw.index === "number" && Number.isFinite(raw.index) ? Math.floor(raw.index) : 0
  const index = Math.min(Math.max(requested, 0), Math.max(count - 1, 0))
  const done = raw.done === true
  const ok = raw.ok !== false
  const reason = typeof raw.reason === "string" && raw.reason.trim().length > 0 ? raw.reason : undefined
  const items: QueueItemView[] = raw.items.map((entry, position) => {
    const record: Record<string, unknown> =
      typeof entry === "object" && entry !== null
        ? (entry as Record<string, unknown>)
        : {}
    const identifier =
      typeof record.identifier === "string" && record.identifier.length > 0
        ? record.identifier
        : `#${position + 1}`
    const title = typeof record.title === "string" ? record.title : ""
    if (isQueueItemStatus(record.status)) return { identifier, title, status: record.status }
    if (done) {
      if (!ok && position === index) return { identifier, title, status: "failed" }
      if (ok || position < index) return { identifier, title, status: "done" }
      return { identifier, title, status: "pending" }
    }
    if (position < index) return { identifier, title, status: "done" }
    if (position === index) return { identifier, title, status: "active" }
    return { identifier, title, status: "pending" }
  })
  const providedNext =
    typeof raw.nextIdentifier === "string" && raw.nextIdentifier.trim().length > 0
      ? raw.nextIdentifier.trim()
      : undefined
  const nextIdentifier = providedNext ?? (!done && index + 1 < items.length ? items[index + 1].identifier : undefined)
  return { items, index, total, done, ok, reason, nextIdentifier }
}

function queueStatusGlyph(status: QueueItemStatus): string {
  switch (status) {
    case "done":
      return "✓"
    case "active":
      return "…"
    case "failed":
      return "✕"
    case "pending":
    default:
      return "○"
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
  const [queue, setQueue] = createSignal<QueueStatusSnapshot | null>(getQueueStatus())
  const queueView = () => toQueueView(queue())

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
    const unsubscribeQueue = subscribeQueueStatus((snapshot) => setQueue(snapshot))
    onCleanup(unsubscribe)
    onCleanup(unsubscribeQueue)
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
              <Show when={running().ticket?.identifier}>
                <p class="text-sm truncate">
                  <strong>{running().ticket?.identifier}</strong>
                  <span class="text-text-weak"> {running().ticket?.title ?? ""}</span>
                </p>
              </Show>
              <Show when={queue() && !queue()?.done && (queue()?.items.length ?? 0) > 0}>
                <p class="text-xs text-text-weak">
                  {language.t("dialog.goalLoop.queue.position", {
                    current: (queue()?.index ?? 0) + 1,
                    total: queue()?.items.length ?? 0,
                  })}
                </p>
              </Show>
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
              <Show when={queueView()}>
                {(view) => (
                  <div class="flex flex-col gap-1">
                    <p class="text-xs font-medium text-text-weak">{language.t("dialog.goalLoop.queue.header")}</p>
                    <ul class="flex flex-col gap-0.5">
                      <For each={view().items.slice(0, QUEUE_VISIBLE_MAX)}>
                        {(item) => (
                          <li
                            class="flex items-baseline gap-1.5 text-xs truncate"
                            classList={{ "opacity-60": item.status === "pending" }}
                          >
                            <span aria-hidden="true" class="text-text-weak">
                              {queueStatusGlyph(item.status)}
                            </span>
                            <strong class="shrink-0">{item.identifier}</strong>
                            <span class="truncate text-text-weak">{item.title}</span>
                          </li>
                        )}
                      </For>
                    </ul>
                    <Show when={view().items.length > QUEUE_VISIBLE_MAX}>
                      <p class="text-xs text-text-weak">
                        {language.t("dialog.goalLoop.queue.more", {
                          count: view().items.length - QUEUE_VISIBLE_MAX,
                        })}
                      </p>
                    </Show>
                    <Show when={view().nextIdentifier}>
                      {(next) => (
                        <p class="text-xs text-text-weak">
                          {language.t("dialog.goalLoop.queue.next", { identifier: next() })}
                        </p>
                      )}
                    </Show>
                    <Show when={view().done}>
                      <p class="text-xs text-text-weak">
                        <Show
                          when={view().ok}
                          fallback={`${language.t("dialog.goalLoop.queue.halted")}${view().reason ? `: ${view().reason}` : ""}`}
                        >
                          {language.t("dialog.goalLoop.queue.doneAll")}
                        </Show>
                      </p>
                    </Show>
                  </div>
                )}
              </Show>
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
