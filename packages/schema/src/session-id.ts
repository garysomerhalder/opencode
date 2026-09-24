import { Schema } from "effect"
import { descending } from "./identifier"
import { statics } from "./schema"

// "ses", then letters, digits, "_" and "-" only: session ids name directories (the
// archive of cut tool output), so no wildcard, dot, slash or space. Generated ids
// are ses_ and letters and digits; "_" and "-" keep existing ids valid.
export const SessionID = Schema.String.check(Schema.isPattern(/^ses[A-Za-z0-9_-]*$/)).pipe(
  Schema.brand("SessionID"),
  statics((schema) => {
    const create = () => schema.make("ses_" + descending())
    return {
      create,
      descending: (id?: string) => (id === undefined ? create() : schema.make(id)),
    }
  }),
)
export type SessionID = typeof SessionID.Type
