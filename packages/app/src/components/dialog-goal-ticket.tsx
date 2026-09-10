import { Component, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { showToast } from "@/utils/toast"
import { buildTicketGoal, type TicketIssue } from "@/goal-loop/ticket"
import type { GoalLoopStartInput } from "@/goal-loop/types"

export const DialogGoalTicket: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()

  const [tickets, setTickets] = createSignal<TicketIssue[]>([])
  const [search, setSearch] = createSignal("")
  const [directory, setDirectory] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [loading, setLoading] = createSignal(true)

  const ticketsApi = () => platform.linearTickets

  onMount(() => {
    const api = ticketsApi()
    if (!api) {
      setLoading(false)
      return
    }
    void api
      .assigned({ first: 30 })
      .then((issues) => setTickets(issues))
      .catch((err) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => setLoading(false))
    void Promise.resolve()
      .then(() => platform.goalLoop?.last?.())
      .then((last: GoalLoopStartInput | null | undefined) => {
        if (!last) return
        if (directory().trim().length === 0 && last.directory) setDirectory(last.directory)
      })
      .catch(() => undefined)
  })

  const filtered = createMemo(() => {
    const query = search().trim().toLowerCase()
    const all = tickets()
    if (!query) return all
    return all.filter(
      (issue) =>
        issue.identifier.toLowerCase().includes(query) || issue.title.toLowerCase().includes(query),
    )
  })

  const startTicket = async (issue: TicketIssue) => {
    const api = platform.goalLoop
    if (!api) return
    const dir = directory().trim()
    if (!dir) return
    setBusy(true)
    try {
      const goal = buildTicketGoal(issue, dir)
      await api.start({ directory: dir, goal })
      showToast({ title: language.t("toast.goalLoop.started.title") })
      dialog.close()
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
    <Dialog title={language.t("dialog.goalTicket.title")}>
      <div class="flex flex-col gap-3 px-4 py-3">
        <Show when={ticketsApi()} fallback={<p class="text-sm">{language.t("dialog.goalTicket.unavailable")}</p>}>
          <TextField
            label={language.t("dialog.goalLoop.directory.label")}
            placeholder={language.t("dialog.goalLoop.directory.placeholder")}
            value={directory()}
            onChange={setDirectory}
          />
          <div class="flex justify-end">
            <Button variant="secondary" onClick={browse}>
              {language.t("dialog.goalLoop.action.browse")}
            </Button>
          </div>
          <TextField
            placeholder={language.t("dialog.goalTicket.searchPlaceholder")}
            autofocus
            value={search()}
            onChange={setSearch}
          />
          <Show when={!loading()} fallback={<p class="text-sm">{language.t("common.loading")}</p>}>
            <Show
              when={filtered().length > 0}
              fallback={<p class="text-sm">{language.t("dialog.goalTicket.empty")}</p>}
            >
              <div class="flex max-h-80 flex-col gap-2 overflow-y-auto">
                <For each={filtered()}>
                  {(issue) => (
                    <div class="flex items-center gap-3 rounded-md border border-border-base px-3 py-2">
                      <div class="min-w-0 flex-1">
                        <p class="truncate text-sm font-medium">
                          {issue.identifier}: {issue.title}
                        </p>
                        <p class="truncate text-xs text-text-weak">
                          {issue.state?.name ?? ""} P{issue.priority ?? "?"}
                        </p>
                      </div>
                      <Button
                        variant="primary"
                        disabled={busy() || directory().trim().length === 0}
                        onClick={() => void startTicket(issue)}
                      >
                        {language.t("dialog.goalTicket.start")}
                      </Button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </Dialog>
  )
}
