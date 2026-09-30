import { Wallet, verifyTypedData } from 'ethers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hmacSha256 } from '../src/lib/crypto.js';
import { centsToTokenUnits } from '../src/domain/web3.js';
import { client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

const platform = Wallet.createRandom();
let h: Harness;
beforeAll(async () => {
  h = await setup({
    ESCROW_SIGNER_PRIVATE_KEY: platform.privateKey,
    ESCROW_CONTRACT_ADDRESS: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    ESCROW_TOKEN_USDC: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  });
});
afterAll(async () => h.close());

const indexer = (body: object) => {
  const raw = JSON.stringify(body);
  return client(h.app).post('/v1/crypto/events', raw, {
    'content-type': 'application/json',
    'x-indexer-signature': hmacSha256(h.ctx.cfg.CRYPTO_INDEXER_SECRET, raw),
  });
};

describe('Web3 stablecoin escrow rail', () => {
  it('issues platform-signed EIP-712 terms and mirrors on-chain events into the order', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const sellerWallet = Wallet.createRandom();
    const buyerWallet = Wallet.createRandom();
    const addr = sellerWallet.address.toLowerCase();
    const link = await seller.api.post('/v1/me/wallet', {
      address: sellerWallet.address,
      signature: await sellerWallet.signMessage(`Link wallet ${addr} to marketplace account ${seller.id}`),
    });
    expect(link.status).toBe(200);
    expect((await seller.api.post('/v1/me/wallet', { address: sellerWallet.address, signature: await buyerWallet.signMessage('x') })).status).toBe(400);

    const offer = await makeOffer(seller, { categorySlug: 'accounts', priceCents: 250_00, deliveryMode: 'manual' });
    const created = await buyer.api.post('/v1/orders', { offerId: offer.id, rail: 'crypto', walletAddress: buyerWallet.address, acceptTos: true });
    expect(created.status).toBe(201);
    const orderId = created.body.order.id;

    const t = await buyer.api.get(`/v1/orders/${orderId}/crypto-terms?token=USDC&wallet=${buyerWallet.address}`);
    expect(t.status).toBe(200);
    expect(t.body.terms.milestoneBps).toEqual([3000, 7000]);
    expect(t.body.terms.feeBps).toBe(1299);
    expect(t.body.terms.amount).toBe(centsToTokenUnits(250_00).toString());
    expect(verifyTypedData(t.body.domain, t.body.types, t.body.terms, t.body.signature)).toBe(platform.address);

    // Fiat-only actions are refused for crypto orders.
    expect((await buyer.api.post(`/v1/orders/${orderId}/dispute`, { reason: 'this should be on-chain' })).body.error.code).toBe('onchain');

    expect((await client(h.app).post('/v1/crypto/events', JSON.stringify({ type: 'EscrowCreated' }), { 'content-type': 'application/json', 'x-indexer-signature': 'forged' })).status).toBe(401);
    expect((await indexer({ type: 'EscrowCreated', orderId, txHash: '0x1', amount: '1' })).status).toBe(400);
    expect((await indexer({ type: 'EscrowCreated', orderId, txHash: '0x1', amount: t.body.terms.amount })).body.status).toBe('paid');
    await seller.api.post(`/v1/orders/${orderId}/deliver`, { payload: 'creds' });
    expect((await indexer({ type: 'EscrowSettled', orderId, txHash: '0x2', outcome: 'released' })).body.status).toBe('completed');

    // No fiat ledger movement for on-chain escrow.
    const entries = await h.ctx.db.query('SELECT count(*)::int AS n FROM ledger_entries WHERE order_id = $1', [orderId]);
    expect(entries.rows[0].n).toBe(0);
  });
});
