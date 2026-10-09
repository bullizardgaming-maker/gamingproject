import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { SigningKey, Wallet, getBytes, verifyTypedData } from 'ethers';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createContext, type Ctx } from '../src/context.js';
import { revealDelivered } from '../src/domain/inventory.js';
import { TEXT_TARGETS, keyStatus, rotateAll } from '../src/domain/keyrotation.js';
import { readAttachment } from '../src/domain/attachments.js';
import { MemoryPubSub } from '../src/lib/pubsub.js';
import { AwsKmsSigner, parseDerSignature } from '../src/providers/signer.js';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';

const v1 = `v1:${randomBytes(32).toString('base64')}`;
const v2 = `v2:${randomBytes(32).toString('base64')}`;
const STORAGE_DIR = `./data/test-keys-${Date.now()}`;
const silent = { info() {}, warn() {}, error() {} };

let h: Harness;
beforeAll(async () => {
  h = await setup({ DATA_ENCRYPTION_KEYS: v1, STORAGE_DIR });
});
afterAll(async () => {
  await h.close();
  await rm(STORAGE_DIR, { recursive: true, force: true });
});

const ctxWith = (keys: string): Ctx =>
  createContext(loadConfig({ DATA_ENCRYPTION_KEYS: keys, STORAGE_DIR, TRUST_PROXY: 'true' } as any), silent, { db: h.ctx.db, pubsub: new MemoryPubSub() });

