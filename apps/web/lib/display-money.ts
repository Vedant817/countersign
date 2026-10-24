import { formatMoney, type Money } from '@countersign/core'

/** A destination never changes charge currency. Keep the ISO code visible beside every amount. */
export function displayMoney(amount: Money): string {
  return `${amount.currency} ${formatMoney(amount)}`
}
