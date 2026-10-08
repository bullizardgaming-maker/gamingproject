import { describe, expect, it } from 'vitest';
import { commissionBps, splitAmount, tierForVolume } from '../src/domain/commission.js';
import { classify } from '../src/domain/chargebacks.js';
import { detectOffPlatform } from '../src/domain/chat.js';
import { subnetOf } from '../src/domain/fraud.js';
import { parseBulkUpload } from '../src/domain/inventory.js';
import { backoffSeconds, isPrivateAddress, signPayload } from '../src/domain/webhooks.js';
import { Keyring, hashPassword, verifyPassword } from '../src/lib/crypto.js';
import { createHmac } from 'node:crypto';
import { describeUserAgent } from '../src/domain/sessions.js';

describe('tiered commission', () => {
  it('maps monthly volume to tiers', () => {
    expect(tierForVolume(0).name).toBe('Normal');
    expect(tierForVolume(299_99).name).toBe('Normal');
    expect(tierForVolume(300_00).name).toBe('Common');
    expect(tierForVolume(1_000_00).name).toBe('Uncommon');
    expect(tierForVolume(5_000_00).name).toBe('Rare');
    expect(tierForVolume(10_000_00).name).toBe('Epic');
    expect(tierForVolume(20_000_00).name).toBe('Legendary');
    expect(tierForVolume(1e9).name).toBe('Legendary');
  });

  it('applies account vs other vs promo rates', () => {
    const normal = tierForVolume(0);
    const legendary = tierForVolume(20_000_00);
    expect(commissionBps(normal, { kind: 'account', promo_rate_bps: null })).toBe(1299);
    expect(commissionBps(normal, { kind: 'currency', promo_rate_bps: null })).toBe(999);
    expect(commissionBps(legendary, { kind: 'account', promo_rate_bps: null })).toBe(799);
    expect(commissionBps(legendary, { kind: 'item', promo_rate_bps: null })).toBe(499);
    expect(commissionBps(normal, { kind: 'gift_card', promo_rate_bps: 499 })).toBe(499);
  });

  it('splits without losing a cent', () => {
    for (const amount of [1, 99, 1000, 12345, 999_999]) {
      for (const bps of [499, 999, 1299]) {
        const s = splitAmount(amount, bps);
        expect(s.commissionCents + s.sellerNetCents).toBe(amount);
      }
    }
    expect(splitAmount(10_000, 1299)).toEqual({ commissionCents: 1299, sellerNetCents: 8701 });
  });
});

describe('crypto', () => {
  it('encrypts with AES-256-GCM, supports rotation, detects tampering', () => {
    const k1 = Buffer.alloc(32, 1).toString('base64');
    const k2 = Buffer.alloc(32, 2).toString('base64');
    const old = new Keyring(`v1:${k1}`);
    const ct = old.encrypt('ABCD-1234', 'aad');
    const rotated = new Keyring(`v1:${k1},v2:${k2}`);
    expect(rotated.decrypt(ct, 'aad')).toBe('ABCD-1234');
    expect(rotated.encrypt('x').startsWith('v2:')).toBe(true);
    expect(() => rotated.decrypt(ct, 'other-aad')).toThrow();
    const parts = ct.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => rotated.decrypt(parts.join(':'), 'aad')).toThrow();
  });

  it('hashes passwords with scrypt', async () => {
    const h = await hashPassword('hunter2hunter2');
    expect(await verifyPassword('hunter2hunter2', h)).toBe(true);
    expect(await verifyPassword('wrong-password', h)).toBe(false);
  });
});

describe('webhooks', () => {
  it('signs the raw body with HMAC-SHA256 (merchant-side verification)', () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'order.created' });
    const sig = signPayload('whsec_test', body);
    expect(sig).toBe(createHmac('sha256', 'whsec_test').update(body).digest('hex'));
  });

  it('backs off exponentially with a cap', () => {
    const mid = () => 0.5;
    expect(backoffSeconds(1, mid)).toBe(30);
    expect(backoffSeconds(2, mid)).toBe(60);
    expect(backoffSeconds(5, mid)).toBe(480);
    expect(backoffSeconds(20, mid)).toBe(6 * 3600);
  });

  it('blocks private destinations (SSRF)', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.4', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
});

describe('misc domain helpers', () => {
  it('parses bulk uploads', () => {
    expect(parseBulkUpload('txt', 'AAA\r\n\nBBB\n  CCC  \n')).toEqual(['AAA', 'BBB', 'CCC']);
    expect(parseBulkUpload('json', '["k1", {"login":"a","password":"b"}]')).toEqual(['k1', '{"login":"a","password":"b"}']);
    expect(() => parseBulkUpload('json', '{"not":"array"}')).toThrow();
    expect(() => parseBulkUpload('txt', '\n\n')).toThrow();
  });

  it('detects off-platform contact attempts', () => {
    expect(detectOffPlatform('add me on discord pls')).toContain('discord');
    expect(detectOffPlatform('t.me/seller123 cheaper')).toContain('telegram');
    expect(detectOffPlatform('call +1 415 555 0123')).toContain('phone_number');
    expect(detectOffPlatform('pay via cashapp instead')).toContain('external_payment');
    expect(detectOffPlatform('Thanks, code works!')).toEqual([]);
  });

  it('collapses IPs to subnets', () => {
    expect(subnetOf('203.0.113.77')).toBe('203.0.113.0/24');
    expect(subnetOf('::ffff:203.0.113.77')).toBe('203.0.113.0/24');
    expect(subnetOf('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
  });

  it('classifies chargeback reason codes', () => {
    expect(classify('visa', '10.4').category).toBe('fraud');
    expect(classify('mastercard', '4837').category).toBe('fraud');
    expect(classify('visa', '13.3').category).toBe('not_as_described');
    expect(classify('visa', '13.6').category).toBe('credit_not_processed');
    expect(classify('mastercard', '4853', 'credit_not_processed').category).toBe('credit_not_processed');
  });
});

describe('device labels', () => {
  it('summarises user agents', () => {
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36')).toBe('Chrome on Windows');
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1')).toBe('Safari on iOS');
    expect(describeUserAgent(null)).toBe('Unknown device');
  });
});
