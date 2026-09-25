import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260925021311_todo_evidence",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`todo_evidence\` (
          \`session_id\` text NOT NULL,
          \`content_key\` text NOT NULL,
          \`content\` text NOT NULL,
          \`verifier_session_id\` text NOT NULL,
          \`evidence\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_evidence_pk\` PRIMARY KEY(\`session_id\`, \`content_key\`),
          CONSTRAINT \`fk_todo_evidence_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
