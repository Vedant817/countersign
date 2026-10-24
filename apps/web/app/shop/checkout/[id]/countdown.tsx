'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

function formatRemaining(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${String(hours)}:${mm}:${ss}` : `${mm}:${ss}`
}

export function PriceLockCountdown({
  expiresAt,
  requoteHref,
}: {
  expiresAt: number
  requoteHref: string
}) {
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000))
    const timer = window.setInterval(() => {
      setNow(Math.floor(Date.now() / 1000))
    }, 1000)
    return () => {
      window.clearInterval(timer)
    }
  }, [])

  const remaining = now === null ? null : expiresAt - now

  if (remaining !== null && remaining <= 0) {
    return (
      <p
        data-testid="price-lock-countdown"
        className="mt-6 rounded-card border border-rule bg-paper-raised px-5 py-4 font-mono text-sm text-ink-soft"
      >
        Quote expired. The displayed total has not been refreshed.{' '}
        <Link href={requoteHref} className="underline underline-offset-4">
          Re-quote this item
        </Link>
      </p>
    )
  }

  return (
    <p
      data-testid="price-lock-countdown"
      className="mt-6 rounded-card border border-rule bg-paper-raised px-5 py-4 font-mono text-sm text-ink-soft"
    >
      {remaining === null
        ? 'Checking the quote’s remaining time…'
        : `Price locked for ${formatRemaining(remaining)}`}
    </p>
  )
}
