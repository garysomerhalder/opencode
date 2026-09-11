import { ServerConnection } from "@/context/server"
import { tabHref, type Tab } from "@/context/tabs"
import { legacySessionHref } from "@/utils/session-route"

export function loopServerKey(serverURL: string | null): ServerConnection.Key {
  try {
    const raw = new URL(serverURL ?? "").hostname
    // WHATWG URL keeps IPv6 brackets in hostname ("[::1]"), so strip them before comparing.
    const host = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
      return ServerConnection.Key.make("sidecar")
    }
    return ServerConnection.Key.make(serverURL ?? "sidecar")
  } catch {
    return ServerConnection.Key.make("sidecar")
  }
}

export type OpenLoopSessionTabs = {
  addSessionTab(t: { server: unknown; sessionId: string }): { server: unknown; sessionId: string }
  select(tab: unknown): void
}

export type OpenLoopSessionState = {
  sessionID: string | null
  serverURL: string | null
  directory: string
}

export type OpenLoopSessionDeps = {
  tabs: OpenLoopSessionTabs
  navigate: (href: string) => void
  state: OpenLoopSessionState
}

export function openLoopSession(deps: OpenLoopSessionDeps): void {
  const current = deps.state
  if (!current?.sessionID) return
  try {
    // Goal-loop sessions run on the server the main controller dials,
    // which in the desktop shell is always the local sidecar. Opening
    // through tabs.select is the same path a tab-strip click uses: it
    // marks the tab active AND navigates. A bare navigate leaves the
    // recent tab active and the view on the draft composer.
    const tab = deps.tabs.addSessionTab({
      server: loopServerKey(current.serverURL),
      sessionId: current.sessionID,
    })
    console.info("[goal-loop] opening session", tabHref(tab as unknown as Tab))
    deps.tabs.select(tab)
  } catch (err) {
    console.error("[goal-loop] open session failed", err)
    deps.navigate(legacySessionHref(current.directory, current.sessionID))
  }
}
