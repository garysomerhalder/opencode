import { createEffect, createSignal, onCleanup, onMount, Show, type Component } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useTabs } from "@/context/tabs"
import { describeLastInput } from "@/goal-loop/last-input"
import { openLoopSession } from "@/goal-loop/open-session"
import { get as getQueueStatus, subscribe as subscribeQueueStatus } from "@/goal-loop/queue-status"
import type { QueueStatusSnapshot } from "@/goal-loop/queue-status"
import type { GoalLoopStartInput, GoalLoopState } from "@/goal-loop/types"

type ActiveTicket = {
  identifier: string
  title: string
}

function queueActiveItem(snapshot: QueueStatusSnapshot | null): ActiveTicket | null {
  if (!snapshot || snapshot.items.length === 0) return null
  const active = snapshot.items.find((item) => item.status === "active")
  if (active) return { identifier: active.identifier, title: active.title }
  if (snapshot.index >= 0 && snapshot.index < snapshot.items.length) {
    const current = snapshot.items[snapshot.index]
    if (current) return { identifier: current.identifier, title: current.title }
  }
  const first = snapshot.items[0]
  if (first) return { identifier: first.identifier, title: first.title }
  return null
}

export const SidebarGoalLoop: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const command = useCommand()
  const navigate = useNavigate()
  const tabs = useTabs()

  const [loop, setLoop] = createSignal<GoalLoopState | null>(null)
  const [queue, setQueue] = createSignal<QueueStatusSnapshot | null>(getQueueStatus())
  const [last, setLast] = createSignal<GoalLoopStartInput | null>(null)

  onMount(() => {
    const unsubscribeQueue = subscribeQueueStatus((snapshot) => setQueue(snapshot))
    onCleanup(unsubscribeQueue)
    const api = platform.goalLoop
    if (!api) return
    void api
      .status()
      .then((current) => {
        if (current?.status === "running") setLoop(current)
      })
      .catch(() => undefined)
    const unsubscribe = api.subscribe((event) => setLoop(event.state.status === "running" ? event.state : null))
    onCleanup(unsubscribe)
  })

  const queueActive = () => {
    const snapshot = queue()
    return !!snapshot && !snapshot.done
  }
  const active = () => queueActive() || loop() !== null
  const lastView = () => describeLastInput(last())

  // Refresh the remembered input whenever the section is idle, so the idle
  // state reflects the most recent run. Smart-start itself always reads
  // last() fresh via the session.goalLoop command (see start()).
  createEffect(() => {
    if (active()) return
    void Promise.resolve()
      .then(() => platform.goalLoop?.last?.())
      .then((remembered) => {
        setLast(remembered ?? null)
      })
      .catch(() => undefined)
  })

  const ticket = (): ActiveTicket | null => {
    const running = loop()
    if (running?.ticket) return { identifier: running.ticket.identifier, title: running.ticket.title }
    return queueActiveItem(queue())
  }

  const position = () => {
    const snapshot = queue()
    if (!snapshot || snapshot.done || snapshot.items.length === 0) return null
    return { current: snapshot.index >= 0 ? snapshot.index + 1 : 1, total: snapshot.total }
  }

  const nextIdentifier = () => {
    const snapshot = queue()
    const next = snapshot && !snapshot.done ? snapshot.nextIdentifier : null
    return typeof next === "string" && next.trim().length > 0 ? next : null
  }

  const open = () => {
    const current = loop()
    openLoopSession({
      tabs: tabs as unknown as Parameters<typeof openLoopSession>[0]["tabs"],
      navigate,
      state: {
        sessionID: current?.sessionID ?? null,
        serverURL: current?.serverURL ?? null,
        directory: current?.directory ?? "",
      },
    })
  }

  // Smart-start: reuse the session.goalLoop command registered in app.tsx
  // (DesktopCommands.startGoalLoop) — it starts from last() when present and
  // opens the goal form otherwise. Triggering keeps that flow in one place
  // instead of duplicating it here.
  const start = () => {
    command.trigger("session.goalLoop")
  }

  // The wizard dialog is opened through its command (which dynamic-imports
  // the dialog like the other openers), so this file imports nothing from it.
  const openWizard = () => {
    command.trigger("session.goalWizard")
  }

  // Desktop-only surface: without platform.goalLoop every action below is a
  // no-op, so stay hidden on web exactly like the old hide-when-idle section.
  if (!platform.goalLoop) return null

  return (
    <div data-component="sidebar-goal-loop" class="flex shrink-0 flex-col gap-1 px-1 py-2">
      <div class="px-2 text-12-medium text-text-weak">{language.t("dialog.goalLoop.queue.header")}</div>
      <Show
        when={active()}
        fallback={
          <Show
            when={lastView()}
            fallback={
              <>
                <p class="px-2 text-12-regular text-text-weak">
                  {language.t("command.session.goalWizard.description")}
                </p>
                <button
                  type="button"
                  data-action="goal-loop-open-wizard"
                  onClick={openWizard}
                  class="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-12-medium text-text-strong hover:bg-surface-raised-base-hover"
                >
                  {language.t("dialog.goalWizard.title")}
                </button>
              </>
            }
          >
            {(view) => (
              <>
                <p class="truncate px-2 text-14-regular text-text-weak">
                  <Show when={view().strong} fallback={view().rest}>
                    <strong class="text-text-strong">{view().strong}</strong>
                    <Show when={view().rest}> {view().rest}</Show>
                  </Show>
                </p>
                <Show when={view().detail}>
                  <p class="truncate px-2 text-12-regular text-text-weak">{view().detail}</p>
                </Show>
                <button
                  type="button"
                  data-action="goal-loop-start"
                  onClick={start}
                  class="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-12-medium text-text-strong hover:bg-surface-raised-base-hover"
                >
                  {language.t("dialog.goalLoop.action.start")}
                </button>
              </>
            )}
          </Show>
        }
      >
        <Show when={ticket()}>
          {(item) => (
            <button
              type="button"
              data-action="goal-loop-open-session"
              onClick={open}
              class="flex w-full min-w-0 items-baseline gap-1.5 rounded-md px-2 py-1 text-left hover:bg-surface-raised-base-hover"
            >
              <strong class="shrink-0 text-14-medium text-text-strong">{item().identifier}</strong>
              <span class="min-w-0 flex-1 truncate text-14-regular text-text-weak">{item().title}</span>
            </button>
          )}
        </Show>
        <Show when={position()}>
          {(pos) => (
            <p class="px-2 text-12-regular text-text-weak">
              {language.t("dialog.goalLoop.queue.position", { current: pos().current, total: pos().total })}
            </p>
          )}
        </Show>
        <Show when={nextIdentifier()}>
          {(next) => (
            <p class="truncate px-2 text-12-regular text-text-weak">
              {language.t("dialog.goalLoop.queue.next", { identifier: next() })}
            </p>
          )}
        </Show>
        <Show when={loop()}>
          {(running) => (
            <p class="truncate px-2 text-12-regular text-text-weak">
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
          )}
        </Show>
      </Show>
    </div>
  )
}
