'use client'

import type { UserId } from '@countersign/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'

import { getOrCreateDeviceKey, signSigningInput, type DeviceKey } from '@/lib/browser-keystore'
import { stepUp } from '@/lib/webauthn'

const USER_ID: UserId = 'usr_demo_user'
const SIGN_DELAY_MS = 1_500

const preparedL2Schema = z.object({
  prepareId: z.string(),
  signingInput: z.string(),
  payload: z.unknown(),
  expiresAt: z.number(),
})

const finalizedL2Schema = z.object({
  l2: z.string(),
  iat: z.number(),
  exp: z.number().nullable().optional(),
  agentKid: z.string(),
})

const errorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
})

interface ConstraintRow {
  type: string
  detail: string
}

const istFormatter = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'Asia/Kolkata',
})

function formatIst(epochSeconds: number): string {
  return `${istFormatter.format(new Date(epochSeconds * 1000))} IST`
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

async function readResponseBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

async function errorMessageFromBody(response: Response): Promise<string> {
  const parsed = errorBodySchema.safeParse(await readResponseBody(response))
  if (parsed.success) {
    return `${parsed.data.error.code}: ${parsed.data.error.message}`
  }
  return `The harness returned HTTP ${response.status}.`
}

function isLostDevice(cause: unknown): boolean {
  if (typeof DOMException === 'undefined' || !(cause instanceof DOMException)) {
    return false
  }
  return (
    cause.name === 'NotFoundError' ||
    cause.name === 'InvalidStateError' ||
    cause.name === 'UnknownError'
  )
}

function collectConstraints(payload: unknown): ConstraintRow[] {
  const rows: ConstraintRow[] = []
  walk(payload, rows)
  return rows
}

function walk(value: unknown, rows: ConstraintRow[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      walk(entry, rows)
    }
    return
  }
  if (value === null || typeof value !== 'object') {
    return
  }
  const record = value as Record<string, unknown>
  const type = record['type']
  if (typeof type === 'string' && type.startsWith('mandate.')) {
    rows.push({ type, detail: JSON.stringify(record, null, 2) ?? '' })
  }
  for (const entry of Object.values(record)) {
    walk(entry, rows)
  }
}

