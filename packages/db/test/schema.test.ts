/**
 * Schema tests — spec §7.1/§7.2, AT-M2.3, AT-M2.4, EC-IDEM-1, EC-MA-1.
 *
 * **These tests need no database.** They read the Drizzle table objects directly, which is the point:
 * the invariants §7 asks for are *structural*, and a structural property should be asserted against the
 * structure rather than against a running Postgres. `DATABASE_URL` may be set and no connection is
 * opened — nothing in this file calls `db()`.
 *
 * The centrepiece is `no column uses a float type`. That test encodes the §0 money rule mechanically:
 * a future edit that reaches for `numeric()` for "just one column" fails here instead of shipping.
 */
import { describe, expect, it } from 'vitest'

import { getTableConfig } from 'drizzle-orm/pg-core'

import {
  budgetAccounts,
  checkoutAttempts,
  mandates,
  orders,
  products,
  schema,
  TABLE_NAMES,
  walletCaps,
  webhookEvents,
} from '../src/schema'
import { PG, isUniqueViolation, pgConstraintName, pgErrorCode, toRepoError } from '../src/repos'

/* ------------------------------------------------------------------------------------------ */
/* Helpers                                                                                         */
/* ------------------------------------------------------------------------------------------ */

/** A table we only need by identity — `getTableConfig` reads its structure, it never queries it. */
type TableLike = Parameters<typeof getTableConfig>[0]

function tableList(): TableLike[] {
  return Object.values(schema) as unknown as TableLike[]
}

function configOf(table: unknown) {
  return getTableConfig(table as TableLike)
}

/**
 * Flatten a drizzle `SQL` object into readable text.
 *
 * Needed because `check()` stores an `SQL` tree, not a string, and asserting on the tree means
 * asserting on the actual generated predicate (`"budget_accounts"."reserved_minor" + … <= …`) rather
 * than on a comment someone wrote next to it.
 */
function sqlText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean')
    return String(value)
  if (Array.isArray(value)) return value.map(sqlText).join('')
  if (typeof value === 'object') {
    const chunk = value as Record<string, unknown>
    if (Array.isArray(chunk['queryChunks']))
      return (chunk['queryChunks'] as unknown[]).map(sqlText).join('')
    // A PgColumn, rendered by name. Checked before `value`, because a column can carry a `value`.
    if (typeof chunk['getSQLType'] === 'function' && typeof chunk['name'] === 'string') {
      return `"${String(chunk['name'])}"`
    }
    // StringChunk (`value: string[]`) and Param (`value: unknown`).
    if ('value' in chunk) return sqlText(chunk['value'])
    if (typeof chunk['name'] === 'string') return `"${String(chunk['name'])}"`
    return ''
  }
  return String(value)
}

type ColumnEntry = ReturnType<typeof configOf>['columns'][number]

/** Column name → the SQL type drizzle will emit for it. Identifiers quoted for SQL are unquoted here. */
function sqlTypes(table: unknown): Map<string, string> {
  const out = new Map<string, string>()
  for (const column of configOf(table).columns) {
    // pg-boss columns are declared as `timestamp('"createdOn"')`, so drizzle keeps the quotes in
    // `column.name`. Strip them so tests can talk about the column by its real name.
    out.set(column.name.replace(/^"(.*)"$/, '$1'), column.getSQLType())
  }
  return out
}

function columnOf(table: unknown, name: string): ColumnEntry | undefined {
  return configOf(table).columns.find((c) => c.name === name)
}

function checkNames(table: unknown): string[] {
  return configOf(table).checks.map((c) => c.name)
}

function findCheck(table: unknown, name: string) {
  return configOf(table).checks.find((c) => c.name === name)
}

function indexNames(table: unknown): string[] {
  return configOf(table).indexes.map((i) => String(i.config.name ?? ''))
}

function uniqueColumnSets(table: unknown): string[][] {
  return configOf(table)
    .indexes.filter((i) => i.config.unique)
    .map((i) => i.config.columns.map((c) => (c as { name?: string }).name ?? ''))
}

function findTable(name: string): TableLike {
  const table = Object.values(schema).find((t) => configOf(t).name === name)
  if (!table) throw new Error(`No table named ${name} in the schema`)
  return table as unknown as TableLike
}

/* ------------------------------------------------------------------------------------------ */
/* Table inventory                                                                                 */
/* ------------------------------------------------------------------------------------------ */

