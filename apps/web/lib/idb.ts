export const DATABASE_NAME = 'countersign'
export const KEYS_STORE = 'keys'
export const PASSKEYS_STORE = 'passkeys'
export const USER_INDEX = 'by-user'

const DATABASE_VERSION = 1

let databasePromise: Promise<IDBDatabase> | null = null

export function openCountersignDatabase(): Promise<IDBDatabase> {
  if (databasePromise !== null) {
    return databasePromise
  }

  databasePromise = openDatabase().catch((error: unknown) => {
    databasePromise = null
    throw error
  })

  return databasePromise
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result

      if (!database.objectStoreNames.contains(KEYS_STORE)) {
        const keys = database.createObjectStore(KEYS_STORE, { keyPath: 'kid' })
        keys.createIndex(USER_INDEX, 'userId', { unique: true })
      }

      if (!database.objectStoreNames.contains(PASSKEYS_STORE)) {
        database.createObjectStore(PASSKEYS_STORE, { keyPath: 'userId' })
      }
    }

    request.onerror = () => {
      reject(
        request.error ??
          new DOMException('Failed to open the countersign database', 'UnknownError'),
      )
    }

    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => {
        database.close()
        databasePromise = null
      }
      resolve(database)
    }
  })
}

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      reject(request.error ?? new DOMException('The IndexedDB request failed', 'UnknownError'))
    }
  })
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => {
      reject(
        transaction.error ??
          new DOMException('The IndexedDB transaction was aborted', 'AbortError'),
      )
    }
    transaction.onerror = () => {
      reject(
        transaction.error ?? new DOMException('The IndexedDB transaction failed', 'UnknownError'),
      )
    }
  })
}
