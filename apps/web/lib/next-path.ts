/**
 * Where a login or a sign-up may send the browser — D-059, D-060.
 *
 * Split out of `lib/auth.ts` so the route and its tests can validate `?next=` without importing the
 * Next runtime: an open redirector is a phishing primitive, and the rule that refuses one is pure string
 * work that deserves a direct test.
 *
 * The *default* is a parameter rather than a constant, because there are two front doors now: the
 * merchant sign-in lands on the dispute queue, the buyer sign-in lands on the agent surface. A caller
 * states which, and `safeNextPath` itself only decides whether a path is one of ours.
 */
export function safeNextPath(value: string | undefined, fallback = '/disputes'): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\'))
    return fallback
  // Control characters can smuggle a header or a second URL through a proxy. A code-point loop rather than a
  // regex: ESLint's `no-control-regex` is right that a literal control character in a pattern is a bug
  // waiting to be copied, and this is the one place the check belongs.
  for (const character of trimmed) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) return fallback
  }
  return trimmed
}
