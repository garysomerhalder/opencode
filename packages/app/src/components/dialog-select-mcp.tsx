import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List } from "@opencode-ai/ui/list"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { useMutation } from "@tanstack/solid-query"
import { Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import type { McpLocalConfig, McpRemoteConfig, McpStatus } from "@opencode-ai/sdk/v2/client"

type Row = { name: string; status: McpStatus; hint?: string }

const statusLabels = {
  connected: "mcp.status.connected",
  failed: "mcp.status.failed",
  needs_auth: "mcp.status.needs_auth",
  needs_client_registration: "mcp.status.needs_client_registration",
  disabled: "mcp.status.disabled",
} as const

type Entry = { key: string; value: string }

function parseEntries(rows: Entry[]): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    out[key] = row.value
  }
  return Object.keys(out).length ? out : undefined
}

export const McpManagerView: Component<{ directory?: string; heading?: boolean }> = (props) => {
  const language = useLanguage()
  const serverSDK = useServerSDK()

  const [view, setView] = createSignal<"list" | "install" | "remove">("list")
  const [pending, setPending] = createSignal<string | undefined>()

  // Install form state
  const [name, setName] = createSignal("")
  const [remote, setRemote] = createSignal(false)
  const [command, setCommand] = createSignal("")
  const [cwd, setCwd] = createSignal("")
  const [url, setUrl] = createSignal("")
  const [oauth, setOauth] = createSignal(false)
  const [clientId, setClientId] = createSignal("")
  const [clientSecret, setClientSecret] = createSignal("")
  const [oauthScope, setOauthScope] = createSignal("")
  const [callbackPort, setCallbackPort] = createSignal("")
  const [redirectUri, setRedirectUri] = createSignal("")
  const [env, setEnv] = createSignal<Entry[]>([{ key: "", value: "" }])
  const [headers, setHeaders] = createSignal<Entry[]>([{ key: "", value: "" }])
  const [global, setGlobal] = createSignal(props.directory === undefined)

  // Remove confirm state
  const [target, setTarget] = createSignal("")
  const [logout, setLogout] = createSignal(false)

  const [data, { refetch }] = createResource(async () => {
    const client = serverSDK().client
    const status = await client.mcp.status({ directory: props.directory })
    if (!status.data) throw new Error(language.t("common.requestFailed"))
    const config = await client.config.get({ directory: props.directory })
    if (!config.data) throw new Error(language.t("common.requestFailed"))
    return { status: status.data, mcp: config.data.mcp ?? {} }
  })

  const busy = createMemo(() => pending() !== undefined)

  const items = createMemo<Row[]>(() => {
    const snapshot = data()
    if (!snapshot) return []
    return Object.entries(snapshot.status)
      .map(([server, status]) => {
        const config = snapshot.mcp[server]
        const hint =
          config && typeof config === "object" && "type" in config
            ? config.type === "remote"
              ? (config as McpRemoteConfig).url
              : (config as McpLocalConfig).command.join(" ")
            : undefined
        return { name: server, status, hint }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  const enabledCount = createMemo(() => items().filter((i) => i.status.status === "connected").length)

  const refresh = () => {
    void refetch()
  }

  const flip = (row: Row) => {
    if (busy()) return
    setPending(row.name)
    toggleMutation.mutate(row)
  }

  const toggleMutation = useMutation(() => ({
    mutationFn: async (row: Row) => {
      const client = serverSDK().client
      const status = row.status.status
      if (status === "connected") {
        await client.mcp.disconnect({ directory: props.directory, name: row.name })
      } else if (status === "needs_auth") {
        await client.mcp.auth.authenticate({ directory: props.directory, name: row.name })
      } else if (
        status === "disabled" ||
        status === "failed" ||
        status === "needs_client_registration"
      ) {
        await client.mcp.connect({ directory: props.directory, name: row.name })
      }
    },
    onSuccess: () => {
      setPending(undefined)
      refresh()
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
    mutationFn: async () => {
      const server = name().trim()
      if (!server) throw new Error(language.t("dialog.mcp.install.name.empty"))
      let oauthConfig: McpRemoteConfig["oauth"] | undefined
      if (remote() && oauth()) {
        const port = callbackPort().trim()
        oauthConfig = {
          ...(clientId().trim() ? { clientId: clientId().trim() } : {}),
          ...(clientSecret().trim() ? { clientSecret: clientSecret().trim() } : {}),
          ...(oauthScope().trim() ? { scope: oauthScope().trim() } : {}),
          ...(redirectUri().trim() ? { redirectUri: redirectUri().trim() } : {}),
        }
        if (port) {
          const value = Number(port)
          if (!Number.isInteger(value) || value < 1 || value > 65535) {
            throw new Error(language.t("dialog.mcp.install.oauth.callbackPort.invalid"))
          }
          oauthConfig.callbackPort = value
        }
      }
      const config = remote()
        ? ({
            type: "remote",
            url: url().trim(),
            ...(parseEntries(headers()) ? { headers: parseEntries(headers()) } : {}),
            ...(oauthConfig ? { oauth: oauthConfig } : {}),
          } as McpRemoteConfig)
        : ({
            type: "local",
            command: command().trim().split(/\s+/).filter(Boolean),
            ...(cwd().trim() ? { cwd: cwd().trim() } : {}),
            ...(parseEntries(env()) ? { environment: parseEntries(env()) } : {}),
          } as McpLocalConfig)
      if (remote() && !url().trim()) throw new Error(language.t("dialog.mcp.install.url.empty"))
      if (!remote() && !(config as McpLocalConfig).command.length) {
        throw new Error(language.t("dialog.mcp.install.command.empty"))
      }
      const result = await serverSDK().client.mcp.install({
        directory: props.directory,
        name: server,
        config,
        global: global(),
      })
      if (!result.data) throw new Error(language.t("common.requestFailed"))
      return server
    },
    onSuccess: (server) => {
      setPending(undefined)
      resetInstall()
      setView("list")
      refresh()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("toast.mcp.installed.title", { name: server }),
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

  const removeMutation = useMutation(() => ({
    mutationFn: async () => {
      const server = target()
      const result = await serverSDK().client.mcp.remove({
        directory: props.directory,
        name: server,
        logout: logout(),
      })
      if (!result.data) throw new Error(language.t("common.requestFailed"))
      return { server, removed: result.data.removed, files: result.data.files }
    },
    onSuccess: ({ server, removed, files }) => {
      setPending(undefined)
      if (!removed) {
        showToast({ title: language.t("toast.mcp.notFound.title", { name: server }) })
        return
      }
      setTarget("")
      setLogout(false)
      setView("list")
      refresh()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("toast.mcp.removed.title", { name: server }),
        description: language.t("toast.mcp.removed.description", { files: files.join(", ") }),
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

  const resetInstall = () => {
    setName("")
    setCommand("")
    setCwd("")
    setUrl("")
    setOauth(false)
    setClientId("")
    setClientSecret("")
    setOauthScope("")
    setCallbackPort("")
    setRedirectUri("")
    setEnv([{ key: "", value: "" }])
    setHeaders([{ key: "", value: "" }])
  }

  const submitInstall = (e: SubmitEvent) => {
    e.preventDefault()
    if (busy()) return
    setPending(name().trim())
    installMutation.mutate()
  }

  const submitRemove = (e: SubmitEvent) => {
    e.preventDefault()
    if (busy() || !target()) return
    setPending(target())
    removeMutation.mutate()
  }

  const updateEntry = (
    rows: Entry[],
    set: (next: Entry[]) => void,
    index: number,
    field: "key" | "value",
    value: string,
  ) => {
    set(rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
  }

  const statusLabel = (status: McpStatus) => {
    const key = statusLabels[status.status as keyof typeof statusLabels]
    return key ? language.t(key) : status.status
  }

  const error = (status: McpStatus) => {
    if (status.status === "failed" || status.status === "needs_client_registration") return status.error
  }

  const enabled = (status: McpStatus) => status.status === "connected"

  const entryRows = (copy: {
    rows: Entry[]
    set: (next: Entry[]) => void
    keyLabel: string
    keyPlaceholder: string
    valueLabel: string
    valuePlaceholder: string
    removeLabel: string
  }) => {
    return (
      <For each={copy.rows}>
        {(row, i) => (
          <div class="flex gap-2 items-start">
            <div class="flex-1">
              <TextField
                hideLabel
                label={copy.keyLabel}
                placeholder={copy.keyPlaceholder}
                value={row.key}
                onChange={(v) => updateEntry(copy.rows, copy.set, i(), "key", v)}
              />
            </div>
            <div class="flex-1">
              <TextField
                hideLabel
                label={copy.valueLabel}
                placeholder={copy.valuePlaceholder}
                value={row.value}
                onChange={(v) => updateEntry(copy.rows, copy.set, i(), "value", v)}
              />
            </div>
            <IconButton
              type="button"
              icon="trash"
              variant="ghost"
              class="mt-1.5"
              onClick={() => copy.set(copy.rows.filter((_, j) => j !== i()))}
              disabled={copy.rows.length <= 1}
              aria-label={copy.removeLabel}
            />
          </div>
        )}
      </For>
    )
  }

  return (
    <Show
      when={view() === "list"}
      fallback={
        <Show
          when={view() === "install"}
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
              <form onSubmit={submitRemove} class="px-2.5 pb-6 flex flex-col gap-6">
                <div class="px-2.5 flex flex-col gap-1">
                  <div class="text-16-medium text-text-strong">
                    {language.t("dialog.mcp.remove.title", { name: target() })}
                  </div>
                  <p class="text-14-regular text-text-base">{language.t("dialog.mcp.remove.description")}</p>
                </div>
                <div class="px-2.5 flex flex-col gap-4">
                  <div class="w-full flex items-center justify-between gap-x-3">
                    <div class="flex flex-col gap-0.5">
                      <span class="text-14-regular text-text-strong">
                        {language.t("dialog.mcp.remove.logout.label")}
                      </span>
                      <span class="text-12-regular text-text-weaker">
                        {language.t("dialog.mcp.remove.logout.description")}
                      </span>
                    </div>
                    <Switch checked={logout()} disabled={busy()} onChange={setLogout} />
                  </div>
                </div>
                <div class="px-2.5 flex gap-2">
                  <Button type="button" variant="ghost" disabled={busy()} onClick={() => setView("list")}>
                    {language.t("common.cancel")}
                  </Button>
                  <Button type="submit" size="large" variant="primary" disabled={busy()}>
                    {language.t("dialog.mcp.remove.submit")}
                  </Button>
                </div>
              </form>
            </div>
          }
        >
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
                <div class="text-16-medium text-text-strong">{language.t("dialog.mcp.install.title")}</div>
                <p class="text-14-regular text-text-base">{language.t("dialog.mcp.install.description")}</p>
              </div>
              <div class="px-2.5 flex flex-col gap-4">
                <TextField
                  autofocus
                  label={language.t("dialog.mcp.install.name.label")}
                  placeholder={language.t("dialog.mcp.install.name.placeholder")}
                  value={name()}
                  onChange={setName}
                />
                <div class="w-full flex items-center justify-between gap-x-3">
                  <div class="flex flex-col gap-0.5">
                    <span class="text-14-regular text-text-strong">
                      {language.t("dialog.mcp.install.type.label")}
                    </span>
                    <span class="text-12-regular text-text-weaker">
                      {remote()
                        ? language.t("dialog.mcp.install.type.remote")
                        : language.t("dialog.mcp.install.type.local")}
                    </span>
                  </div>
                  <Switch checked={remote()} disabled={busy()} onChange={setRemote} />
                </div>
                <Show
                  when={remote()}
                  fallback={
                    <>
                      <TextField
                        label={language.t("dialog.mcp.install.command.label")}
                        placeholder={language.t("dialog.mcp.install.command.placeholder")}
                        description={language.t("dialog.mcp.install.command.description")}
                        value={command()}
                        onChange={setCommand}
                      />
                      <TextField
                        label={language.t("dialog.mcp.install.cwd.label")}
                        placeholder={language.t("dialog.mcp.install.cwd.placeholder")}
                        value={cwd()}
                        onChange={setCwd}
                      />
                      <div class="flex flex-col gap-3">
                        <label class="text-12-medium text-text-weak">
                          {language.t("dialog.mcp.install.env.label")}
                        </label>
                        {entryRows({
                          rows: env(),
                          set: setEnv,
                          keyLabel: language.t("dialog.mcp.install.env.key.label"),
                          keyPlaceholder: language.t("dialog.mcp.install.env.key.placeholder"),
                          valueLabel: language.t("dialog.mcp.install.env.value.label"),
                          valuePlaceholder: language.t("dialog.mcp.install.env.value.placeholder"),
                          removeLabel: language.t("dialog.mcp.install.env.remove"),
                        })}
                        <Button
                          type="button"
                          size="small"
                          variant="ghost"
                          icon="plus-small"
                          onClick={() => setEnv([...env(), { key: "", value: "" }])}
                          class="self-start"
                        >
                          {language.t("dialog.mcp.install.env.add")}
                        </Button>
                      </div>
                    </>
                  }
                >
                  <TextField
                    label={language.t("dialog.mcp.install.url.label")}
                    placeholder={language.t("dialog.mcp.install.url.placeholder")}
                    value={url()}
                    onChange={setUrl}
                  />
                  <div class="flex flex-col gap-3">
                    <label class="text-12-medium text-text-weak">
                      {language.t("dialog.mcp.install.headers.label")}
                    </label>
                    {entryRows({
                      rows: headers(),
                      set: setHeaders,
                      keyLabel: language.t("dialog.mcp.install.headers.key.label"),
                      keyPlaceholder: language.t("dialog.mcp.install.headers.key.placeholder"),
                      valueLabel: language.t("dialog.mcp.install.headers.value.label"),
                      valuePlaceholder: language.t("dialog.mcp.install.headers.value.placeholder"),
                      removeLabel: language.t("dialog.mcp.install.headers.remove"),
                    })}
                    <Button
                      type="button"
                      size="small"
                      variant="ghost"
                      icon="plus-small"
                      onClick={() => setHeaders([...headers(), { key: "", value: "" }])}
                      class="self-start"
                    >
                      {language.t("dialog.mcp.install.headers.add")}
                    </Button>
                  </div>
                  <div class="w-full flex items-center justify-between gap-x-3">
                    <div class="flex flex-col gap-0.5">
                      <span class="text-14-regular text-text-strong">
                        {language.t("dialog.mcp.install.oauth.label")}
                      </span>
                      <span class="text-12-regular text-text-weaker">
                        {language.t("dialog.mcp.install.oauth.description")}
                      </span>
                    </div>
                    <Switch checked={oauth()} disabled={busy()} onChange={setOauth} />
                  </div>
                  <Show when={oauth()}>
                    <TextField
                      label={language.t("dialog.mcp.install.oauth.clientId.label")}
                      placeholder={language.t("dialog.mcp.install.oauth.clientId.placeholder")}
                      value={clientId()}
                      onChange={setClientId}
                    />
                    <TextField
                      label={language.t("dialog.mcp.install.oauth.clientSecret.label")}
                      placeholder={language.t("dialog.mcp.install.oauth.clientSecret.placeholder")}
                      value={clientSecret()}
                      onChange={setClientSecret}
                    />
                    <TextField
                      label={language.t("dialog.mcp.install.oauth.scope.label")}
                      placeholder={language.t("dialog.mcp.install.oauth.scope.placeholder")}
                      value={oauthScope()}
                      onChange={setOauthScope}
                    />
                    <TextField
                      label={language.t("dialog.mcp.install.oauth.callbackPort.label")}
                      placeholder={language.t("dialog.mcp.install.oauth.callbackPort.placeholder")}
                      value={callbackPort()}
                      onChange={setCallbackPort}
                    />
                    <TextField
                      label={language.t("dialog.mcp.install.oauth.redirectUri.label")}
                      placeholder={language.t("dialog.mcp.install.oauth.redirectUri.placeholder")}
                      value={redirectUri()}
                      onChange={setRedirectUri}
                    />
                  </Show>
                </Show>
                <div class="w-full flex items-center justify-between gap-x-3">
                  <div class="flex flex-col gap-0.5">
                    <span class="text-14-regular text-text-strong">
                      {language.t("dialog.mcp.install.scope.label")}
                    </span>
                    <span class="text-12-regular text-text-weaker">
                      {global()
                        ? language.t("dialog.mcp.install.scope.global")
                        : language.t("dialog.mcp.install.scope.local")}
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
                  {busy() ? language.t("dialog.mcp.install.installing") : language.t("dialog.mcp.install.submit")}
                </Button>
              </div>
            </form>
          </div>
        </Show>
      }
    >
      <div class="flex flex-col gap-3 px-3 pb-3">
        <Show when={props.heading !== false}>
          <div class="flex flex-col gap-1 px-1">
            <div class="text-16-medium text-text-strong">{language.t("dialog.mcp.title")}</div>
            <p class="text-14-regular text-text-base">
              {language.t("dialog.mcp.description", { enabled: enabledCount(), total: items().length })}
            </p>
          </div>
        </Show>
        <List
          search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
          emptyMessage={language.t("dialog.mcp.empty")}
          key={(x) => x?.name ?? ""}
          items={items}
          filterKeys={["name", "status"]}
          sortBy={(a, b) => a.name.localeCompare(b.name)}
          onSelect={(x) => {
            if (!x || busy()) return
            flip(x)
          }}
        >
          {(row) => (
            <div class="w-full flex items-center justify-between gap-x-3">
              <div class="flex flex-col gap-0.5 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="truncate">{row.name}</span>
                  <span class="text-11-regular text-text-weaker">{statusLabel(row.status)}</span>
                </div>
                <Show when={row.hint ?? error(row.status)}>
                  <span class="text-11-regular text-text-weaker truncate">{row.hint ?? error(row.status)}</span>
                </Show>
              </div>
              <div class="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <IconButton
                  type="button"
                  icon="trash"
                  variant="ghost"
                  onClick={() => {
                    if (busy()) return
                    setTarget(row.name)
                    setLogout(false)
                    setView("remove")
                  }}
                  disabled={busy()}
                  aria-label={language.t("dialog.mcp.remove.open", { name: row.name })}
                />
                <Switch
                  checked={enabled(row.status)}
                  disabled={busy() && pending() === row.name}
                  onChange={() => flip(row)}
                />
              </div>
            </div>
          )}
        </List>
        <Button
          type="button"
          size="small"
          variant="ghost"
          icon="plus-small"
          onClick={() => {
            resetInstall()
            setGlobal(props.directory === undefined)
            setView("install")
          }}
          class="self-start"
        >
          {language.t("dialog.mcp.install.open")}
        </Button>
      </div>
    </Show>
  )
}

export const DialogSelectMcp: Component<{ directory?: string }> = (props) => {
  return (
    <Dialog>
      <McpManagerView directory={props.directory} />
    </Dialog>
  )
}