export default function DeviceSignPage() {
  const [deviceKey, setDeviceKey] = useState<DeviceKey | null>(null)
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const [deviceLost, setDeviceLost] = useState(false)
  const [prepare, setPrepare] = useState<z.infer<typeof preparedL2Schema> | null>(null)
  const [finalized, setFinalized] = useState<z.infer<typeof finalizedL2Schema> | null>(null)
  const [signature, setSignature] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [signing, setSigning] = useState(false)
  const [signDisabled, setSignDisabled] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const signTimer = useRef<number | null>(null)

  const clearSignTimer = useCallback(() => {
    if (signTimer.current !== null) {
      window.clearTimeout(signTimer.current)
      signTimer.current = null
    }
  }, [])

  const armSignDelay = useCallback(() => {
    clearSignTimer()
    setSignDisabled(true)
    signTimer.current = window.setTimeout(() => {
      signTimer.current = null
      setSignDisabled(false)
    }, SIGN_DELAY_MS)
  }, [clearSignTimer])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const created = await getOrCreateDeviceKey(USER_ID)
        if (!cancelled) {
          setDeviceKey(created)
        }
      } catch (cause) {
        if (!cancelled) {
          setDeviceError(describeError(cause))
        }
      }
    })()
    return () => {
      cancelled = true
      clearSignTimer()
    }
  }, [clearSignTimer])

  const onPrepare = useCallback(async () => {
    if (deviceKey === null) {
      return
    }
    setPreparing(true)
    setError(null)
    setFinalized(null)
    setSignature(null)
    setDeviceLost(false)
    setPrepare(null)
    clearSignTimer()

    try {
      const response = await fetch('/lab/device-sign/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceKid: deviceKey.kid,
          devicePublicJwk: deviceKey.publicJwk,
        }),
      })
      if (!response.ok) {
        setError(await errorMessageFromBody(response))
        return
      }
      const parsed = preparedL2Schema.safeParse(await readResponseBody(response))
      if (!parsed.success) {
        setError('The prepare response did not match the contract.')
        return
      }
      setPrepare(parsed.data)
      armSignDelay()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setPreparing(false)
    }
  }, [armSignDelay, clearSignTimer, deviceKey])

  const onSign = useCallback(async () => {
    if (deviceKey === null || prepare === null) {
      return
    }
    setSigning(true)
    setSignDisabled(true)
    setError(null)

    try {
      const assertion = await stepUp(USER_ID, prepare.signingInput)
      if (assertion === null) {
        setError('WebAuthn step-up is unavailable in this browser, so the L2 was not signed.')
        return
      }

      let signatureB64Url: string
      try {
        signatureB64Url = await signSigningInput(deviceKey.kid, prepare.signingInput)
      } catch (cause) {
        if (isLostDevice(cause)) {
          setDeviceLost(true)
          setDeviceKey(null)
          setPrepare(null)
          setSignDisabled(true)
          setError('This browser no longer holds the device key.')
          return
        }
        throw cause
      }

      setSignature(signatureB64Url)

      const response = await fetch('/lab/device-sign/finalize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prepareId: prepare.prepareId,
          signatureB64Url,
        }),
      })
      if (!response.ok) {
        setError(await errorMessageFromBody(response))
        return
      }
      const parsed = finalizedL2Schema.safeParse(await readResponseBody(response))
      if (!parsed.success) {
        setError('The finalize response did not match the contract.')
        return
      }
      setFinalized(parsed.data)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setSigning(false)
    }
  }, [deviceKey, prepare])

  const constraints = prepare === null ? [] : collectConstraints(prepare.payload)

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-10 px-6 py-16">
      <header>
        <span className="label-signed font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
          Lab · AT-M5
        </span>
        <h1 className="mt-4 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          Device-signed intent
        </h1>
        <p className="mt-4 max-w-2xl text-pretty text-ink-soft">
          This page creates a non-extractable P-256 key in this browser, asks the vi-service to
          prepare an L2 whose signing input names that key, then asks for a WebAuthn step-up before
          signing. The token below is the result: a device-signed mandate intent this browser could
          not have produced without the key it holds.
        </p>
      </header>

      <section className="rounded-card border border-rule bg-paper-raised p-6">
        <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
          1 · Device key
        </h2>
        {deviceKey !== null ? (
          <dl className="mt-4 space-y-2 font-mono text-sm">
            <div className="flex flex-wrap gap-2">
              <dt className="text-ink-faint">kid</dt>
              <dd data-testid="device-kid" className="break-all">
                {deviceKey.kid}
              </dd>
            </div>
            <div className="flex flex-wrap gap-2">
              <dt className="text-ink-faint">jkt</dt>
              <dd className="break-all text-ink-soft">{deviceKey.jkt}</dd>
            </div>
            <div className="flex flex-wrap gap-2">
              <dt className="text-ink-faint">created</dt>
              <dd className="text-ink-soft">{formatIst(deviceKey.createdAt)}</dd>
            </div>
          </dl>
        ) : deviceError === null ? (
          <p className="mt-4 text-sm text-ink-soft">Creating a P-256 key in this browser…</p>
        ) : null}
        {deviceError !== null ? (
          <p data-testid="device-error" role="alert" className="mt-4 text-sm text-blocked">
            {deviceError}
          </p>
        ) : null}
        {deviceLost ? (
          <div
            data-testid="device-lost"
            className="mt-5 rounded-card border-l-4 border-blocked bg-blocked-soft p-4"
          >
            <p className="font-semibold">This device is new</p>
            <p className="mt-1 text-sm text-ink-soft">
              Reconnect PayPal to create a key. Your existing mandates still work; revoke them?
            </p>
            <button
              type="button"
              onClick={() => {
                window.location.reload()
              }}
              className="mt-3 rounded-card border border-blocked px-4 py-2 text-sm font-semibold"
            >
              Enrol this device
            </button>
          </div>
        ) : null}
      </section>

      <section className="rounded-card border border-rule bg-paper-raised p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
            2 · Prepare the L2
          </h2>
          <button
            type="button"
            data-testid="prepare-button"
            disabled={deviceKey === null || preparing}
            onClick={() => {
              void onPrepare()
            }}
            className="rounded-card border border-rule px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {preparing ? 'Preparing…' : 'Prepare the L2'}
          </button>
        </div>
        {prepare !== null ? (
          <div className="mt-5 space-y-4">
            <dl className="space-y-2 font-mono text-sm">
              <div className="flex flex-wrap gap-2">
                <dt className="text-ink-faint">prepare_id</dt>
                <dd className="break-all">{prepare.prepareId}</dd>
              </div>
              <div className="flex flex-wrap gap-2">
                <dt className="text-ink-faint">expires</dt>
                <dd className="text-ink-soft">{formatIst(prepare.expiresAt)}</dd>
              </div>
            </dl>
            <div>
              <h3 className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
                Constraints
              </h3>
              <ul className="mt-2 space-y-2">
                {constraints.map((row, index) => (
                  <li key={`${row.type}-${index}`} className="rounded-card bg-paper p-3">
                    <p data-testid="constraint-type" className="font-mono text-xs text-signed">
                      {row.type}
                    </p>
                    <pre className="mt-2 overflow-x-auto font-mono text-xs text-ink-soft">
                      {row.detail}
                    </pre>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
                Payload
              </h3>
              <pre
                data-testid="signed-payload"
                className="mt-2 overflow-x-auto rounded-card bg-paper p-3 font-mono text-xs text-ink-soft"
              >
                {JSON.stringify(prepare.payload, null, 2) ?? ''}
              </pre>
            </div>
          </div>
        ) : (
          <p className="mt-4 text-sm text-ink-soft">
            Prepare asks the vi-service for a signing input bound to this device key.
          </p>
        )}
      </section>

      <section className="rounded-card border border-rule bg-paper-raised p-6">
        <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
          3 · Step up and sign
        </h2>
        <p className="mt-3 text-sm text-ink-soft">
          Signing asks for a WebAuthn assertion first, then signs the prepared input with the device
          key. The signature is a P1363 r‖s pair.
        </p>
        <button
          type="button"
          data-testid="sign-button"
          disabled={prepare === null || signDisabled || signing || deviceKey === null}
          onClick={() => {
            void onSign()
          }}
          className="mt-4 rounded-card bg-ink px-4 py-2 text-sm font-semibold text-paper disabled:opacity-50"
        >
          {signing ? 'Signing…' : 'Step up and sign'}
        </button>
        {signDisabled && prepare !== null && !deviceLost ? (
          <p className="mt-2 text-xs text-ink-faint">
            Take a breath — signing unlocks in a moment.
          </p>
        ) : null}
        <div className="mt-5 space-y-3">
          <div>
            <h3 className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
              Signature
            </h3>
            <p data-testid="signature-b64url" className="mt-1 break-all font-mono text-xs">
              {signature ?? '—'}
            </p>
          </div>
          {finalized !== null ? (
            <div>
              <h3 className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
                L2 token
              </h3>
              <p data-testid="l2-token" className="mt-1 break-all font-mono text-xs">
                {finalized.l2}
              </p>
              <dl className="mt-3 space-y-1 font-mono text-xs text-ink-soft">
                <div className="flex flex-wrap gap-2">
                  <dt className="text-ink-faint">agent_kid</dt>
                  <dd className="break-all">{finalized.agentKid}</dd>
                </div>
                <div className="flex flex-wrap gap-2">
                  <dt className="text-ink-faint">iat</dt>
                  <dd>{formatIst(finalized.iat)}</dd>
                </div>
                <div className="flex flex-wrap gap-2">
                  <dt className="text-ink-faint">exp</dt>
                  <dd>
                    {finalized.exp === null || finalized.exp === undefined
                      ? 'none'
                      : formatIst(finalized.exp)}
                  </dd>
                </div>
              </dl>
            </div>
          ) : null}
        </div>
      </section>

      {error !== null ? (
        <p data-testid="error-message" role="alert" className="text-sm text-blocked">
          {error}
        </p>
      ) : null}

      <footer className="border-t border-rule pt-6 text-sm text-ink-faint">
        The device key never leaves this browser. The signing input and the L2 are produced by the
        vi-service; the signature is the browser&rsquo;s.
      </footer>
    </div>
  )
}