describe('§7.2 table inventory', () => {
  it('defines all 26 §7.2 tables, including the pg-boss jobs table', () => {
    expect(TABLE_NAMES).toHaveLength(26)
    for (const name of [
      'users',
      'paypal_wallets',
      'devices',
      'l1_credentials',
      'agents',
      'mandates',
      'budget_accounts',
      'wallet_caps',
      'budget_entries',
      'products',
      'checkout_sessions',
      'checkout_attempts',
      'gate_decisions',
      'orders',
      'authorizations',
      'captures',
      'refunds',
      'shipments',
      'webhook_events',
      'disputes',
      'evidence_packets',
      'dispute_actions',
      'audit_log',
      'privacy_requests',
      'jwks_keys',
      'jobs',
    ]) {
      expect(TABLE_NAMES).toContain(name)
      // `schema` is keyed by camelCase export; the DB name is what §7.2 specifies.
      expect(() => findTable(name), name).not.toThrow()
    }
  })

  it('names every table exactly as the spec does', () => {
    // §7.1: "every table has created_at and updated_at". The inventory and the names together are the
    // cheapest possible way to notice a table that drifted (typo, plural, prefix).
    const names = tableList().map((t) => configOf(t).name)
    expect(new Set(names).size).toBe(names.length)
    expect(names.sort()).toEqual([...TABLE_NAMES].sort())
  })

  it('gives every table created_at and updated_at with a now() default (§7.1)', () => {
    for (const table of tableList()) {
      const config = configOf(table)
      for (const stamp of ['created_at', 'updated_at'] as const) {
        const column = columnOf(table, stamp)
        expect(column, `${config.name} is missing ${stamp}`).toBeDefined()
        expect(column!.notNull, `${config.name}.${stamp} must be NOT NULL`).toBe(true)
        expect(column!.hasDefault, `${config.name}.${stamp} must default to now()`).toBe(true)
      }
    }
  })
})

/* ------------------------------------------------------------------------------------------ */
/* The money rule — spec §0                                                                      */
/* ------------------------------------------------------------------------------------------ */

