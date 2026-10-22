/**
 * Confirms a seller's VAT number is registered, which is what allows reverse-charge
 * (no VAT on our commission) for EU business sellers.
 */
export interface VatValidator {
  readonly name: string;
  /** true = registered, false = not registered, null = could not check right now. */
  check(country: string, number: string): Promise<boolean | null>;
}

/** No external check: numbers are stored unverified, so sellers are charged VAT as consumers. */
export class NoVatValidator implements VatValidator {
  readonly name = 'none';
  async check() {
    return null;
  }
}

/** Test double. */
export class FakeVatValidator implements VatValidator {
  readonly name = 'fake';
  constructor(private readonly valid: Set<string>) {}
  async check(country: string, number: string) {
    return this.valid.has(`${country}${number}`);
  }
}

/** EU VIES REST service. Greece is "EL" in VIES. */
export class ViesValidator implements VatValidator {
  readonly name = 'vies';
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}
  async check(country: string, number: string) {
    const cc = country === 'GR' ? 'EL' : country;
    try {
      const res = await this.fetchImpl(`https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${cc}/vat/${encodeURIComponent(number)}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { isValid?: boolean; userError?: string };
      if (body.userError && body.userError !== 'VALID' && body.userError !== 'INVALID') return null; // member state service down
      return body.isValid === true;
    } catch {
      return null;
    }
  }
}
