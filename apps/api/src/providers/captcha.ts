/**
 * Bot checks for sign-up, password reset and repeated failed sign-ins.
 * The browser solves a widget (Cloudflare Turnstile or hCaptcha) and sends the
 * resulting token; we confirm it with the provider's siteverify endpoint.
 */
/** What the token must have been issued for (Turnstile reports both; Round 23b). */
export interface CaptchaExpect {
  action?: 'signin' | 'signup' | 'reset';
  /** The web host the widget ran on (PUBLIC_WEB_URL's host). */
  hostname?: string;
}

export interface CaptchaVerifier {
  readonly enabled: boolean;
  verify(token: string | undefined, ip?: string, expect?: CaptchaExpect): Promise<boolean>;
}

/** Captcha turned off (development, or deployments that rely on other bot controls). */
export class NoCaptcha implements CaptchaVerifier {
  readonly enabled = false;
  async verify() {
    return true;
  }
}

/** Test double: accepts exactly one token value. */
export class FakeCaptcha implements CaptchaVerifier {
  readonly enabled = true;
  constructor(private readonly valid = 'captcha-ok') {}
  async verify(token?: string) {
    return token === this.valid;
  }
}

const ENDPOINTS = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  hcaptcha: 'https://api.hcaptcha.com/siteverify',
} as const;

export class SiteverifyCaptcha implements CaptchaVerifier {
  readonly enabled = true;
  constructor(
    private readonly provider: keyof typeof ENDPOINTS,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async verify(token: string | undefined, ip?: string, expect: CaptchaExpect = {}) {
    if (!token || token.length > 4096) return false;
    const form = new URLSearchParams({ secret: this.secret, response: token });
    if (ip) form.set('remoteip', ip);
    try {
      const res = await this.fetchImpl(ENDPOINTS[this.provider], { method: 'POST', body: form, signal: AbortSignal.timeout(5_000) });
      const body = (await res.json()) as { success?: boolean; action?: string; hostname?: string };
      if (body.success !== true) return false;
      // Turnstile: a token solved for another form (e.g. sign-in replayed at sign-up) or on another site is refused.
      if (this.provider === 'turnstile') {
        if (expect.action && body.action !== expect.action) return false;
        if (expect.hostname && body.hostname?.toLowerCase() !== expect.hostname.toLowerCase()) return false;
      }
      return true;
    } catch {
      // Provider unreachable: fail closed. Sign-up and reset pause briefly rather than open up to bots.
      return false;
    }
  }
}
