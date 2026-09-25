// Routes that change what the verifier runs on (config: its model, its provider, the
// plugins that load; an instance reload that re-reads them) take the host token while
// a goal or a verification is active (docs/accuracy-e.md §11.8). Outside that, they
// work as before. Config written to disk by a worker's shell is not stopped here: that
// is the Phase 4 worker sandbox's to deny.
import { Effect } from "effect"
import type { HttpServerRequest } from "effect/unstable/http"
import { HttpApiError } from "effect/unstable/httpapi"
import type { ProjectV2 } from "@opencode-ai/core/project"
import { HostToken } from "@/server/host-token"
import type { Session } from "@/session/session"

export const requireHostWhileActive = Effect.fn("HostGuard.requireHostWhileActive")(function* (
  sessions: Pick<Session.Interface, "hostActive">,
  request: HttpServerRequest.HttpServerRequest,
  projectID?: ProjectV2.ID,
) {
  if (HostToken.verify(request.headers[HostToken.HEADER])) return
  if (!(yield* sessions.hostActive(projectID))) return
  return yield* new HttpApiError.Forbidden({})
})
