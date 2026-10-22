import { Contract, JsonRpcProvider, type EventLog } from 'ethers';
import type { Ctx } from './context.js';
import { maybeOne } from './db.js';
import { handleChainEvent, type ChainEvent } from './domain/orders.js';

const ABI = [
  'event EscrowCreated(bytes32 indexed orderId, address indexed buyer, address indexed seller, address token, uint256 amount)',
  'event DisputeOpened(bytes32 indexed orderId, address indexed by, bytes32 evidenceHash, uint64 drawBlock)',
  'event EscrowSettled(bytes32 indexed orderId, uint8 outcome)',
];
const OUTCOMES = ['released', 'refunded', 'split'] as const;
const CONFIRMATIONS = 3;

/**
 * Polls the MarketEscrow contract and mirrors its lifecycle into orders:
 * EscrowCreated -> paid (+ auto-delivery), DisputeOpened -> disputed,
 * EscrowSettled -> completed / refunded. Only blocks with CONFIRMATIONS
 * confirmations are processed; handlers are idempotent so replays are safe.
 */
export function startIndexer(ctx: Ctx, intervalMs = 5_000) {
  if (!ctx.cfg.ESCROW_RPC_URL) return () => {};
  const provider = new JsonRpcProvider(ctx.cfg.ESCROW_RPC_URL);
  const contract = new Contract(ctx.cfg.ESCROW_CONTRACT_ADDRESS, ABI, provider);
  let from = ctx.cfg.ESCROW_START_BLOCK;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const head = (await provider.getBlockNumber()) - CONFIRMATIONS;
      if (head < from) return;
      const to = Math.min(head, from + 2_000);
      const logs = (await contract.queryFilter('*', from, to)) as EventLog[];
      for (const log of logs) {
        const chainRef = log.args[0] as string;
        const order = await maybeOne<{ id: string }>(ctx.db, `SELECT id FROM orders WHERE payment_provider = 'escrow_contract' AND payment_ref = $1`, [chainRef]);
        if (!order) continue;
        let ev: ChainEvent | null = null;
        if (log.eventName === 'EscrowCreated') ev = { type: 'EscrowCreated', orderId: order.id, txHash: log.transactionHash, amount: (log.args[4] as bigint).toString() };
        if (log.eventName === 'DisputeOpened') ev = { type: 'DisputeOpened', orderId: order.id, txHash: log.transactionHash };
        if (log.eventName === 'EscrowSettled') ev = { type: 'EscrowSettled', orderId: order.id, txHash: log.transactionHash, outcome: OUTCOMES[Number(log.args[1])]! };
        if (ev) await handleChainEvent(ctx, ev).catch((err) => ctx.log.error({ err: err.message, ev }, 'chain event failed'));
      }
      from = to + 1;
    } catch (err) {
      ctx.log.warn({ err: (err as Error).message }, 'indexer tick failed');
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
