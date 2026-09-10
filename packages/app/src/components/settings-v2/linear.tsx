import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Component, Show, createSignal, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform, type LinearSettingsPlatform } from "@/context/platform"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type LinearIdentity = { name: string; email: string }

export const SettingsLinearV2: Component = () => {
  const platform = usePlatform()
  return <Show when={platform.linear}>{(api) => <LinearSection api={api()} />}</Show>
}

const LinearSection: Component<{ api: LinearSettingsPlatform }> = (props) => {
  const language = useLanguage()
  const [apiKey, setApiKey] = createSignal("")
  const [visible, setVisible] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [identity, setIdentity] = createSignal<LinearIdentity | null>(null)
  const [stored, setStored] = createSignal(false)

  const status = () => {
    if (busy()) return language.t("linear.settings.status.checking")
    const current = identity()
    if (current)
      return language.t("linear.settings.status.connected", { name: current.name, email: current.email })
    return language.t("linear.settings.status.disconnected")
  }

  onMount(() => {
    void refresh()
  })

  const refresh = async () => {
    setBusy(true)
    setError(null)
    try {
      const connected = await props.api.hasKey()
      setStored(connected)
      if (!connected) {
        setIdentity(null)
        return
      }
      setIdentity(await props.api.test())
    } catch (err) {
      setIdentity(null)
      setError(linearError(err))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    const value = apiKey().trim()
    if (!value || busy()) return
    setBusy(true)
    setError(null)
    try {
      await props.api.setKey(value)
      setApiKey("")
      setStored(true)
      setIdentity(await props.api.test())
    } catch (err) {
      setError(linearError(err))
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    if (busy()) return
    setBusy(true)
    setError(null)
    try {
      await props.api.clearKey()
      setApiKey("")
      setStored(false)
      setIdentity(null)
    } catch (err) {
      setError(linearError(err))
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    if (busy()) return
    setBusy(true)
    setError(null)
    try {
      setIdentity(await props.api.test())
      setStored(true)
    } catch (err) {
      setIdentity(null)
      setError(linearError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("linear.settings.title")}</h3>
      <p class="settings-v2-linear-description">{language.t("linear.settings.description")}</p>
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("linear.settings.apiKey.title")}
          description={language.t("linear.settings.apiKey.description")}
        >
          <div class="flex w-full gap-2 sm:w-[300px]">
            <TextInputV2
              data-action="settings-linear-api-key"
              type={visible() ? "text" : "password"}
              appearance="base"
              value={apiKey()}
              onInput={(event) => setApiKey(event.currentTarget.value)}
              placeholder={language.t("linear.settings.apiKey.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("linear.settings.apiKey.title")}
            />
            <ButtonV2
              size="normal"
              variant="ghost-muted"
              data-action="settings-linear-api-key-visibility"
              onClick={() => setVisible(!visible())}
            >
              {visible() ? language.t("linear.settings.apiKey.hide") : language.t("linear.settings.apiKey.show")}
            </ButtonV2>
          </div>
        </SettingsRowV2>

        <SettingsRowV2 title={language.t("linear.settings.status.title")} description={status()}>
          <div class="flex gap-2">
            <ButtonV2
              size="normal"
              variant="neutral"
              data-action="settings-linear-save"
              disabled={busy() || apiKey().trim().length === 0}
              onClick={() => void save()}
            >
              {language.t("linear.settings.action.save")}
            </ButtonV2>
            <ButtonV2
              size="normal"
              variant="ghost-muted"
              data-action="settings-linear-test"
              disabled={busy()}
              onClick={() => void test()}
            >
              {language.t("linear.settings.action.test")}
            </ButtonV2>
            <ButtonV2
              size="normal"
              variant="ghost-muted"
              data-action="settings-linear-clear"
              disabled={busy() || (!stored() && apiKey().trim().length === 0)}
              onClick={() => void clear()}
            >
              {language.t("linear.settings.action.clear")}
            </ButtonV2>
          </div>
        </SettingsRowV2>

        <Show when={error()}>
          {(message) => (
            <div class="settings-v2-linear-error" role="alert">
              {message()}
            </div>
          )}
        </Show>
      </SettingsListV2>
    </div>
  )
}

function linearError(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}
