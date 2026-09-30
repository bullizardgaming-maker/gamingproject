import { Wallet, getAddress, id as keccakId } from 'ethers';
import type { Ctx } from '../context.js';
import { badRequest } from '../lib/errors.js';
import type { Order } from './orders.js';

/** Stablecoins use 6 decimals; order amounts are cents. */
export const centsToTokenUnits = (cents: number) => BigInt(cents) * 10_000n;

export const orderIdToBytes32 = (orderId: string) => keccakId(orderId);

const DAY = 24 * 3600;

/**
 * Release schedule per category. Each milestone has a share (bps) and a delay:
 * once the seller marks it delivered, the seller may claim it after `delay`
 * seconds unless the buyer disputes (or the buyer approves early).
 *
 *   accounts: 30% on credential delivery, 70% after the 14-day insurance window
 *   boosting: four equal stages, each with a 72h inspection
 *   default : 100% after the 72h inspection window
 */
export function milestonesFor(categoryKind: string): { bps: number[]; delays: number[] } {
  if (categoryKind === 'account') return { bps: [3000, 7000], delays: [0, 14 * DAY] };
  if (categoryKind === 'boosting') return { bps: [2500, 2500, 2500, 2500], delays: [3 * DAY, 3 * DAY, 3 * DAY, 3 * DAY] };
  return { bps: [10000], delays: [3 * DAY] };
}

export const ESCROW_TYPES = {
  Terms: [
    { name: 'orderId', type: 'bytes32' },
    { name: 'buyer', type: 'address' },
    { name: 'seller', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'feeBps', type: 'uint16' },
    { name: 'milestoneBps', type: 'uint16[]' },
    { name: 'milestoneDelays', type: 'uint64[]' },
    { name: 'deliveryDeadline', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
  ],
};

/**
 * Build EIP-712 escrow terms signed by the platform. The contract only accepts
 * deposits whose terms (seller, amount, fee, schedule) carry this signature, so
 * a buyer cannot lower the fee or redirect funds.
 */
export async function buildEscrowTerms(
  ctx: Ctx,
  order: Order & { category_kind: string },
  buyerWallet: string,
  sellerWallet: string | null,
  token: 'USDC' | 'USDT',
) {
  if (!ctx.cfg.ESCROW_SIGNER_PRIVATE_KEY) throw badRequest('crypto_disabled', 'Crypto escrow is not configured');
  if (!sellerWallet) throw badRequest('seller_no_wallet', 'Seller has not linked a payout wallet');
  const { bps, delays } = milestonesFor(order.category_kind);
  const now = Math.floor(Date.now() / 1000);
  const terms = {
    orderId: orderIdToBytes32(order.id),
    buyer: getAddress(buyerWallet),
    seller: getAddress(sellerWallet),
    token: getAddress(token === 'USDC' ? ctx.cfg.ESCROW_TOKEN_USDC : ctx.cfg.ESCROW_TOKEN_USDT),
    amount: centsToTokenUnits(order.amount_cents).toString(),
    feeBps: order.commission_bps,
    milestoneBps: bps,
    milestoneDelays: delays,
    deliveryDeadline: now + 3 * DAY,
    expiry: now + ctx.cfg.ORDER_PAYMENT_TTL_MINUTES * 60,
  };
  const domain = {
    name: 'MarketEscrow',
    version: '1',
    chainId: ctx.cfg.ESCROW_CHAIN_ID,
    verifyingContract: getAddress(ctx.cfg.ESCROW_CONTRACT_ADDRESS),
  };
  const signature = await new Wallet(ctx.cfg.ESCROW_SIGNER_PRIVATE_KEY).signTypedData(domain, ESCROW_TYPES, terms);
  return { domain, types: ESCROW_TYPES, terms, signature };
}
