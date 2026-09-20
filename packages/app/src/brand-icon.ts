/**
 * The Legatus mark as a data URI, for the places that need an image *URL* rather than a component.
 *
 * Today that is OS notifications. Upstream points those at
 * `https://opencode.ai/favicon-96x96-v3.png`, which is two defects at once: every notification the
 * app raises shows the upstream mark, and it is fetched from upstream over the network each time.
 *
 * A data URI fixes both and avoids a public-dir or asset-pipeline path, which would have to differ
 * between the Vite dev server, a packaged `file://` renderer and the web build.
 *
 * Source: `packages/desktop/icons/legatus/64x64.png`, produced by `scripts/legatus-icons.ts` from
 * the Brand API mark (asset `logo-icon-svg`). To regenerate after the icons change, from the repo
 * root:
 *
 *     node -e "console.log(require('fs').readFileSync('packages/desktop/icons/legatus/64x64.png').toString('base64'))"
 */
export const LEGATUS_ICON_DATA_URI =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAEkklEQVR4nO2bTWwUZRjHn7dHVzt7aD0YLSYepR/Gi1GQ9iZSAzcqJVgvVIogHq" +
  "ylaMREBPEAQgDpxZa0UE9IrMqNYv04GVeKZ0I5toddwp4I+/L/TzrLdphd5ru7nfklM/O8m93NPr953nfemdlRUoOnsy3duqS2itJdWku3NAhK" +
  "SR6bnGiVkyaZKOYXc2g74ijgmeyz20paf6G17kKz4YGQWSxf3ssvzYqNxwRkmltPaNEHEK45lKiTxbuLHyMsUxaQzb6Yva/vXW6kUvcDJIxDwv" +
  "sITRQWE+z5H7DnByQBQMJ3kGBWuSmAff5BqXQZYWJoapIejglqufRvaS1ZvJ4YMCjOFgtLPSqTbTmgS3ICryUO1aReURmj9V+9Rg53XuFYoJ5q" +
  "btGIY2fduja5fXsBEY9AhuTzBUTxgm5wfVUEfHP0K+nsaJe3tmxFS+TQwWFpe+F5+XT081hFQEA+VgHc69OT49KB5Of++GuFgNGRT+TGjXkZ3L" +
  "sf25t4NR5iE/BO79vy/ZlTZrkTJwGEFcBKmJy6hFb0xCKAJf/h0CCiR1QTYEEBFEEhURKpgMqSt/MkASSOLhGZAHvJ23EjgLACWAmsiCiIRIBT" +
  "ydtxK8CCAgaH9iMKl1AF1Cp5O14FEHaJvp0D5flDGIQm4M2Nb8ilyYmqJW/HjwDCLvEBxoWfZ35FKzihCOCPZxJe8CvA4sjR4/L1sW8RBSOwgL" +
  "Fzp6V/Rx8ibwQVQH6f+1M2925D5J/AAq7+ckU2bngdkTfOnBuT4ZFDiMQcMDlw+gEnc1j7Z1UEcDTnqF6JXwkNJ8ApeYud/e/K+bOnELmnoQTU" +
  "St7Cq4SGEeAmeYuOjvVydeaKGEYzWrVpCAFekrdwK6HuBfhJ3oIS/p67hqg6dS1gfv6mvLahB5F/frx4QXq3bEbkTF0LmLo4Lbv37EPkn+PHjs" +
  "jePbsROVPXAjhvf7nzVXPrB55X/P/fP+a2GnUtgFROeb3iZopc9wLsg+BvMz9hXZ3KuT3PMJ/0/roXYP+BtSY6dlmkWFjEujr27/dK7AJItc84" +
  "vTcVkApIBWBdHafPeCEVkApIBaQCAgnwc7ISloAg02yLwAIIL2iOjgw7XrxwSioMAbwnwHsDQQlFAOHFi7Gzp6W9fT1aj3BKKoiAhYU7sr1/F2" +
  "6ThXPHODQBFvYu4ZSUXwG8vjB88DPfp9dOhC6A8CxueuqC2SWckvIqoFC4ayZuP1EKg0gEEF7EOI8usX3HLrRW4kUA3zs4tC/UO8KVRCagFkzK" +
  "rYCoSQWkAlZBgNOlbg50z7W9hCheVkUAB0hOnKzDJWd0fTi2h3l4c4vKGC15rcVAHDv8J5lhGJEc3tyglBQoYBYCNqGdOCDguso0t57Uoj9CO3" +
  "GYf5fns4GlklxDO3GYD0xgy8NPTmvdiTAxsPyLhaVuU0ASq6D80BRikySNBez7Kx6bs4CEcUh4D+GaBclPIPkBWWaFAAIJa7YSkHx5z1s8JoBw" +
  "TMDc4DCWTWg2PBzwsBxmnxcbjgIsMtnWLinJAB+fR7MLQgxs6x4kyzl1bvnx+fFaj88/BNP7mcB4VCEmAAAAAElFTkSuQmCC"