describe('data key rotation', () => {
  it('re-encrypts every field and file under the new key, after which the old key can go', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller);
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'ROTATE-ME-1' });
    const order = await buyAndPay(h, buyer, offer.id);
    await seller.api.post('/v1/developer/webhooks', { url: 'https://merchant.example/hook', events: ['order.created'] });
    await seller.api.post('/v1/me/2fa/setup');
    const account = await makeOffer(seller, { categorySlug: 'accounts', deliveryMode: 'manual', stock: 1 });
    await seller.api.post(`/v1/offers/${account.id}/owner-proof`, { registrationEmail: 'orig@example.com', registrationDate: '2019-01-01', evidence: { answer: 'blue' } });
    const room = (await buyer.api.get(`/v1/orders/${order.id}`)).body.room_id;
    const img = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00aa00' } }).png().toBuffer();
    const att = await buyer.api.post(`/v1/chat/rooms/${room}/attachments`, img, { 'content-type': 'image/png', 'x-filename': 'a.png' });
    expect(att.status).toBe(201);

    // Deploy with v2 appended: new data uses v2, old data is still readable via v1.
    const both = ctxWith(`${v1},${v2}`);
    const before = await keyStatus(both);
    expect(before.current).toBe('v2');
    expect(before.remaining).toBeGreaterThanOrEqual(5);
    expect(before.safeToRemove).toEqual([]);

    const done = await rotateAll(both);
    expect(done).toMatchObject({ inventory_items: 1, webhook_secrets: 1, totp_secrets: 1, owner_proof_evidence: 1, chat_files: 1 });
    const after = await keyStatus(both);
    expect(after.remaining).toBe(0);
    expect(after.safeToRemove).toEqual(['v1']);

    // With v1 gone entirely, everything still decrypts.
    const onlyV2 = ctxWith(v2);
    expect((await revealDelivered(onlyV2, order.id))[0]!.content).toBe('ROTATE-ME-1');
    const { rows: [ep] } = await h.ctx.db.query('SELECT secret_ciphertext FROM webhook_endpoints WHERE user_id = $1', [seller.id]);
    expect(onlyV2.keyring.decrypt(ep.secret_ciphertext, 'webhook')).toMatch(/^whsec_/);
    const { rows: [u] } = await h.ctx.db.query('SELECT totp_secret_ciphertext FROM users WHERE id = $1', [seller.id]);
    expect(onlyV2.keyring.decrypt(u.totp_secret_ciphertext, `totp:${seller.id}`)).toMatch(/^[A-Z2-7]+$/);
    const { rows: [p] } = await h.ctx.db.query(`SELECT evidence->>'sealed' AS s FROM owner_proofs WHERE offer_id = $1`, [account.id]);
    expect(JSON.parse(onlyV2.keyring.decrypt(p.s, `owner_proof:${account.id}`))).toEqual({ answer: 'blue' });
    const file = await readAttachment(onlyV2, att.body.id, { id: buyer.id, role: 'user' } as any);
    expect(file.bytes.subarray(1, 4).toString()).toBe('PNG');

    // A second run has nothing to do.
    expect(Object.values(await rotateAll(both)).every((n) => n === 0)).toBe(true);
  });

  it('knows about every encrypted column in the schema', async () => {
    const { rows } = await h.ctx.db.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name LIKE '%ciphertext%'`,
    );
    const registered = new Set(TEXT_TARGETS.map((t) => `${t.table}.${t.column}`));
    for (const r of rows) expect(registered, `${r.table_name}.${r.column_name} is encrypted but not rotated`).toContain(`${r.table_name}.${r.column_name}`);
  });
});

/** Stand-in for AWS KMS holding a secp256k1 key: returns SPKI public keys and DER signatures. */
function fakeKms(key: SigningKey, opts: { highS?: boolean } = {}) {
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const derInt = (v: bigint) => {
    let hex = v.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    if (parseInt(hex.slice(0, 2), 16) & 0x80) hex = '00' + hex;
    return Buffer.concat([Buffer.from([0x02, hex.length / 2]), Buffer.from(hex, 'hex')]);
  };
  const calls: string[] = [];
  return {
    calls,
    async send(cmd: any) {
      const name = cmd.constructor.name;
      calls.push(name);
      if (name === 'GetPublicKeyCommand') {
        const spki = Buffer.concat([Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex'), Buffer.from(getBytes(key.publicKey))]);
        return { KeySpec: 'ECC_SECG_P256K1', PublicKey: new Uint8Array(spki) };
      }
      if (name === 'SignCommand') {
        expect(cmd.input).toMatchObject({ MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' });
        const sig = key.sign(cmd.input.Message);
        let s = BigInt(sig.s);
        if (opts.highS) s = N - s; // KMS may return either form
        const body = Buffer.concat([derInt(BigInt(sig.r)), derInt(s)]);
        return { Signature: new Uint8Array(Buffer.concat([Buffer.from([0x30, body.length]), body])) };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
}

describe('escrow signer in KMS', () => {
  it('signs EIP-712 escrow terms the contract will accept, including high-s KMS signatures', async () => {
    const key = new SigningKey(Wallet.createRandom().privateKey);
    const expected = new Wallet(key.privateKey).address;
    for (const highS of [false, true]) {
      const kms = fakeKms(key, { highS });
      const signer = new AwsKmsSigner('alias/escrow', kms as any);
      expect(await signer.address()).toBe(expected);
      const domain = { name: 'MarketEscrow', version: '1', chainId: 31337, verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3' };
      const types = { Terms: [{ name: 'orderId', type: 'bytes32' }, { name: 'amount', type: 'uint256' }] };
      const value = { orderId: '0x' + '11'.repeat(32), amount: '2500000' };
      const sig = await signer.signTypedData(domain, types, value);
      expect(verifyTypedData(domain, types, value, sig)).toBe(expected);
      // Low-s form, as Ethereum requires.
      const s = BigInt('0x' + sig.slice(66, 130));
      expect(s <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n).toBe(true);
      expect(kms.calls.filter((c) => c === 'GetPublicKeyCommand')).toHaveLength(1);
    }
  });

  it('parses DER signatures with long-form lengths', () => {
    const r = 0x1234n;
    const s = 0x80n; // high bit set: needs a leading zero byte
    const der = Buffer.from('3008020212340202' + '0080', 'hex');
    expect(parseDerSignature(der)).toEqual({ r, s });
  });

  it('refuses a private key in production unless explicitly allowed', () => {
    const base = { NODE_ENV: 'production', MALWARE_SCANNER: 'clamd', PLATFORM_ACCOUNTS: 'live', JWT_SECRET: 'x'.repeat(40), ESCROW_SIGNER_PRIVATE_KEY: Wallet.createRandom().privateKey } as any;
    expect(() => loadConfig(base)).toThrow(/aws_kms/);
    expect(() => loadConfig({ ...base, ESCROW_SIGNER: 'aws_kms' })).toThrow(/ESCROW_KMS_KEY_ID/);
  });
});
