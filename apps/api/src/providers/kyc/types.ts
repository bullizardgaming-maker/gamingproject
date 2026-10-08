export interface KycSession {
  externalId: string;
  /** SDK access token / hosted verification URL to hand to the client. */
  accessToken?: string;
  url?: string;
}

export interface KycResult {
  externalId: string;
  status: 'approved' | 'rejected' | 'pending';
  legalName?: string;
  raw: unknown;
}

/**
 * Tier 2 identity verification: government photo ID + biometric liveness.
 * Implemented by an external provider (Sumsub, Onfido, ...).
 */
export interface KycProvider {
  readonly name: string;
  startVerification(user: { id: string; email: string }, level: 'tier2_individual' | 'tier2_business'): Promise<KycSession>;
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<KycResult | null>;
}
