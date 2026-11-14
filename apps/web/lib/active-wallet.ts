import type { WalletRow } from '@countersign/db'

/**
 * Returns the wallet with the newest `created_at` whose status is 'ACTIVE' and whose
 * `payment_token_id` does not start with 'DEMO-' and does not start with 'SEED_PLACEHOLDER'.
 * Returns undefined if none. Pure function, no DB.
 */
export function pickActiveWallet(wallets: readonly WalletRow[]): WalletRow | undefined {
  let newest: WalletRow | undefined

  for (const wallet of wallets) {
    if (wallet.status !== 'ACTIVE') continue
    if (wallet.payment_token_id.startsWith('DEMO-')) continue
    if (wallet.payment_token_id.startsWith('SEED_PLACEHOLDER')) continue

    if (!newest) {
      newest = wallet
    } else {
      const walletTime = new Date(wallet.created_at).getTime()
      const newestTime = new Date(newest.created_at).getTime()
      if (walletTime > newestTime) {
        newest = wallet
      }
    }
  }

  return newest
}
