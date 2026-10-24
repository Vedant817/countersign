/**
 * `.next` must stay out of `apps/web`'s TypeScript project.
 *
 * ## The bug this pins
 *
 * `apps/web/tsconfig.json` had an `include` of `["next-env.d.ts", "**` + `/*.ts", ...]` —
 * that is, a bare double-star glob — and an `exclude` of only `["node_modules", "tests/e2e/**"]`.
 * Nothing excluded `.next`, so the glob swept up everything under it, including
 * `.next/dev/types/routes.d.ts`, which the dev server writes non-atomically.
 *
 * Measured 25 Oct 2026 with `pnpm dev:local` running:
 *
 * ```
 * apps/web typecheck: .next/dev/types/routes.d.ts(91,2): error TS1128: Declaration or statement expected.
 * ```
 *
 * The file held a truncated duplicate fragment at that line: the checker read it mid-write. The failure
 * names a generated file nobody edited, in a route nobody touched, and it vanishes when the dev server
 * stops — so it reads as flakiness rather than as a configuration problem.
 *
 * The production route-types entry stays in `include` deliberately: route typing depends on it. Only the
 * wider sweep had to go.
 *
 * This is the fifth instance in this repository of one shape — a check reporting on something it was
 * never testing. The others: a `capOf()` that matched no values, a CI pin gate that failed
 * unconditionally, a status probe that called a 404 "up", and an aggregate gate that could never pass.
 * Hence a test rather than a comment.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const tsconfig = JSON.parse(readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8')) as {
  include: string[]
  exclude: string[]
}

describe('apps/web tsconfig', () => {
  it('excludes .next, so generated files are not typechecked', () => {
    expect(tsconfig.exclude).toContain('.next')
  })

  it('still includes the production route types, which typing depends on', () => {
    expect(tsconfig.include).toContain('.next/types/**/*.ts')
  })

  it('does not let a bare glob reach generated output', () => {
    /*
     * The precise defect: a bare double-star TypeScript glob matches `.next` as well, and the exclusion
     * is the only thing stopping it. If somebody removes the exclusion to "fix" a missing generated
     * type, this fails and names the reason.
     */
    const bareGlob = tsconfig.include.find((p) => p === '**' + '/*.ts')
    expect(bareGlob, 'the include list still has a bare glob').toBeDefined()
    expect(tsconfig.exclude, 'and .next is what stops it sweeping generated files').toContain(
      '.next',
    )
  })
})
