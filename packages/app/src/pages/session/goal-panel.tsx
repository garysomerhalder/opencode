import { createMemo, createSignal, onCleanup, onMount, Show, type Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tag } from "@opencode-ai/ui/tag"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useGoalLoops } from "@/goal-loop/loops-store"
import { ago, goalPanelView, type GoalPanelTone } from "@/goal-loop/panel-view"
import { showToast } from "@/utils/toast"

// The goal loop of the page's own session. It replaces the strip that showed
// whichever loop the app last ran, on every session's page.

const TONE: Record<GoalPanelTone, string> = {
  info: "border-border-info-base bg-surface-info-weak text-text-strong",
  success: "border-border-success-base bg-surface-success-weak text-text-strong",
  error: "border-border-critical-base bg-surface-critical-weak text-text-strong",
  warning: "border-border-warning-base bg-surface-warning-weak text-text-strong",
  neutral: "",
}

function useNow(everyMs: number) {
  const [now, setNow] = createSignal(Date.now())
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    onCleanup(() => clearInterval(timer))
  })
  return now
}

export const GoalPanel: Component<{ sessionID: string | undefined; title?: string; directory?: string }> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const loops = useGoalLoops()
  const now = useNow(1000)
  const [busy, setBusy] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)

  const view = createMemo(() =>
    goalPanelView({ states: loops?.states() ?? [], sessionID: props.sessionID, now: now() }),
  )
  const loop = createMemo(() => {
    const current = view()
    return current.kind === "loop" ? current : undefined
  })

  const openManager = () => {
    void import("@/components/dialog-goal-manager").then((x) => {
      dialog.show(() => <x.DialogGoalManager sessionID={props.sessionID} directory={props.directory} />)
    })
  }

  const stop = async () => {
    const api = platform.goalLoop
    if (!api || !props.sessionID) return
    setBusy(true)
    try {
      await api.stop(props.sessionID)
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

  // Desktop only, and only on a real session (a new-session page has none to bind to).
  if (!loops) return null

  return (
    <Show when={props.sessionID}>
      <div
        data-component="goal-panel"
        class="flex w-full min-w-0 shrink-0 flex-col gap-1 border-b border-border-weaker-base px-3 py-2"
      >
        <Show
          when={loop()}
          fallback={
            <div class="flex min-w-0 items-center gap-2">
              <Icon name="status" size="small" class="shrink-0 text-icon-weak" />
              <span class="min-w-0 flex-1 truncate text-12-regular text-text-weak">{language.t("goalPanel.idle")}</span>
              <Button size="small" variant="secondary" data-action="goal-panel-start" onClick={openManager}>
                {language.t("goalPanel.action.start")}
              </Button>
            </div>
          }
        >
          {(current) => (
            <>
              <div class="flex min-w-0 items-center gap-2">
                <Show
                  when={current().running}
                  fallback={<Icon name="status" size="small" class="shrink-0 text-icon-weak" />}
                >
                  <Spinner class="size-3 shrink-0" />
                </Show>
                <span class="min-w-0 flex-1 truncate text-12-medium text-text-strong">
                  {language.t("goalPanel.header", { title: props.title || props.sessionID || "" })}
                </span>
                <Tooltip value={current().reason ?? ""} placement="bottom" inactive={!current().reason}>
                  <Tag data-slot="goal-panel-state" class={TONE[current().tone]}>
                    {language.t(current().label as Parameters<typeof language.t>[0])}
                  </Tag>
                </Tooltip>
                <Show
                  when={current().running}
                  fallback={
                    <Button
                      size="small"
                      variant="ghost"
                      data-action="goal-panel-dismiss"
                      onClick={() => props.sessionID && loops.dismiss(props.sessionID)}
                    >
                      {language.t("goalPanel.action.dismiss")}
                    </Button>
                  }
                >
                  <Button
                    size="small"
                    variant="secondary"
                    data-action="goal-panel-stop"
                    disabled={busy()}
                    onClick={() => void stop()}
                  >
                    {language.t("goalPanel.action.stop")}
                  </Button>
                </Show>
              </div>
              <Show when={current().state.ticket}>
                {(ticket) => (
                  <p class="min-w-0 truncate text-12-regular">
                    <strong class="text-text-strong">{ticket().identifier}</strong>
                    <span class="text-text-weak"> {ticket().title}</span>
                  </p>
                )}
              </Show>
              <p
                data-slot="goal-panel-goal"
                class="min-w-0 whitespace-pre-wrap break-words text-12-regular text-text-base"
                classList={{ "line-clamp-2": !expanded() }}
              >
                {current().goal}
              </p>
              <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-12-regular text-text-weak">
                <button
                  type="button"
                  data-action="goal-panel-expand"
                  class="text-text-interactive-base hover:underline"
                  onClick={() => setExpanded((value) => !value)}
                >
                  {expanded() ? language.t("goalPanel.action.less") : language.t("goalPanel.action.more")}
                </button>
                <span>
                  {current().iteration.max === null
                    ? language.t("goalPanel.iteration.unbounded", { current: current().iteration.current })
                    : language.t("goalPanel.iteration", {
                        current: current().iteration.current,
                        max: current().iteration.max ?? 0,
                      })}
                </span>
                <Show when={ago(current().checkedAgo)}>
                  {(value) => <span>{language.t("goalPanel.checked", { ago: value() })}</span>}
                </Show>
                <Show when={ago(current().promptedAgo)}>
                  {(value) => <span>{language.t("goalPanel.prompted", { ago: value() })}</span>}
                </Show>
                <Show when={!current().running && current().reason}>
                  {(reason) => <span class="min-w-0 truncate">{reason()}</span>}
                </Show>
                <Tooltip value={current().state.directory} placement="bottom">
                  <span class="min-w-0 max-w-64 truncate font-mono">{current().state.directory}</span>
                </Tooltip>
              </div>
            </>
          )}
        </Show>
      </div>
    </Show>
  )
}
