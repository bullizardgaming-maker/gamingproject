/**
 * Proving control of a game-platform account by signing in to it.
 *  - Steam: OpenID 2.0 (no key needed). With STEAM_WEB_API_KEY we also read the profile name and
 *    the account's creation date.
 *  - Riot: Riot Sign On (OAuth 2.0); needs an approved app (RIOT_CLIENT_ID / RIOT_CLIENT_SECRET).
 *    Riot doesn't publish account creation dates.
 *  - Mock: completes immediately (development, tests, the sandbox).
 */
export type Platform = 'steam' | 'riot';
export const PLATFORMS: Platform[] = ['steam', 'riot'];

export interface PlatformIdentity {
  externalId: string;
  displayName: string;
  profileUrl: string | null;
  accountCreatedAt: Date | null;
}

export interface PlatformAccounts {
  readonly name: 'live' | 'mock';
  enabled(p: Platform): boolean;
  /** Where to send the browser; it comes back to `callbackUrl` with `state` and the provider's parameters. */
  authorizeUrl(p: Platform, state: string, callbackUrl: string, opts?: { mockAccount?: string }): string;
  /** Verify the return trip and say which account it was. Throws if it can't be verified. */
  complete(p: Platform, query: Record<string, string>, callbackUrl: string): Promise<PlatformIdentity>;
}

const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const STEAM_ID = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

export class LivePlatformAccounts implements PlatformAccounts {
  readonly name = 'live';
  constructor(
    private readonly opts: { steamApiKey?: string; riotClientId?: string; riotClientSecret?: string; riotAccountRegion?: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  enabled(p: Platform) {
    return p === 'steam' || !!(this.opts.riotClientId && this.opts.riotClientSecret);
  }

  authorizeUrl(p: Platform, state: string, callbackUrl: string) {
    const back = `${callbackUrl}?state=${encodeURIComponent(state)}`;
    if (p === 'steam') {
      const q = new URLSearchParams({
        'openid.ns': 'http://specs.openid.net/auth/2.0',
        'openid.mode': 'checkid_setup',
        'openid.return_to': back,
        'openid.realm': new URL(callbackUrl).origin,
        'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
        'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
      });
      return `${STEAM_OPENID}?${q}`;
    }
    const q = new URLSearchParams({ client_id: this.opts.riotClientId!, redirect_uri: callbackUrl, response_type: 'code', scope: 'openid', state });
    return `https://auth.riotgames.com/authorize?${q}`;
  }

  async complete(p: Platform, query: Record<string, string>, callbackUrl: string): Promise<PlatformIdentity> {
    if (p === 'steam') {
      // The return_to must be ours, and Steam itself must confirm the signed assertion.
      if (query['openid.mode'] !== 'id_res' || !String(query['openid.return_to'] ?? '').startsWith(callbackUrl)) throw new Error('Steam sign-in was not completed');
      const m = STEAM_ID.exec(query['openid.claimed_id'] ?? '');
      if (!m) throw new Error('Steam returned an unexpected account id');
      const check = new URLSearchParams(Object.entries(query).filter(([k]) => k.startsWith('openid.')));
      check.set('openid.mode', 'check_authentication');
      const res = await this.fetchImpl(STEAM_OPENID, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: check });
      if (!/is_valid\s*:\s*true/.test(await res.text())) throw new Error('Steam did not confirm the sign-in');
      const steamId = m[1]!;
      let displayName = `Steam ${steamId.slice(-4)}`;
      let createdAt: Date | null = null;
      let profileUrl: string | null = `https://steamcommunity.com/profiles/${steamId}`;
      if (this.opts.steamApiKey) {
        const r = await this.fetchImpl(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(this.opts.steamApiKey)}&steamids=${steamId}`);
        const player = ((await r.json().catch(() => ({}))) as any)?.response?.players?.[0];
        if (player) {
          displayName = String(player.personaname ?? displayName).slice(0, 80);
          profileUrl = player.profileurl ?? profileUrl;
          if (player.timecreated) createdAt = new Date(Number(player.timecreated) * 1000);
        }
      }
      return { externalId: steamId, displayName, profileUrl, accountCreatedAt: createdAt };
    }
    if (!query.code) throw new Error('Riot sign-in was not completed');
    const token = await this.fetchImpl('https://auth.riotgames.com/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${this.opts.riotClientId}:${this.opts.riotClientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: query.code, redirect_uri: callbackUrl }),
    });
    const access = ((await token.json().catch(() => ({}))) as any).access_token;
    if (!token.ok || !access) throw new Error('Riot did not confirm the sign-in');
    const region = this.opts.riotAccountRegion ?? 'europe';
    const me = await this.fetchImpl(`https://${region}.api.riotgames.com/riot/account/v1/accounts/me`, { headers: { authorization: `Bearer ${access}` } });
    const acct = (await me.json().catch(() => ({}))) as any;
    if (!me.ok || !acct.puuid) throw new Error('Riot account details are unavailable');
    return { externalId: acct.puuid, displayName: `${acct.gameName ?? 'Riot'}#${acct.tagLine ?? ''}`.slice(0, 80), profileUrl: null, accountCreatedAt: null };
  }
}

/** Completes without leaving the site. `mockAccount` picks the platform account id (tests). */
export class MockPlatformAccounts implements PlatformAccounts {
  readonly name = 'mock';
  enabled() {
    return true;
  }
  authorizeUrl(p: Platform, state: string, callbackUrl: string, opts: { mockAccount?: string } = {}) {
    const id = opts.mockAccount ?? `${p}-${state.slice(0, 8)}`;
    return `${callbackUrl}?${new URLSearchParams({ state, mock_account: id })}`;
  }
  async complete(p: Platform, query: Record<string, string>): Promise<PlatformIdentity> {
    if (!query.mock_account) throw new Error('Sign-in was not completed');
    return { externalId: query.mock_account, displayName: `${p === 'steam' ? 'Steam' : 'Riot'} test ${query.mock_account.slice(-4)}`, profileUrl: null, accountCreatedAt: new Date('2014-06-01T00:00:00Z') };
  }
}
