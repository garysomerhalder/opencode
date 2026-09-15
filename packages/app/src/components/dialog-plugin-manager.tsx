import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List } from "@opencode-ai/ui/list"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useMutation } from "@tanstack/solid-query"
import { Accessor, Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import type { PluginListResponse } from "@opencode-ai/sdk/v2/client"

type Row = PluginListResponse["plugins"][number]
type Removed = { spec: string; global: boolean }

export const PluginManagerView: Component<{ directory?: string; heading?: boolean }> = (props) => {
  const language = useLanguage()
  const serverSDK = useServerSDK()

  const [view, setView] = createSignal<"list" | "install">("list")
  const [spec, setSpec] = createSignal("")
  // Without a project directory, local installs would land in the sidecar's
  // working directory, so lock scope to global.
  const [global, setGlobal] = createSignal(props.directory === undefined)
  const [pending, setPending] = createSignal<string | undefined>()
  const [removed, setRemoved] = createSignal<Removed[]>([])

  const [plugins, { refetch }] = createResource(async () => {
    const result = await serverSDK().client.plugin.list({ directory: props.directory })
    if (!result.data) throw new Error(language.t("common.requestFailed"))
    return result.data.plugins
  })

  const busy = createMemo(() => pending() !== undefined)

  const removeMutation = useMutation(() => ({
    mutationFn: async (row: Removed) => {
      const result = await serverSDK().client.plugin.remove({
        directory: props.directory,
        spec: row.spec,
        global: row.global,
      })
      if (!result.data) throw new Error(language.t("common.requestFailed"))
      return { row, removed: result.data.removed, files: result.data.files }
    },
    onSuccess: ({ row, removed: gone, files }) => {
      setPending(undefined)
      if (!gone.length) {
        showToast({
          title: language.t("toast.plugin.notFound.title", { spec: row.spec }),
        })
        return
      }
      setRemoved((prev) => (prev.some((item) => item.spec === row.spec) ? prev : [...prev, row]))
      void refetch()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("toast.plugin.removed.title", { spec: row.spec }),
        description: language.t("toast.plugin.removed.description", { files: files.join(", ") }),
      })
    },
    onError: (error) => {
      setPending(undefined)
      showToast({
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    },
  }))

  const installMutation = useMutation(() => ({
    mutationFn: async (row: Removed & { spec: string }) => {
      const value = row.spec.trim()
      if (!value) throw new Error(language.t("dialog.plugin.install.empty"))
      const result = await serverSDK().client.plugin.install({
        directory: props.directory,
        spec: value,
        global: row.global,
      })
      if (!result.data) throw new Error(language.t("common.requestFailed"))
      return { row: { ...row, spec: value }, data: result.data }
    },
    onSuccess: ({ row }) => {
      setPending(undefined)
      setRemoved((prev) => prev.filter((item) => item.spec !== row.spec))
      setSpec("")
      setView("list")
      void refetch()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("toast.plugin.installed.title", { spec: row.spec }),
        description: language.t("toast.plugin.installed.description", { dir: row.global ? "global" : "local" }),
      })
    },
    onError: (error) => {
      setPending(undefined)
      showToast({
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    },
  }))

  const disable = (row: Row) => {
    if (busy()) return
    setPending(row.spec)
    removeMutation.mutate({ spec: row.spec, global: row.scope === "global" })
  }

  const enable = (row: Removed) => {
    if (busy()) return
    setPending(row.spec)
    installMutation.mutate(row)
  }

  const submitInstall = (e: SubmitEvent) => {
    e.preventDefault()
    if (busy()) return
    const value = spec().trim()
    if (!value) {
      showToast({ title: language.t("dialog.plugin.install.empty") })
      return
    }
    setPending(value)
    installMutation.mutate({ spec: value, global: global() })
  }

  const items = createMemo(() => [...(plugins() ?? [])].sort((a, b) => a.id.localeCompare(b.id)))
  const stale = createMemo(() =>
    removed().filter((row) => !(plugins() ?? []).some((item) => item.spec === row.spec)),
  )

  const meta = (row: Row) => {
    const parts: string[] = [row.scope]
    if (row.version) parts.push(`v${row.version}`)
    return parts.join(" · ")
  }

  return (
    <Show
      when={view() === "list"}
      fallback={
        <div>
          <div class="px-2.5 pb-2">
            <IconButton
              tabIndex={-1}
              icon="arrow-left"
              variant="ghost"
              onClick={() => setView("list")}
              aria-label={language.t("common.goBack")}
            />
          </div>
          <form onSubmit={submitInstall} class="px-2.5 pb-6 flex flex-col gap-6">
            <div class="px-2.5 flex flex-col gap-1">
              <div class="text-16-medium text-text-strong">{language.t("dialog.plugin.install.title")}</div>
              <p class="text-14-regular text-text-base">{language.t("dialog.plugin.install.description")}</p>
            </div>
            <div class="px-2.5 flex flex-col gap-4">
              <TextField
                autofocus
                label={language.t("dialog.plugin.install.spec.label")}
                placeholder={language.t("dialog.plugin.install.spec.placeholder")}
                value={spec()}
                onChange={setSpec}
              />
              <div class="w-full flex items-center justify-between gap-x-3">
                <div class="flex flex-col gap-0.5">
                  <span class="text-14-regular text-text-strong">
                    {language.t("dialog.plugin.install.scope.label")}
                  </span>
                  <span class="text-12-regular text-text-weaker">
                    {global()
                      ? language.t("dialog.plugin.install.scope.global")
                      : language.t("dialog.plugin.install.scope.local")}
                  </span>
                </div>
                <Switch
                  checked={global()}
                  disabled={busy() || props.directory === undefined}
                  onChange={setGlobal}
                />
              </div>
            </div>
            <div class="px-2.5">
              <Button class="w-auto self-start" type="submit" size="large" variant="primary" disabled={busy()}>
                {busy()
                  ? language.t("dialog.plugin.install.installing")
                  : language.t("dialog.plugin.install.submit")}
              </Button>
            </div>
          </form>
        </div>
      }
    >
        <div class="flex flex-col gap-3 px-3 pb-3">
          <Show when={props.heading !== false}>
            <div class="flex flex-col gap-1 px-1">
              <div class="text-16-medium text-text-strong">{language.t("dialog.plugin.title")}</div>
              <p class="text-14-regular text-text-base">
                {language.t("dialog.plugin.description", { count: items().length })}
              </p>
            </div>
          </Show>
          <List
            search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
            emptyMessage={language.t("dialog.plugin.empty")}
            key={(x) => x?.spec ?? ""}
            items={items}
            filterKeys={["id", "spec", "scope"]}
            sortBy={(a, b) => a.id.localeCompare(b.id)}
            onSelect={(x) => {
              if (!x || busy()) return
              disable(x)
            }}
          >
            {(row) => (
              <div class="w-full flex items-center justify-between gap-x-3">
                <div class="flex flex-col gap-0.5 min-w-0">
                  <span class="truncate">{row.id}</span>
                  <span class="text-11-regular text-text-weaker truncate">{row.spec}</span>
                  <span class="text-11-regular text-text-weaker">{meta(row)}</span>
                </div>
                <div onClick={(e) => e.stopPropagation()}>
                  <Switch
                    checked
                    disabled={busy() && pending() === row.spec}
                    onChange={() => disable(row)}
                  />
                </div>
              </div>
            )}
          </List>
          <Show when={stale().length > 0}>
            <div class="flex flex-col gap-1">
              <span class="text-12-medium text-text-weak px-1">
                {language.t("dialog.plugin.removed.title")}
              </span>
              <For each={stale()}>
                {(row) => (
                  <div class="w-full flex items-center justify-between gap-x-3 px-1 py-1">
                    <div class="flex flex-col gap-0.5 min-w-0">
                      <span class="truncate text-text-weaker">{row.spec}</span>
                    </div>
                    <Button
                      type="button"
                      size="small"
                      variant="ghost"
                      disabled={busy()}
                      onClick={() => enable(row)}
                    >
                      {language.t("dialog.plugin.readd")}
                    </Button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Button
            type="button"
            size="small"
            variant="ghost"
            icon="plus-small"
            onClick={() => setView("install")}
            class="self-start"
          >
            {language.t("dialog.plugin.install.open")}
          </Button>
        </div>
    </Show>
  )
}

export const DialogPluginManager: Component<{ directory?: string }> = (props) => {
  return (
    <Dialog>
      <PluginManagerView directory={props.directory} />
    </Dialog>
  )
}

export function usePluginManagerDialog(directory?: Accessor<string | undefined>) {
  const dialog = useDialog()

  return () => {
    void dialog.show(() => <DialogPluginManager directory={directory?.()} />)
  }
}

export function usePluginManagerCommand(directory?: Accessor<string | undefined>) {
  const command = useCommand()
  const language = useLanguage()
  const show = usePluginManagerDialog(directory)

  command.register("plugin", () => [
    {
      id: "plugin.manager",
      title: language.t("command.plugin.manager"),
      description: language.t("command.plugin.manager.description"),
      category: language.t("command.category.settings"),
      onSelect: show,
    },
  ])

  return show
}
