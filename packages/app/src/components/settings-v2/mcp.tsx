import { type Accessor, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { McpManagerView } from "@/components/dialog-select-mcp"
import "../settings-v2/settings-v2.css"

export const SettingsMcpV2: Component<{ directory: Accessor<string | undefined> }> = (props) => {
  const language = useLanguage()

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.mcp.title")}</h2>
        </div>
      </div>
      <div class="settings-v2-tab-body">
        <McpManagerView directory={props.directory()} heading={false} />
      </div>
    </>
  )
}
