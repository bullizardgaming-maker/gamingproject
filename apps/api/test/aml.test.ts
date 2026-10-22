import { Wallet } from 'ethers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadList, nameKey, parseOfacSdn, parseSimpleList, rescreenSellers, runMonitoring } from '../src/domain/aml.js';
import { buyAndPay, client, makeOffer, makeUser, mockKyc, setup, type Harness } from './helpers.js';

let h: Harness;
const badWallet = Wallet.createRandom().address;

// Excerpt in OFAC's own sdn.csv / alt.csv format (no header, -0- for empty).
const SDN = [
  `36,"AEROCARIBBEAN AIRLINES",-0-,"CUBA",-0-,-0-,-0-,-0-,-0-,-0-,-0-,"Havana, Cuba."`,
  `7001,"PETROV, Ivan Sergeyevich","individual","CYBER2",-0-,-0-,-0-,-0-,-0-,-0-,-0-,"DOB 01 Jan 1980; Digital Currency Address - ETH ${badWallet}; alt. Digital Currency Address - XBT 1BoatSLRHtKNngkdXEeobR76b53LETtpyT;"`,
].join('\n');
const ALT = `7001,101,"aka","PETROFF, Ivan",-0-`;

beforeAll(async () => {
  h = await setup();
  const entries = [...parseOfacSdn(SDN, ALT), ...parseSimpleList('ref,kind,name,program\nEU-1,person,"Müller, Hans-Jürgen",EU_RUSSIA\n')];
  await loadList(h.ctx, 'test_list', entries, 'v1');
});
afterAll(async () => h.close());

async function compliance() {
  return makeUser(h, { role: 'compliance' });
}

describe('sanctions lists', () => {
  it('parses OFAC entries, aliases and published crypto addresses; names compare order- and accent-insensitively', () => {
    const e = parseOfacSdn(SDN, ALT);
    expect(e).toEqual(
      expect.arrayContaining([
        { ref: '36', kind: 'entity', name: 'AEROCARIBBEAN AIRLINES', program: 'CUBA' },
        { ref: '7001', kind: 'person', name: 'PETROV, Ivan Sergeyevich', program: 'CYBER2' },
        { ref: '7001', kind: 'person', name: 'PETROFF, Ivan', program: 'CYBER2' },
        { ref: '7001', kind: 'wallet', name: badWallet, program: 'CYBER2' },
        { ref: '7001', kind: 'wallet', name: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', program: 'CYBER2' },
      ]),
    );
    expect(nameKey('PETROV, Ivan Sergeyevich')).toBe(nameKey('Ivan Sergeyevich Petrov'));
    expect(nameKey('Hans-Jürgen Müller')).toBe(nameKey('MULLER, Hans Jurgen'));
  });
});

describe('screening', () => {
  it('pauses payouts for a strong match at identity verification, without saying why, until compliance clears it', async () => {
    const officer = await compliance();
    const u = await makeUser(h, { tier: 1 });
    const kyc = await u.api.post('/v1/kyc/start', { level: 'tier2_individual' });
    const payload = JSON.stringify({ externalId: kyc.body.externalId, status: 'approved', legalName: 'Ivan Sergeyevich Petrov' });
    await client(h.app).post('/v1/kyc/webhook/mock', payload, { 'content-type': 'application/json', 'x-mock-signature': mockKyc(h).sign(payload) });

    const { rows: [user] } = await h.ctx.db.query('SELECT aml_hold FROM users WHERE id = $1', [u.id]);
    expect(user.aml_hold).toBe(true);
    await h.ctx.db.query(`UPDATE users SET stripe_account_id = 'acct_x', payouts_enabled = true WHERE id = $1`, [u.id]);
    const w = await u.api.post('/v1/seller/withdrawals', { amountCents: 100 });
    expect(w.body.error).toMatchObject({ code: 'withdrawals_frozen', message: 'Withdrawals are paused while we complete a routine review' });
    expect(JSON.stringify((await u.api.get('/v1/me/notifications')).body)).not.toMatch(/aml|sanction|compliance/i);

    const cases = (await officer.api.get('/v1/admin/aml/cases?status=open')).body;
    const c = cases.find((x: any) => x.user_id === u.id);
    expect(c).toMatchObject({ rule: 'sanctions_legal_name', severity: 'high', holds_payouts: true });
    expect((await officer.api.get('/v1/me/notifications')).body.items.map((i: any) => i.template)).toContain('aml_case_opened');
    const detail = (await officer.api.get(`/v1/admin/aml/cases/${c.id}`)).body;
    expect(detail.screenings[0].matches[0]).toMatchObject({ ref: '7001', score: 1 });

    expect((await officer.api.post(`/v1/admin/aml/cases/${c.id}/decide`, { decision: 'clear', note: 'nope' })).body.error.code).toBe('reason_required');
    const cleared = await officer.api.post(`/v1/admin/aml/cases/${c.id}/decide`, { decision: 'clear', note: 'Different DOB and nationality on the ID document; false positive.' });
    expect(cleared.body.status).toBe('cleared');
    expect((await h.ctx.db.query('SELECT aml_hold FROM users WHERE id = $1', [u.id])).rows[0].aml_hold).toBe(false);
  });

  it('opens a review case (no pause) for weaker matches and ignores unrelated names', async () => {
    const near = await makeUser(h, { tier: 2 });
    await h.ctx.db.query(`UPDATE users SET legal_name = 'Hans-Jürgen Mueller' WHERE id = $1`, [near.id]); // ~0.77 vs "Müller, Hans-Jürgen"
    const clean = await makeUser(h, { tier: 2 });
    await h.ctx.db.query(`UPDATE users SET legal_name = 'Maria Garcia Lopez' WHERE id = $1`, [clean.id]);
    await rescreenSellers(h.ctx);
    const { rows } = await h.ctx.db.query('SELECT user_id, severity, holds_payouts FROM aml_cases WHERE user_id = ANY($1)', [[near.id, clean.id]]);
    expect(rows.filter((r) => r.user_id === clean.id)).toEqual([]);
    expect(rows.find((r) => r.user_id === near.id)).toMatchObject({ severity: 'medium', holds_payouts: false });
    expect((await h.ctx.db.query('SELECT aml_hold FROM users WHERE id = $1', [near.id])).rows[0].aml_hold).toBe(false);
    // A second rescreen against the same list version does nothing.
    expect(await rescreenSellers(h.ctx)).toBe(0);
  });

  it('refuses crypto deposits from a sanctioned wallet and flags linked seller wallets', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller);
    const res = await buyer.api.post('/v1/orders', { offerId: offer.id, rail: 'crypto', walletAddress: badWallet, acceptTos: true });
    expect(res.body.error).toMatchObject({ code: 'payment_declined' });
    expect((await h.ctx.db.query(`SELECT rule FROM aml_cases WHERE user_id = $1`, [buyer.id])).rows[0].rule).toBe('sanctions_payment_wallet');
  });
});

