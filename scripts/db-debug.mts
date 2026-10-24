/**
 * Throwaway: run the Gate's two attempt queries directly and print the real error.
 *
 * `pnpm tsx scripts/db-debug.mts <mandateId>`
 */
process.env['DATABASE_URL'] = 'postgres://countersign:countersign@127.0.0.1:5432/countersign'

const repository = await import('../packages/db/src/index.ts')

const mandateId = process.argv[2] ?? ''
console.log('mandate', mandateId)

const recent = await repository.countRecentAttempts(mandateId as never, new Date(Date.now() - 600_000))
console.log('countRecentAttempts', JSON.stringify(recent, (key, value) => (typeof value === 'bigint' ? value.toString() : value), 1))

const listed = await repository.listAttemptsForMandate(mandateId as never, 5)
console.log('listAttemptsForMandate', JSON.stringify(listed, (key, value) => (typeof value === 'bigint' ? value.toString() : value), 1))

const mandate = await repository.findMandateById(mandateId as never)
console.log('mandate row', JSON.stringify(mandate, (key, value) => (typeof value === 'bigint' ? value.toString() : value), 1).slice(0, 600))
