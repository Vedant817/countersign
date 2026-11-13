/**
 * Where a login may send the browser — D-059.
 *
 * Split out of `lib/auth.ts` so the route and its tests can validate `?next=` without importing the
 * Next runtime: an open redirector is a phishing primitive, and the rule that refuses one is pure string
 * work that deserves a direct test.
 */
export function safeNextPath(value: string | undefined): string {
  if (typeof value !== 'string') return '/disputes'
  const trimmed = value.trim()
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\'))
    return '/disputes'
  // Control characters can smuggle a header or a second URL through a proxy. A code-point loop rather than a
  // regex: ESLint's `no-control-regex` is right that a literal control character in a pattern is a bug
  // waiting to be copied, and this is the one place the check belongs.
  for (const character of trimmed) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) return '/disputes'
  }
  return trimmed
}
