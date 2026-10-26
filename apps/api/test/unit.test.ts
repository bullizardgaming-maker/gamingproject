import { describe, expect, it } from 'vitest';
import { grossUp, nextRank, rankForVolume, splitGross } from '../src/domain/commission.js';
import { classify } from '../src/domain/chargebacks.js';
import { detectOffPlatform } from '../src/domain/chat.js';
import { subnetOf } from '../src/domain/fraud.js';
import { parseBulkUpload } from '../src/domain/inventory.js';
import { isPrivateAddress } from '../src/lib/netguard.js';
import { Keyring, hashPassword, verifyPassword } from '../src/lib/crypto.js';
import { createHmac } from 'node:crypto';
import { describeUserAgent } from '../src/domain/sessions.js';

describe('commission: ranks and gross-up', () => {
  const ranks = [
    { position: 1, name: 'Hatchling', minMonthlySalesCents: 0, rateBps: 1399, perks: [] },
    { position: 2, name: 'Scale', minMonthlySalesCents: 500_00, rateBps: 1299, perks: [] },
    { position: 3, name: 'Fang', minMonthlySalesCents: 2_000_00, rateBps: 1199, perks: [] },
    { position: 4, name: 'Basilisk', minMonthlySalesCents: 5_000_00, rateBps: 1099, perks: [] },
    { position: 5, name: 'Dragon', minMonthlySalesCents: 15_000_00, rateBps: 999, perks: [] },
  ];
  it('maps monthly volume to ranks', () => {
    expect(rankForVolume(ranks, 0).name).toBe('Hatchling');
    expect(rankForVolume(ranks, 499_99).name).toBe('Hatchling');
    expect(rankForVolume(ranks, 500_00).name).toBe('Scale');
    expect(rankForVolume(ranks, 2_000_00).name).toBe('Fang');
    expect(rankForVolume(ranks, 5_000_00).name).toBe('Basilisk');
    expect(rankForVolume(ranks, 15_000_00).name).toBe('Dragon');
    expect(rankForVolume(ranks, 1e9).name).toBe('Dragon');
    expect(nextRank(ranks, ranks[4]!)).toBeNull();
    expect(nextRank(ranks, ranks[0]!)!.name).toBe('Scale');
  });

  it('grosses the commission up on top of the seller price, never short-changing the seller', () => {
    // The master plan's example: $10 → $11.63 at 13.99%, $10.53 in the 5% promo.
    expect(grossUp(10_00, 1399)).toBe(11_63);
    expect(grossUp(10_00, 500)).toBe(10_53);
    for (const seller of [1, 99, 1000, 12345, 999_999]) {
      for (const bps of [500, 999, 1399]) {
        const buyer = grossUp(seller, bps);
        const s = splitGross(buyer, seller);
        expect(s.sellerNetCents).toBe(seller);
        expect(s.commissionCents + s.sellerNetCents).toBe(buyer);
        expect(s.commissionCents).toBeGreaterThanOrEqual(Math.floor((buyer * bps) / 10_000) - 1);
      }
    }
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

describe('network guard', () => {
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
    // Launch rules: more platforms, disguised spellings, emails, links, handles and "add me".
    expect(detectOffPlatform('hit me on fb messenger')).toContain('facebook');
    expect(detectOffPlatform('my insta is gamer_99')).toEqual(expect.arrayContaining(['instagram', 'add_me']));
    expect(detectOffPlatform('d1scord: gamer#1234')).toContain('discord');
    expect(detectOffPlatform('d i s c o r d')).toContain('discord');
    expect(detectOffPlatform('t.e.l.e.g.r.a.m me')).toContain('telegram');
    expect(detectOffPlatform('mail me at john.doe@gmail.com')).toEqual(['email']);
    expect(detectOffPlatform('check my shop at cheapgold.net')).toEqual(['link']);
    expect(detectOffPlatform('see https://bullizard.com/orders/1')).toEqual([]); // our own links are fine
    expect(detectOffPlatform('msg @cheapgold on tele')).toEqual(expect.arrayContaining(['telegram', 'handle']));
    expect(detectOffPlatform('hmu')).toEqual([]); // Round 22: "hmu" alone is chat; "hit me up on dc" is not
    expect(detectOffPlatform('hit me up on dc')).toEqual(expect.arrayContaining(['discord', 'add_me']));
    expect(detectOffPlatform('ضيفني على واتس')).toEqual(expect.arrayContaining(['whatsapp', 'add_me']));
    // Account handovers may carry the account's email; nothing else may.
    expect(detectOffPlatform('Login: knight@proton.me Password: hunter2')).toEqual(['email']);
    expect(detectOffPlatform('Login: knight@proton.me Password: hunter2', { allowEmail: true })).toEqual([]);
    for (const clean of ['The sword is 450 gold', 'I will deliver in 10 minutes, please be online at 3 p.m.', 'server: Stormrage, faction: Alliance', 'Meet at the bank in Caerleon', 'Traded 100 divines, thanks!']) {
      expect(detectOffPlatform(clean), clean).toEqual([]);
    }
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
