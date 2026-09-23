import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { showToast } from "@/utils/toast"
import { serverStatusView, type ServerState } from "./view"

// A strip under the titlebar while the local server is restarting after a crash,
// or has stopped for good. Before this, a crashed server left the window looking
// normal and every request silently failing.

export function ServerStatusBanner() {
  const language = useLanguage()
  const platform = usePlatform()
  const [state, setState] = createSignal<ServerState | null>(null)
  const [now, setNow] = createSignal(Date.now())
  const [busy, setBusy] = createSignal(false)

  onMount(() => {
    const api = platform.server
    if (!api) return
    void api
      .state()
      .then((current) => setState(current))
      .catch(() => undefined)
    onCleanup(api.subscribe((next) => setState(next)))
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const view = createMemo(() => serverStatusView(state(), now()))

  const restart = async () => {
    const api = platform.server
    if (!api) return
    setBusy(true)
    try {
      await api.restart()
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

  return (
    <Show when={view()}>
      {(current) => (
        <div
          data-component="server-status-banner"
          data-tone={current().tone}
          role="status"
          class="flex w-full shrink-0 items-center gap-2 border-b px-3 py-1.5 text-12-medium text-text-strong"
          classList={{
            "border-border-warning-base bg-surface-warning-weak": current().tone === "warning",
            "border-border-critical-base bg-surface-critical-weak": current().tone === "error",
          }}
        >
          <Icon name="circle-x" size="small" class="shrink-0" />
          <span class="min-w-0 flex-1 truncate">
            {language.t(current().key, current().params as Record<string, string>)}
          </span>
          <Show when={current().canRestart}>
            <Button size="small" variant="secondary" disabled={busy()} onClick={() => void restart()}>
              {language.t("serverStatus.action.restart")}
            </Button>
          </Show>
        </div>
      )}
    </Show>
  )
}
