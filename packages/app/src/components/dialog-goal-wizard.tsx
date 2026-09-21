import { Component, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { TextField } from "@opencode-ai/ui/text-field"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { showToast } from "@/utils/toast"
import { createQueueRunner } from "@/goal-loop/queue"
import { advance, clear as clearQueueStatus, halt, setQueue } from "@/goal-loop/queue-status"
import type { TicketIssue } from "@/goal-loop/ticket"
import type { GoalLoopStartInput } from "@/goal-loop/types"

type Team = { id: string; key: string; name: string }
type TeamOption = { id: string; key?: string; name: string }

const MINE_OPTION_ID = "__mine"

let activeQueue: { stop(): void } | null = null

export const DialogGoalWizard: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()

  const [step, setStep] = createSignal(0)
  const [teams, setTeams] = createSignal<Team[]>([])
  const [teamsLoading, setTeamsLoading] = createSignal(true)
  const [teamKey, setTeamKey] = createSignal<string | undefined>(undefined)
  const [tickets, setTickets] = createSignal<TicketIssue[]>([])
  const [ticketsLoading, setTicketsLoading] = createSignal(true)
  const [selected, setSelected] = createSignal<string[]>([])
  const [instructions, setInstructions] = createSignal("")
  const [directory, setDirectory] = createSignal("")
  const [queueActive, setQueueActive] = createSignal(activeQueue !== null)

  const ticketsApi = () => platform.linearTickets
  const goalApi = () => platform.goalLoop
  const available = () => Boolean(ticketsApi() ?? goalApi())

  const teamOptions = createMemo<TeamOption[]>(() => [
    { id: MINE_OPTION_ID, name: language.t("dialog.goalWizard.team.mine") },
    ...teams().map((team) => ({ id: team.id, key: team.key, name: team.name })),
  ])

  const selectedTeamID = createMemo(() => {
    const key = teamKey()
    if (!key) return MINE_OPTION_ID
    return teams().find((team) => team.key === key)?.id ?? MINE_OPTION_ID
  })

  const teamName = createMemo(() => {
    const key = teamKey()
    if (!key) return language.t("dialog.goalWizard.team.mine")
    return teams().find((team) => team.key === key)?.name ?? key
  })

  const chosen = createMemo(() => {
    const ids = new Set(selected())
    return tickets().filter((issue) => ids.has(issue.id))
  })

  const stepTitle = createMemo(() => {
    switch (step()) {
      case 0:
        return language.t("dialog.goalWizard.step1")
      case 1:
        return language.t("dialog.goalWizard.step2")
      case 2:
        return language.t("dialog.goalWizard.step3")
      default:
        return language.t("dialog.goalWizard.step4")
    }
  })

  const canStart = createMemo(() => Boolean(goalApi()) && chosen().length > 0 && directory().trim().length > 0)

  const loadTeams = async () => {
    setTeamsLoading(true)
    try {
      const api = ticketsApi() as unknown as { teams?: () => Promise<Team[]> } | undefined
      if (api && typeof api.teams === "function") {
        const list = await api.teams()
        setTeams(Array.isArray(list) ? list : [])
      } else {
        setTeams([])
      }
    } catch {
      setTeams([])
    } finally {
      setTeamsLoading(false)
    }
  }

  const loadTickets = async (key: string | undefined) => {
    const api = ticketsApi()
    if (!api) {
      setTickets([])
      setSelected([])
      setTicketsLoading(false)
      return
    }
    setTicketsLoading(true)
    try {
      const issues = await api.assigned({ teamKey: key, first: 50 })
      setTickets(issues)
      setSelected(issues.map((issue) => issue.id))
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
      setTickets([])
      setSelected([])
    } finally {
      setTicketsLoading(false)
    }
  }

  onMount(() => {
    setQueueActive(activeQueue !== null)
    void loadTeams()
    void loadTickets(teamKey())
    void Promise.resolve()
      .then(() => platform.goalLoop?.last?.())
      .then((last: GoalLoopStartInput | null | undefined) => {
        if (!last) return
        if (directory().trim().length === 0 && last.directory) setDirectory(last.directory)
      })
      .catch(() => undefined)
  })

  const selectTeam = (option: TeamOption | undefined) => {
    if (!option) return
    const key = option.id === MINE_OPTION_ID ? undefined : option.key
    setTeamKey(key)
    void loadTickets(key)
  }

  const toggle = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id]))
  }

  const selectAll = () => setSelected(tickets().map((issue) => issue.id))
  const clear = () => setSelected([])

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

  const stopQueue = () => {
    try {
      activeQueue?.stop()
    } catch {
      // Stopping a finished queue is a no-op.
    }
    activeQueue = null
    setQueueActive(false)
    clearQueueStatus()
  }

  const startQueue = () => {
    const api = goalApi()
    if (!api) return
    const queueTickets = chosen()
    const dir = directory().trim()
    if (queueTickets.length === 0 || !dir) return
    const extra = instructions()
    const total = queueTickets.length
    try {
      const runner = createQueueRunner({
        start: (input) => api.start(input).then((state) => ({ id: state.id, sessionID: state.sessionID })),
        subscribe: (cb) => api.subscribe((event) => cb(event)),
        stop: (sessionID) => api.stop(sessionID),
      })
      let unsubscribe: () => void = () => undefined
      const handle = {
        stop: () => {
          try {
            runner.stop()
          } finally {
            unsubscribe()
          }
        },
      }
      unsubscribe = runner.onProgress((progress) => {
        if (progress.phase === "completed" && !progress.done) {
          advance(progress.ticketIdentifier)
          return
        }
        if (progress.phase === "completed" && progress.done) {
          advance(progress.ticketIdentifier)
          showToast({
            title: language.t("toast.goalQueue.completed.title"),
            description: language.t("toast.goalQueue.completed.description", { count: total }),
          })
          unsubscribe()
          if (activeQueue === handle) {
            activeQueue = null
            setQueueActive(false)
          }
        } else if (progress.phase === "halted") {
          halt(progress.reason ?? undefined)
          showToast({
            variant: "error",
            title: language.t("toast.goalQueue.halted.title"),
            description: progress.reason ?? undefined,
          })
          unsubscribe()
          if (activeQueue === handle) {
            activeQueue = null
            setQueueActive(false)
          }
        }
      })
      activeQueue = handle
      setQueueActive(true)
      setQueue(queueTickets.map((ticket) => ({ identifier: ticket.identifier, title: ticket.title })))
      runner.start(queueTickets.map((ticket) => ({ ticket, directory: dir, instructions: extra })))
      showToast({
        title: language.t("toast.goalQueue.started.title"),
        description: language.t("toast.goalQueue.started.description", { count: total }),
      })
      dialog.close()
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <Dialog title={language.t("dialog.goalWizard.title")}>
      <div class="flex flex-col gap-3 px-4 py-3">
        <Show when={available()} fallback={<p class="text-sm">{language.t("dialog.goalWizard.unavailable")}</p>}>
          <p class="text-xs text-text-weak">
            {step() + 1} / 4 · {stepTitle()}
          </p>
          <Show when={step() === 0}>
            <p class="text-sm font-medium">{language.t("dialog.goalWizard.team.title")}</p>
            <Show when={!teamsLoading()} fallback={<p class="text-sm">{language.t("common.loading")}</p>}>
              <Show
                when={teamOptions().length > 0}
                fallback={<p class="text-sm">{language.t("dialog.goalWizard.team.empty")}</p>}
              >
                <List
                  class="max-h-80"
                  key={(option) => option.id}
                  items={teamOptions()}
                  filterKeys={["name"]}
                  current={teamOptions().find((option) => option.id === selectedTeamID())}
                  onSelect={selectTeam}
                  emptyMessage={language.t("dialog.goalWizard.team.empty")}
                >
                  {(option) => (
                    <div class="w-full flex items-center gap-2">
                      <span class="truncate flex-1 min-w-0 text-left font-normal">{option.name}</span>
                    </div>
                  )}
                </List>
              </Show>
            </Show>
          </Show>
          <Show when={step() === 1}>
            <div class="flex items-center justify-between gap-2">
              <p class="text-sm font-medium">{language.t("dialog.goalWizard.tickets.title")}</p>
              <div class="flex gap-2">
                <Button variant="secondary" onClick={selectAll}>
                  {language.t("dialog.goalWizard.tickets.selectAll")}
                </Button>
                <Button variant="secondary" onClick={clear}>
                  {language.t("dialog.goalWizard.tickets.clear")}
                </Button>
              </div>
            </div>
            <Show when={!ticketsLoading()} fallback={<p class="text-sm">{language.t("common.loading")}</p>}>
              <Show
                when={tickets().length > 0}
                fallback={<p class="text-sm">{language.t("dialog.goalWizard.tickets.empty")}</p>}
              >
                <div class="flex max-h-80 flex-col gap-2 overflow-y-auto">
                  <For each={tickets()}>
                    {(issue) => (
                      <label class="flex cursor-pointer items-center gap-3 rounded-md border border-border-base px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selected().includes(issue.id)}
                          onChange={() => toggle(issue.id)}
                        />
                        <span class="min-w-0 flex-1">
                          <span class="block truncate text-sm font-medium">
                            {issue.identifier}: {issue.title}
                          </span>
                          <span class="block truncate text-xs text-text-weak">
                            {issue.state?.name ?? ""} P{issue.priority ?? "?"}
                          </span>
                        </span>
                      </label>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>
          <Show when={step() === 2}>
            <TextField
              label={language.t("dialog.goalWizard.instructions.label")}
              placeholder={language.t("dialog.goalWizard.instructions.placeholder")}
              multiline
              autofocus
              value={instructions()}
              onChange={setInstructions}
            />
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
          </Show>
          <Show when={step() === 3}>
            <p class="text-sm font-medium">{language.t("dialog.goalWizard.review.title")}</p>
            <div class="flex flex-col gap-1 text-sm">
              <p>
                {language.t("dialog.goalWizard.review.team")}: {teamName()}
              </p>
              <p>{language.t("dialog.goalWizard.review.tickets", { count: chosen().length })}</p>
              <div class="flex max-h-32 flex-col gap-1 overflow-y-auto">
                <For each={chosen()}>
                  {(issue) => (
                    <p class="truncate text-xs text-text-weak">
                      {issue.identifier}: {issue.title}
                    </p>
                  )}
                </For>
              </div>
              <p>
                {language.t("dialog.goalWizard.review.directory")}: {directory().trim() || "—"}
              </p>
              <p>
                {language.t("dialog.goalWizard.review.instructions")}:{" "}
                {instructions().trim() || language.t("dialog.goalWizard.review.none")}
              </p>
              <Show when={chosen().length === 0}>
                <p class="text-xs text-text-weak">{language.t("dialog.goalWizard.review.empty")}</p>
              </Show>
            </div>
            <Show when={queueActive()}>
              <div class="flex justify-end">
                <Button variant="secondary" onClick={stopQueue}>
                  {language.t("dialog.goalWizard.action.stopQueue")}
                </Button>
              </div>
            </Show>
          </Show>
          <div class="flex justify-between gap-2">
            <Button variant="secondary" disabled={step() === 0} onClick={() => setStep(step() - 1)}>
              {language.t("dialog.goalWizard.action.back")}
            </Button>
            <div class="flex gap-2">
              <Show when={step() < 3}>
                <Button
                  variant="primary"
                  disabled={step() === 1 && chosen().length === 0}
                  onClick={() => setStep(step() + 1)}
                >
                  {language.t("dialog.goalWizard.action.next")}
                </Button>
              </Show>
              <Show when={step() === 3}>
                <Button variant="primary" disabled={!canStart()} onClick={startQueue}>
                  {language.t("dialog.goalWizard.action.startQueue")}
                </Button>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
