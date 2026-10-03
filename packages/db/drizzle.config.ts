/**
 * drizzle-kit configuration — spec §8.2 (M2), work package WP-02.
 *
 * `pnpm db:migrate` runs `drizzle-kit migrate`, which reads this file. Three deliberate choices:
 *
 *  1. **`DATABASE_URL` is read at generate time and never required for it.** `drizzle-kit generate`
 *     diffs the schema against the committed journal and needs no connection, so migrations can be
 *     produced (and reviewed) on a laptop with no Postgres running. `migrate` does connect, and
 *     fails loudly with an empty URL rather than quietly pointing somewhere else.
 *  2. **`schema` points at `src/schema.ts` alone.** Drizzle must see every table in one module so
 *     the generated `CREATE TABLE` order and the enums are deterministic; splitting the schema
 *     would make migration diffs depend on glob ordering.
 *  3. **`out` is `drizzle/`** (the drizzle-kit default location for this layout). The SQL files are
 *     generated, committed, and applied in order by `migrate`. They are *not* TypeScript, which is
 *     why `eslint.config.mjs` exempts that directory from the no-`any` rule.
 *
 * Nothing here connects to a database at import time.
 */
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    // Present for `migrate`/`push`/`studio`; unused by `generate`.
    url: process.env['DATABASE_URL'] ?? '',
  },
  strict: true,
  verbose: true,
})
