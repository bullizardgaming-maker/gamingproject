import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LivePlatformAccounts } from '../src/providers/platformAccounts.js';
import { runJobsOnce } from '../src/worker.js';
import { buyAndPay, client, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

/** Start a link and follow the (mock) platform's redirect back to our callback. */
async function link(user: { api: any }, provider: 'steam' | 'riot', mockAccount: string) {
  const start = await user.api.post(`/v1/seller/linked-accounts/${provider}/start`, { mockAccount });
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  const u = new URL(start.body.url);
  const res = await h.app.inject({ method: 'GET', url: `${u.pathname}${u.search}` });
  return { status: res.statusCode, location: String(res.headers.location ?? ''), callback: `${u.pathname}${u.search}` };
}

describe('linked game accounts', () => {
  it('links by sign-in, shows a badge on account listings and refuses the wrong platform', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const done = await link(seller, 'steam', '76561198000000001');
    expect(done.status).toBe(302);
    expect(done.location).toMatch(/\/sell\?linked=steam$/);
    // The state is single-use.
    const again = await h.app.inject({ method: 'GET', url: done.callback });
    expect(String(again.headers.location)).toMatch(/link_error=link_expired/);

    const [acct] = (await seller.api.get('/v1/seller/linked-accounts')).body;
    expect(acct).toMatchObject({ provider: 'steam', display_name: 'Steam test 0001' });

    const base = { categorySlug: 'accounts', title: 'Prime account, 3k hours', priceCents: 80_00, deliveryMode: 'manual', linkedAccountId: acct.id };
    const wrong = await seller.api.post('/v1/offers', { ...base, game: 'Valorant', attributes: { region: 'Europe' } });
    expect(wrong.body.error.message).toMatch(/verified with Riot/);
    const ok = await seller.api.post('/v1/offers', { ...base, game: 'Counter-Strike 2' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const pub = (await client(h.app).get(`/v1/offers/${ok.body.id}`)).body;
    expect(pub).toMatchObject({ linked_platform: 'steam' });
    expect(new Date(pub.linked_account_created_at).getUTCFullYear()).toBe(2014);
    expect(JSON.stringify(pub)).not.toContain('Steam test 0001'); // the account name stays private

    // A second listing can't claim the same account.
    expect((await seller.api.post('/v1/offers', { ...base, game: 'Counter-Strike 2', title: 'Same account again' })).body.error.code).toBe('linked_account_in_use');
  });

  it('refuses an account another user holds, flags it, and releases it when the sale completes', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const other = await makeUser(h, { tier: 2 });
    await link(seller, 'riot', 'puuid-abc-123');
    const [acct] = (await seller.api.get('/v1/seller/linked-accounts')).body;

    const clash = await link(other, 'riot', 'puuid-abc-123');
    expect(clash.location).toMatch(/link_error=linked_elsewhere/);
    expect((await h.ctx.db.query(`SELECT reasons FROM risk_flags WHERE user_id = $1`, [other.id])).rows[0].reasons[0].code).toBe('platform_account_linked_elsewhere');

    const offer = (await seller.api.post('/v1/offers', { categorySlug: 'accounts', game: 'Valorant', title: 'Immortal 2, 40 skins', priceCents: 150_00, deliveryMode: 'manual', attributes: { region: 'Europe' }, linkedAccountId: acct.id })).body;
    // Staff see the linked account next to the owner proof.
    await seller.api.post(`/v1/offers/${offer.id}/owner-proof`, { registrationEmail: 'me@example.com', registrationDate: '2020-05-01', evidence: { note: 'x' } });
    const staff = await makeUser(h, { tier: 2, role: 'admin' });
    const queue = (await staff.api.get('/v1/admin/owner-proofs')).body;
    expect(queue.find((p: any) => p.offer_id === offer.id)).toMatchObject({ linked_platform: 'riot', linked_name: 'Riot test -123' });

    // Sold: escrow releases, the seller's link is released, and the buyer can link it.
    const buyer = await makeUser(h, { tier: 2 });
    const order = await buyAndPay(h, buyer, offer.id);
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'login:pass' });
    await h.ctx.db.query(`UPDATE orders SET protection_ends_at = now() - interval '1 minute' WHERE id = $1`, [order.id]);
    await runJobsOnce(h.ctx);
    expect((await seller.api.get('/v1/seller/linked-accounts')).body).toEqual([]);
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body.linked_platform).toBeNull();
    expect((await link(buyer, 'riot', 'puuid-abc-123')).location).toMatch(/linked=riot/);
  });

  it('unlinks on request and detaches listings', async () => {
    const seller = await makeUser(h, { tier: 2 });
    await link(seller, 'steam', '76561198000000099');
    const [acct] = (await seller.api.get('/v1/seller/linked-accounts')).body;
    const offer = (await seller.api.post('/v1/offers', { categorySlug: 'accounts', game: 'Dota 2', title: 'Divine 5 account', priceCents: 60_00, deliveryMode: 'manual', linkedAccountId: acct.id })).body;
    expect((await seller.api.del(`/v1/seller/linked-accounts/${acct.id}`)).body).toEqual([]);
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body.linked_platform).toBeNull();
  });
});

describe('Steam OpenID verification (live provider)', () => {
  const cb = 'https://api.example.com/v1/linked-accounts/steam/callback';
  const ret = (over: Record<string, string> = {}) => ({
    state: 's',
    'openid.mode': 'id_res',
    'openid.return_to': `${cb}?state=s`,
    'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561197960435530',
    'openid.sig': 'sig',
    ...over,
  });
  const fakeFetch = (valid: boolean, summary?: object) =>
    (async (url: string) =>
      String(url).includes('GetPlayerSummaries')
        ? new Response(JSON.stringify({ response: { players: summary ? [summary] : [] } }))
        : new Response(`ns:http://specs.openid.net/auth/2.0\nis_valid:${valid}\n`)) as unknown as typeof fetch;

  it('builds the sign-in URL and accepts only assertions Steam confirms', async () => {
    const live = new LivePlatformAccounts({}, fakeFetch(true));
    const url = new URL(live.authorizeUrl('steam', 'abc', cb));
    expect(url.origin + url.pathname).toBe('https://steamcommunity.com/openid/login');
    expect(url.searchParams.get('openid.return_to')).toBe(`${cb}?state=abc`);
    expect(url.searchParams.get('openid.realm')).toBe('https://api.example.com');
    expect(live.enabled('riot')).toBe(false); // needs an approved Riot app

    expect(await live.complete('steam', ret(), cb)).toMatchObject({ externalId: '76561197960435530', accountCreatedAt: null });
    await expect(new LivePlatformAccounts({}, fakeFetch(false)).complete('steam', ret(), cb)).rejects.toThrow(/did not confirm/);
    await expect(live.complete('steam', ret({ 'openid.return_to': 'https://evil.example/cb' }), cb)).rejects.toThrow(/not completed/);
    await expect(live.complete('steam', ret({ 'openid.claimed_id': 'https://evil.example/openid/id/1' }), cb)).rejects.toThrow(/unexpected account id/);

    const withKey = new LivePlatformAccounts({ steamApiKey: 'k' }, fakeFetch(true, { personaname: 'gabe', timecreated: 1063407589, profileurl: 'https://steamcommunity.com/id/gabe/' }));
    expect(await withKey.complete('steam', ret(), cb)).toMatchObject({ displayName: 'gabe', accountCreatedAt: new Date(1063407589 * 1000) });
  });
});
