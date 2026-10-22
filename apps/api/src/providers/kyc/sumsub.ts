import { createHmac } from 'node:crypto';
import { safeEqual } from '../../lib/crypto.js';
import type { KycProvider, KycResult } from './types.js';

const BASE = 'https://api.sumsub.com';

/**
 * Sumsub integration (ID document + liveness). Requests are signed per Sumsub's
 * scheme: HMAC-SHA256(secret, ts + METHOD + path + body) in X-App-Access-Sig.
 * Webhooks are verified with X-Payload-Digest (HMAC-SHA256 of the raw body).
 */
export class SumsubKycProvider implements KycProvider {
  readonly name = 'sumsub';

  constructor(
    private readonly appToken: string,
    private readonly secretKey: string,
    private readonly webhookSecret: string,
    private readonly levelName: string,
  ) {}

  private async request(method: string, path: string, body?: unknown) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const payload = body ? JSON.stringify(body) : '';
    const sig = createHmac('sha256', this.secretKey).update(ts + method + path + payload).digest('hex');
    const res = await fetch(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-App-Token': this.appToken,
        'X-App-Access-Ts': ts,
        'X-App-Access-Sig': sig,
      },
      body: payload || undefined,
    });
    if (!res.ok) throw new Error(`sumsub ${method} ${path} -> ${res.status}: ${await res.text()}`);
    return res.json() as Promise<any>;
  }

  async startVerification(user: { id: string; email: string }) {
    const level = encodeURIComponent(this.levelName);
    const applicant = await this.request('POST', `/resources/applicants?levelName=${level}`, {
      externalUserId: user.id,
      email: user.email,
    });
    const token = await this.request(
      'POST',
      `/resources/accessTokens?userId=${encodeURIComponent(user.id)}&levelName=${level}`,
    );
    return { externalId: applicant.id as string, accessToken: token.token as string };
  }

  async parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<KycResult | null> {
    const digest = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    if (!safeEqual(digest, String(headers['x-payload-digest'] ?? ''))) throw new Error('invalid sumsub digest');
    const body = JSON.parse(rawBody.toString('utf8'));
    if (body.type !== 'applicantReviewed') return null;
    const answer = body.reviewResult?.reviewAnswer;
    let legalName: string | undefined;
    if (answer === 'GREEN') {
      const applicant = await this.request('GET', `/resources/applicants/${body.applicantId}/one`);
      const info = applicant.info ?? {};
      legalName = [info.firstName, info.lastName].filter(Boolean).join(' ') || undefined;
    }
    return {
      externalId: body.applicantId,
      status: answer === 'GREEN' ? 'approved' : answer === 'RED' ? 'rejected' : 'pending',
      legalName,
      raw: body,
    };
  }
}
