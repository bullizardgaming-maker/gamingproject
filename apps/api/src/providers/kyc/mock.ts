import { randomUUID } from 'node:crypto';
import { hmacSha256, safeEqual } from '../../lib/crypto.js';
import type { KycProvider, KycResult } from './types.js';

export class MockKycProvider implements KycProvider {
  readonly name = 'mock';
  constructor(private readonly secret: string) {}

  async startVerification() {
    return { externalId: `mock_applicant_${randomUUID()}`, accessToken: 'mock-sdk-token' };
  }

  sign(body: string) {
    return hmacSha256(this.secret, body);
  }

  async parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<KycResult | null> {
    if (!safeEqual(String(headers['x-mock-signature'] ?? ''), this.sign(rawBody.toString('utf8')))) {
      throw new Error('invalid mock kyc signature');
    }
    const body = JSON.parse(rawBody.toString('utf8'));
    return { externalId: body.externalId, status: body.status, legalName: body.legalName, raw: body };
  }
}
