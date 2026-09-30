import { randomUUID } from 'node:crypto';
import type { Queryable, Tx } from '../db.js';
import { one } from '../db.js';

export type AccountKind =
  | 'gateway_clearing'
  | 'escrow'
  | 'treasury'
  | 'reserve'
  | 'seller_available'
  | 'payouts'
  | 'platform_withdrawals'
  | 'user_credit'
  | 'fx_pnl'
  | 'tax_payable'
  | 'fx_position'
  | 'fx_conversion';

/**
 * Double-entry ledger. Every posting is a set of entries sharing a txn_id whose
 * amounts sum to zero. Balances are derived, never stored, so they cannot drift.
 *
 *   gateway_clearing  money the PSP has captured on our behalf (negative = owed to us)
 *   escrow            buyer funds held pending delivery/inspection (segregated)
 *   treasury          platform commission revenue
 *   reserve           chargeback reserve that absorbs losses sellers cannot cover
 *   seller_available  seller balance eligible for withdrawal
 *   payouts           funds sent out to sellers' external accounts
 */
/**
 * Find (or create) a ledger account. A plain read first: an upsert would take a row
 * lock on shared accounts (escrow, gateway) until the surrounding transaction ends
 * and serialize every concurrent payment behind it. Only a missing account is inserted.
 */
export async function accountId(q: Queryable, kind: AccountKind, currency: string, ownerId: string | null = null): Promise<string> {
  const find = () =>
    q.query<{ id: string }>('SELECT id FROM ledger_accounts WHERE owner_id IS NOT DISTINCT FROM $1 AND kind = $2 AND currency = $3', [ownerId, kind, currency]);
  let row = (await find()).rows[0];
  if (!row) {
    await q.query('INSERT INTO ledger_accounts (owner_id, kind, currency) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [ownerId, kind, currency]);
    row = (await find()).rows[0];
    if (!row) throw new Error(`ledger account ${kind}/${currency} could not be created`);
  }
  return row.id;
}

export interface Posting {
  account: string;
  amountCents: number;
}

export async function post(tx: Tx, postings: Posting[], memo: string, orderId: string | null = null): Promise<string> {
  const sum = postings.reduce((s, p) => s + p.amountCents, 0);
  if (sum !== 0) throw new Error(`unbalanced ledger posting (${sum}) for ${memo}`);
  const txnId = randomUUID();
  for (const p of postings) {
    if (p.amountCents === 0) continue;
    await tx.query(
      'INSERT INTO ledger_entries (txn_id, account_id, amount_cents, order_id, memo) VALUES ($1, $2, $3, $4, $5)',
      [txnId, p.account, p.amountCents, orderId, memo],
    );
  }
  return txnId;
}

export async function balance(q: Queryable, account: string): Promise<number> {
  const row = await one<{ b: number }>(q, 'SELECT COALESCE(SUM(amount_cents), 0)::bigint AS b FROM ledger_entries WHERE account_id = $1', [account]);
  return row.b;
}

export async function orderEscrowBalance(q: Queryable, orderId: string, currency: string): Promise<number> {
  const escrow = await accountId(q, 'escrow', currency);
  const row = await one<{ b: number }>(
    q,
    'SELECT COALESCE(SUM(amount_cents), 0)::bigint AS b FROM ledger_entries WHERE account_id = $1 AND order_id = $2',
    [escrow, orderId],
  );
  return row.b;
}

export async function userCredit(q: Queryable, userId: string, currency = 'USD'): Promise<number> {
  return balance(q, await accountId(q, 'user_credit', currency, userId));
}

export async function sellerAvailable(q: Queryable, sellerId: string, currency = 'USD'): Promise<number> {
  return balance(q, await accountId(q, 'seller_available', currency, sellerId));
}
