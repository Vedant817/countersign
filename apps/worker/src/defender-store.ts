/**
 * The worker's handle on the production `DefenderStore`.
 *
 * The implementation moved to `packages/defender/src/db-store.ts` when §8.15's merchant approval click
 * became a second caller: `apps/web` needs the same rename-and-forward map, and a second copy would be
 * the drift `docs/contract-issues.md` item 9 warns about. This file stays because the worker's own
 * wiring and its live test both import `./defender-store`, and a one-line re-export keeps that true
 * without keeping a second implementation.
 *
 * Nothing here is a wrapper: `dbDefenderStore` is the package's function, not a call to it, so a test
 * that stubs the package sees exactly one object.
 */
export { dbDefenderStore, refundsRefusedLoudly } from '@countersign/defender'