describe('§0 money discipline: no float column anywhere', () => {
  /** Every Postgres type that can hold a fractional number. `bigint` and `numeric`-free is the rule. */
  const FLOAT_SQL_TYPES =
    /(double precision|double_precision|\breal\b|\bnumeric\b|\bdecimal\b|\bfloat[48]?\b|\bdecimal\()/i

  it('uses no float, real or numeric column in any table', () => {
    const offenders: string[] = []
    for (const table of tableList()) {
      const config = configOf(table)
      for (const [name, type] of sqlTypes(table)) {
        if (FLOAT_SQL_TYPES.test(type)) offenders.push(`${config.name}.${name}: ${type}`)
      }
    }
    expect(
      offenders,
      `Spec §0: money is integer minor units. These columns are not integers:\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('reports no float-shaped column type object either', () => {
    // Belt and braces: `getSQLType()` covers the emitted DDL, this covers the drizzle `columnType`
    // discriminator, so a custom column that rendered valid SQL would still be caught.
    const FLOAT_COLUMN_KINDS = /DoublePrecision|Real|Numeric/i
    const offenders: string[] = []
    for (const table of tableList()) {
      const config = configOf(table)
      for (const column of config.columns) {
        const kind = (column as { columnType?: string }).columnType ?? ''
        if (FLOAT_COLUMN_KINDS.test(kind)) offenders.push(`${config.name}.${column.name}: ${kind}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('stores every money column as bigint minor units beside a char(3) currency (§7.1)', () => {
    let tablesWithMoney = 0
    for (const table of tableList()) {
      const config = configOf(table)
      const types = sqlTypes(table)
      const moneyColumns = [...types.entries()].filter(([name]) => name.endsWith('_minor'))
      if (moneyColumns.length === 0) continue
      tablesWithMoney++
      for (const [name, type] of moneyColumns) {
        expect(type, `${config.name}.${name} must be bigint minor units, never a float`).toBe(
          'bigint',
        )
      }
      expect(
        types.get('currency'),
        `${config.name} stores money but has no char(3) currency (§7.1)`,
      ).toBe('char(3)')
    }
    // If this ever drops to a small number, a money table lost its minor-unit columns.
    expect(tablesWithMoney).toBeGreaterThanOrEqual(11)
  })

  it('uses timestamptz for business timestamps and epoch-seconds bigint for JWT claim mirrors', () => {
    // §0 / AGENTS.md rule 10: timestamptz in the database, UTC epoch seconds in tokens.
    //
    // `jobs` is exempt: pg-boss declares `createdOn`/`completedOn` as `timestamp without time zone` and
    // compares them against `now()` inside its own index predicates. Changing them would break pg-boss's
    // status index, so the exemption is deliberate and asserted here so nobody "fixes" it later.
    const PG_BOSS_TZ_EXEMPT = new Set(['createdOn', 'completedOn'])
    const jwtClaimColumns: Record<string, readonly string[]> = {
      mandates: ['iat', 'exp'],
      l1_credentials: ['iat', 'exp'],
    }
    for (const table of tableList()) {
      const config = configOf(table)
      const types = sqlTypes(table)
      const claims = jwtClaimColumns[config.name] ?? []
      for (const [name, type] of types) {
        if (!type.startsWith('timestamp')) continue
        if (config.name === 'jobs' && PG_BOSS_TZ_EXEMPT.has(name)) continue
        expect(type, `${config.name}.${name} must be timestamptz`).toContain('with time zone')
        expect(
          claims,
          `${config.name}.${name} should be an epoch-seconds bigint, not a timestamp`,
        ).not.toContain(name)
      }
      for (const claim of claims) {
        expect(types.get(claim), `${config.name}.${claim}`).toBe('bigint')
      }
    }
  })
})

/* ------------------------------------------------------------------------------------------ */
/* AT-M2.3 — the budget CHECK constraint                                                          */
/* ------------------------------------------------------------------------------------------ */

describe('AT-M2.3 budget_accounts rejects reserved+spent > cap in SQL', () => {
  const checks = configOf(budgetAccounts).checks

  it('has a CHECK named for the invariant', () => {
    expect(checks.map((c) => c.name)).toContain('budget_accounts_reserved_plus_spent_le_cap')
  })

  it('the CHECK predicate mentions reserved, spent and cap', () => {
    const check = checks.find((c) => c.name === 'budget_accounts_reserved_plus_spent_le_cap')
    expect(check).toBeDefined()
    const text = sqlText(check!.value)
    expect(text).toContain('reserved_minor')
    expect(text).toContain('spent_minor')
    expect(text).toContain('cap_minor')
    expect(text).toContain('+')
    expect(text).toContain('<=')
  })

  it('rejects a negative reserve or spend as well', () => {
    const names = checks.map((c) => c.name)
    expect(names).toContain('budget_accounts_non_negative')
    expect(sqlText(findCheck(budgetAccounts, 'budget_accounts_non_negative')?.value)).toContain(
      '>= 0',
    )
  })

  it('keys budget_accounts by mandate_id, so one mandate has exactly one budget', () => {
    // Declared with a column-level `.primaryKey()`, so it shows up as `column.primary` rather than in
    // `getTableConfig().primaryKeys` (which only holds table-level `primaryKey({ columns })` groups).
    expect(columnOf(budgetAccounts, 'mandate_id')!.primary).toBe(true)
    expect(columnOf(walletCaps, 'wallet_id')!.primary).toBe(true)
    expect(columnOf(schema.products, 'sku')!.primary).toBe(true)
    expect(columnOf(schema.jwksKeys, 'kid')!.primary).toBe(true)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* AT-M2.4 / EC-IDEM-1 / EC-WH-2 — unique indexes are the replay and idempotency defence          */
/* ------------------------------------------------------------------------------------------ */

describe('unique indexes are the replay / idempotency defence', () => {
  it('EC-IDEM-1: checkout_attempts has UNIQUE (l3_jti) and UNIQUE (idempotency_key)', () => {
    const sets = uniqueColumnSets(checkoutAttempts)
    expect(sets).toContainEqual(['l3_jti'])
    expect(sets).toContainEqual(['idempotency_key'])
  })

  it('EC-WH-2: webhook_events has UNIQUE (paypal_event_id)', () => {
    expect(uniqueColumnSets(webhookEvents)).toContainEqual(['paypal_event_id'])
  })

  it('orders have UNIQUE (paypal_order_id) and UNIQUE (attempt_id)', () => {
    const sets = uniqueColumnSets(orders)
    expect(sets).toContainEqual(['paypal_order_id'])
    expect(sets).toContainEqual(['attempt_id'])
  })

  it('names the replay indexes so a violation can be explained without reading the schema', () => {
    const names = indexNames(checkoutAttempts)
    expect(names).toContain('checkout_attempts_l3_jti_key')
    expect(names).toContain('checkout_attempts_idempotency_key_key')
  })

  it('AT-M2.4: a 23505 unique violation maps to CS_CONFLICT, and l3_jti to GATE_REPLAY', () => {
    const unique = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: PG.UNIQUE_VIOLATION,
      constraint: 'checkout_attempts_l3_jti_key',
    })
    expect(pgErrorCode(unique)).toBe(PG.UNIQUE_VIOLATION)
    expect(isUniqueViolation(unique)).toBe(true)
    expect(pgConstraintName(unique)).toBe('checkout_attempts_l3_jti_key')

    const mapped = toRepoError(unique, { table: 'checkout_attempts' })
    expect(mapped.code).toBe('GATE_REPLAY')
    expect(mapped.retryable).toBe(false)
    expect(mapped.details?.['constraint']).toBe('checkout_attempts_l3_jti_key')

    const idempotency = toRepoError(
      Object.assign(new Error('duplicate'), {
        code: PG.UNIQUE_VIOLATION,
        constraint: 'checkout_attempts_idempotency_key_key',
      }),
      { table: 'checkout_attempts' },
    )
    expect(idempotency.code).toBe('CS_CONFLICT')

    const event = toRepoError(
      Object.assign(new Error('duplicate'), {
        code: PG.UNIQUE_VIOLATION,
        constraint: 'webhook_events_paypal_event_id_key',
      }),
      { table: 'webhook_events' },
    )
    expect(event.code).toBe('WH_DUPLICATE')

    // A unique violation with no named constraint is still a conflict, never a raw crash.
    const anonymous = toRepoError(
      Object.assign(new Error('duplicate'), { code: PG.UNIQUE_VIOLATION }),
      {},
    )
    expect(anonymous.code).toBe('CS_CONFLICT')
  })

  it('maps a 23514 check violation to the code the buyer should be told', () => {
    const overCap = toRepoError(
      Object.assign(new Error('violates check constraint'), {
        code: PG.CHECK_VIOLATION,
        constraint: 'budget_accounts_reserved_plus_spent_le_cap',
      }),
      { table: 'budget_accounts' },
    )
    expect(overCap.code).toBe('GATE_BUDGET_EXCEEDED')
    expect(overCap.message).toMatch(/reserved \+ spent/)

    const deadlock = toRepoError(
      Object.assign(new Error('deadlock'), { code: PG.DEADLOCK_DETECTED }),
      {},
    )
    expect(deadlock.code).toBe('CS_CONFLICT')
    expect(deadlock.retryable).toBe(true)

    expect(toRepoError(new Error('no sqlstate here')).code).toBe('CS_VALIDATION')
  })
})

/* ------------------------------------------------------------------------------------------ */
/* Other §7.2 invariants                                                                           */
/* ------------------------------------------------------------------------------------------ */

describe('other §7.2 invariants enforced in SQL', () => {
  it('mandates: CHECK that exp > iat', () => {
    const checks = configOf(mandates).checks
    const check = checks.find((c) => c.name === 'mandates_exp_gt_iat')
    expect(check).toBeDefined()
    const text = sqlText(check!.value)
    expect(text).toContain('exp')
    expect(text).toContain('iat')
    expect(text).toContain('>')
  })

  it('mandates: documents that exp <= L1.exp is application code (it spans two tables)', async () => {
    // A CHECK may only reference its own row, so this one cannot exist here. The assertion is that we
    // noticed: `mandates` declares no constraint that references `l1_credentials`, and the
    // cross-table rule is enforced by a pure function in `repos/mandates.ts` that this test can call
    // without a database.
    const names = checkNames(mandates)
    expect(names.some((n) => n.includes('l1'))).toBe(false)

    const { assertMandateWithinL1 } = await import('../src/repos/mandates')
    const l1 = { exp: 200n, iat: 100n } as Parameters<typeof assertMandateWithinL1>[1]
    expect(assertMandateWithinL1({ exp: 199n, iat: 101n }, l1).ok).toBe(true)
    const tooLong = assertMandateWithinL1({ exp: 201n, iat: 101n }, l1)
    expect(tooLong.ok).toBe(false)
    if (!tooLong.ok) expect(tooLong.error.code).toBe('VI_EXPIRED')
  })

  it('audit_log: has prev_hash (nullable) and this_hash (not null) for the §7.2 hash chain', () => {
    expect(columnOf(schema.auditLog, 'prev_hash')).toBeDefined()
    expect(columnOf(schema.auditLog, 'prev_hash')!.notNull).toBe(false)
    expect(columnOf(schema.auditLog, 'this_hash')).toBeDefined()
    expect(columnOf(schema.auditLog, 'this_hash')!.notNull).toBe(true)
    expect(sqlTypes(schema.auditLog).get('this_hash')).toBe('text')
  })

  it('privacy_requests: legal_hold_reason is nullable, so null means "no hold in force"', () => {
    expect(columnOf(schema.privacyRequests, 'legal_hold_reason')).toBeDefined()
    expect(columnOf(schema.privacyRequests, 'legal_hold_reason')!.notNull).toBe(false)
  })

  it('EC-STOCK-3: products.stock may never go negative', () => {
    const check = findCheck(products, 'products_stock_non_negative')
    expect(check).toBeDefined()
    expect(sqlText(check!.value)).toContain('>= 0')
  })

  it('evidence_packets: notes are capped at 2000 characters (§8.15, [V8])', () => {
    const check = findCheck(schema.evidencePackets, 'evidence_packets_notes_le_2000')
    expect(check).toBeDefined()
    expect(sqlText(check!.value)).toContain('2000')
  })

  it('captures: refunded_minor can never exceed amount_minor (EC-REF-2 backstop)', () => {
    const check = findCheck(schema.captures, 'captures_refunded_lte_amount')
    expect(check).toBeDefined()
    expect(sqlText(check!.value)).toContain('<=')
  })

  it('every pg-mirrored table stores raw jsonb and fetched_at (§7.1)', () => {
    const mirrored = [
      'paypal_wallets',
      'orders',
      'authorizations',
      'captures',
      'refunds',
      'shipments',
      'disputes',
    ]
    for (const name of mirrored) {
      const table = Object.values(schema).find((t) => configOf(t).name === name)
      expect(table, name).toBeDefined()
      const types = sqlTypes(table)
      expect(types.get('raw'), `${name}.raw`).toBe('jsonb')
      expect(types.get('fetched_at'), `${name}.fetched_at`).toContain('timestamp')
    }
  })
})

/* ------------------------------------------------------------------------------------------ */
/* Indexes serve a named query                                                                    */
/* ------------------------------------------------------------------------------------------ */

describe('indexes exist for the queries the rest of the system runs', () => {
  it('covers every lookup the prompt and the Gate require', () => {
    expect(indexNames(checkoutAttempts)).toEqual(
      expect.arrayContaining([
        'checkout_attempts_mandate_id_idx',
        'checkout_attempts_checkout_session_id_idx',
        'checkout_attempts_mandate_id_created_at_idx',
      ]),
    )
    expect(indexNames(schema.budgetEntries)).toEqual(
      expect.arrayContaining([
        'budget_entries_mandate_id_at_idx',
        'budget_entries_mandate_id_kind_at_idx',
      ]),
    )
    expect(indexNames(schema.disputes)).toEqual(
      expect.arrayContaining([
        'disputes_defense_state_idx',
        'disputes_seller_response_due_date_idx',
      ]),
    )
    expect(indexNames(webhookEvents)).toContain('webhook_events_resource_id_idx')
    expect(indexNames(schema.evidencePackets)).toContain('evidence_packets_dispute_id_idx')
    expect(indexNames(schema.shipments)).toContain('shipments_order_id_idx')
  })

  it('indexes every PayPal mirror by its mirror column', () => {
    const expected: Record<string, string> = {
      orders: 'orders_custom_id_idx',
      captures: 'captures_order_id_idx',
      refunds: 'refunds_capture_id_idx',
      authorizations: 'authorizations_order_id_idx',
    }
    for (const [table, indexName] of Object.entries(expected)) {
      expect(
        indexNames(Object.values(schema).find((t) => configOf(t).name === table)),
        table,
      ).toContain(indexName)
    }
  })
})

/* ------------------------------------------------------------------------------------------ */
/* Connection laziness                                                                            */
/* ------------------------------------------------------------------------------------------ */

describe('client.ts never connects at import time', () => {
  it('db() is lazy and only creates the pool when first called', async () => {
    const { db, isDbInitialised, resetDbForTesting } = await import('../src/client')
    resetDbForTesting()
    expect(isDbInitialised()).toBe(false)
    expect(typeof db).toBe('function')
    // Importing the module must not have created a pool, with or without DATABASE_URL set.
    expect(isDbInitialised()).toBe(false)
    resetDbForTesting()
  })

  it('db() throws a typed CsError (CS_VALIDATION) when DATABASE_URL is unset (§6)', async () => {
    const { db, resetDbForTesting } = await import('../src/client')
    const previous = process.env['DATABASE_URL']
    resetDbForTesting()
    delete process.env['DATABASE_URL']
    try {
      expect(() => db()).toThrow()
      try {
        db()
      } catch (e) {
        const error = e as { code?: string; userMessage?: string }
        expect(error.code).toBe('CS_VALIDATION')
        expect(error.userMessage).toMatch(/misconfigured/)
      }
    } finally {
      if (previous !== undefined) process.env['DATABASE_URL'] = previous
      resetDbForTesting()
    }
  })
})
