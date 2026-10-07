/**
 * Execute the installed pg-boss delivery and settlement machinery without a database. Only the polling
 * loop and persistence ports are replaced. Callback wrapping, resolution and rejection are pg-boss's.
 * This deliberately uses internal source: dependency upgrades must re-qualify this boundary.
 */
import Manager from '../node_modules/pg-boss/dist/manager.js'
import { getConfig } from '../node_modules/pg-boss/dist/attorney.js'
import type { Job } from 'pg-boss'

import type { PgBossLike } from '../src/job-runner'

export interface SettleRecord {
  readonly state: 'completed' | 'retry'
  readonly name: string
  readonly ids: unknown
  readonly output: unknown
}

interface InternalWorker {
  readonly id: string
  readonly name: string
  stopping: boolean
  readonly onFetch: (jobs: readonly Job<unknown>[]) => Promise<void>
}

interface InternalManager {
  addWorker: (worker: InternalWorker) => void
  readonly workers: Map<string, InternalWorker>
}

export function realPgBossDelivery() {
  const states = new Map<string, 'active' | 'completed' | 'retry'>()
  const outputs = new Map<string, unknown>()
  const deliveries: Job<unknown>[][] = []
  const settlements: SettleRecord[] = []
  const manager = new Manager(
    {
      executeSql: async () => {
        throw new Error('This delivery test must not access a database')
      },
    },
    getConfig({ connectionString: 'postgres://unused/unused' }),
  )
  const internalManager = manager as unknown as InternalManager
  internalManager.addWorker = (worker: InternalWorker) => {
    // Keep real work()/onFetch() but prevent the background fetch loop from opening a connection.
    worker.stopping = true
    internalManager.workers.set(worker.id, worker)
  }
  const settle = (
    state: 'completed' | 'retry',
    ids: Parameters<Manager['complete']>[1],
    output: unknown,
  ) => {
    const entries = Array.isArray(ids) ? ids : [ids]
    const jobIds = entries.map((entry) => (typeof entry === 'string' ? entry : entry.id))
    for (const id of jobIds) {
      states.set(id, state)
      outputs.set(id, output)
    }
    return { jobs: jobIds, requested: jobIds.length, affected: jobIds.length, settled: jobIds }
  }
  manager.complete = async (name, ids, output) => {
    settlements.push({ state: 'completed', name, ids, output })
    return settle('completed', ids, output)
  }
  manager.fail = async (name, ids, output: unknown) => {
    settlements.push({ state: 'retry', name, ids, output })
    return settle('retry', ids, output)
  }

  const boss: Pick<PgBossLike, 'work'> = {
    work: (name, options, callback) =>
      manager.work<unknown>(name, options, async (jobs) => {
        deliveries.push(jobs)
        return callback(jobs)
      }),
  }
  return {
    // Unused registration methods require no connection either.
    boss: {
      ...boss,
      start: async () => {},
      stop: async () => {},
      send: async () => null,
      schedule: async () => {},
    } satisfies PgBossLike,
    states,
    outputs,
    deliveries,
    settlements,
    async deliverJobs(name: string, jobs: readonly Job<unknown>[]) {
      const worker = [...internalManager.workers.values()].find((item) => item.name === name)
      if (!worker) throw new Error(`No worker for ${name}`)
      for (const job of jobs) states.set(job.id, 'active')
      await worker.onFetch(jobs)
      return jobs
    },
    async deliver(name: string, payloads: readonly unknown[]) {
      const worker = [...internalManager.workers.values()].find((item) => item.name === name)
      if (!worker) throw new Error(`No worker for ${name}`)
      const jobs: Job<unknown>[] = payloads.map((data, index) => ({
        id: `${name}-${deliveries.length}-${index}`,
        name,
        data,
        expireInSeconds: 60,
        heartbeatSeconds: null,
        retryCount: 0,
        signal: new AbortController().signal,
      }))
      for (const job of jobs) states.set(job.id, 'active')
      await worker.onFetch(jobs)
      return jobs
    },
  }
}
