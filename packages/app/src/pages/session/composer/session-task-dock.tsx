import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { duration, taskRowView, visibleTasks } from "./session-task-dock-view"

// The session's background shell tasks: what keeps running after a command
// yielded, how long it has run, its last line, whether the agent will be told
// when it ends, and a stop button. Without this, a task someone escaped out of
// kept running with nothing on screen, which is why background shell shipped off.

export function SessionTaskDock(props: { sessionID: string | undefined }) {
  const language = useLanguage()
  const serverSync = useServerSync()
  const [now, setNow] = createSignal(Date.now())
  const [stopping, setStopping] = createSignal<string | undefined>()

  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(
    on(
      () => props.sessionID,
      (id) => {
        if (id) void serverSync().session.shellTasks(id)
      },
    ),
  )

  const tasks = createMemo(() => {
    const id = props.sessionID
    if (!id) return []
    return visibleTasks(serverSync().session.data.shell_task[id] ?? [], now())
  })
  const running = createMemo(() => tasks().filter((task) => task.status === "running").length)

  const stop = async (taskID: string) => {
    const id = props.sessionID
    if (!id) return
    setStopping(taskID)
    try {
      await serverSync().session.stopShellTask(id, taskID)
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setStopping(undefined)
    }
  }

  const t = (key: string, params?: Record<string, string | number>) =>
    language.t(key as Parameters<typeof language.t>[0], params)

  return (
    <Show when={tasks().length > 0}>
      <div
        data-component="session-task-dock"
        class="mb-2 w-full overflow-hidden rounded-md border border-border-weak-base bg-background-base"
      >
        <div class="flex items-center gap-2 px-3 py-1.5 text-12-medium text-text-strong">
          <Icon name="status" size="small" class="shrink-0 text-icon-weak" />
          <span class="min-w-0 flex-1 truncate">{t("taskDock.header", { count: running() })}</span>
        </div>
        <ul class="flex flex-col">
          <For each={tasks()}>
            {(task) => {
              const row = createMemo(() => taskRowView(task, now()))
              return (
                <li
                  data-slot="session-task-row"
                  data-status={task.status}
                  class="flex min-w-0 items-center gap-2 border-t border-border-weaker-base px-3 py-1.5 text-12-regular"
                >
                  <Show
                    when={row().running}
                    fallback={
                      <Icon
                        name={task.status === "exited" && task.exitCode === 0 ? "check-small" : "circle-x"}
                        size="small"
                        class="shrink-0"
                        classList={{
                          "text-icon-success-base": task.status === "exited" && task.exitCode === 0,
                          "text-icon-critical-base": !(task.status === "exited" && task.exitCode === 0),
                        }}
                      />
                    }
                  >
                    <Spinner class="size-3 shrink-0" />
                  </Show>
                  <Tooltip value={task.command} placement="top" class="min-w-0 max-w-[40%]">
                    <span class="block truncate font-mono text-text-strong">{task.command}</span>
                  </Tooltip>
                  <span class="shrink-0 tabular-nums text-text-weak">{duration(row().elapsedMs)}</span>
                  <span class="shrink-0 text-text-weak">{t(row().status, { code: task.exitCode ?? "" })}</span>
                  <Show when={row().wake}>{(key) => <span class="shrink-0 text-text-weak">{t(key())}</span>}</Show>
                  <span class="min-w-0 flex-1 truncate font-mono text-text-weak">{row().tail ?? ""}</span>
                  <Show when={row().canStop}>
                    <Tooltip value={t("taskDock.action.stop")} placement="top">
                      <IconButton
                        icon="circle-ban-sign"
                        variant="ghost"
                        class="size-6 shrink-0 rounded-md"
                        data-action="session-task-stop"
                        aria-label={t("taskDock.action.stop")}
                        disabled={stopping() === task.id}
                        onClick={() => void stop(task.id)}
                      />
                    </Tooltip>
                  </Show>
                </li>
              )
            }}
          </For>
        </ul>
      </div>
    </Show>
  )
}