describe('transaction monitoring & case workflow', () => {
  it('flags one buyer funding one seller, lets compliance record a SAR, and keeps payouts paused', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 5, priceCents: 2_000_00 });
    for (let i = 0; i < 3; i++) await buyAndPay(h, buyer, offer.id); // $6,000 in a brand-new shop, all from one buyer

    const opened = await runMonitoring(h.ctx);
    const rules = opened.filter((o) => o.userId === seller.id).map((o) => o.rule).sort();
    expect(rules).toEqual(['buyer_concentration', 'new_account_high_value', 'volume_spike']);
    expect((await runMonitoring(h.ctx)).filter((o) => o.userId === seller.id)).toEqual([]); // no duplicates

    const officer = await compliance();
    const c = (await officer.api.get('/v1/admin/aml/cases?status=open')).body.find((x: any) => x.user_id === seller.id && x.rule === 'buyer_concentration');
    expect(c.holds_payouts).toBe(false);
    await officer.api.post(`/v1/admin/aml/cases/${c.id}/notes`, { note: 'Buyer and seller share a surname; requested source of funds.' });
    expect((await officer.api.post(`/v1/admin/aml/cases/${c.id}/decide`, { decision: 'escalate', note: 'No answer in 7 days' })).body.status).toBe('escalated');
    expect((await officer.api.post(`/v1/admin/aml/cases/${c.id}/decide`, { decision: 'report', note: 'Filing' })).body.error.code).toBe('sar_reference_required');

    // Only people with aml.sar can record a report; finance can't see cases at all.
    const finance = await makeUser(h, { role: 'finance' });
    expect((await finance.api.get('/v1/admin/aml/cases')).status).toBe(403);
    const reported = await officer.api.post(`/v1/admin/aml/cases/${c.id}/decide`, { decision: 'report', note: 'SAR filed with the FIU', sarReference: 'FIU-2026-00042' });
    expect(reported.body).toMatchObject({ status: 'reported', sar_reference: 'FIU-2026-00042', holds_payouts: true });
    expect((await h.ctx.db.query('SELECT aml_hold FROM users WHERE id = $1', [seller.id])).rows[0].aml_hold).toBe(true);
    expect(reported.body.notes.map((n: any) => n.decision ?? 'note')).toEqual(['note', 'escalate', 'report']);

    // The subject can't erase their account while under review (and isn't told why).
    const del = await seller.api.post('/v1/me/delete', { password: 'correct horse battery' });
    expect(del.body.error).toMatchObject({ code: 'cannot_close_now' });
  });
});
