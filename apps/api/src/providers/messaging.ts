export interface OutboundMessage {
  channel: 'email' | 'sms';
  to: string;
  body: string;
  subject?: string;
  html?: string;
}

/**
 * Email/SMS delivery. The console implementation logs messages and keeps the
 * most recent ones in memory so dev tooling and tests can read OTP codes.
 * Swap for Twilio Verify / SES etc. in production — prefer a provider that
 * rejects VoIP/virtual numbers so sellers cannot recycle disposable SIMs.
 */
export interface Messenger {
  send(msg: OutboundMessage): Promise<void>;
}

export class ConsoleMessenger implements Messenger {
  readonly outbox: OutboundMessage[] = [];
  constructor(private readonly log: (msg: string) => void = console.log) {}
  async send(msg: OutboundMessage) {
    this.outbox.push(msg);
    if (this.outbox.length > 200) this.outbox.shift();
    this.log(`[${msg.channel} -> ${msg.to}] ${msg.subject ? msg.subject + ' | ' : ''}${msg.body}`);
  }
  lastTo(to: string) {
    return [...this.outbox].reverse().find((m) => m.to === to);
  }
}

/** Email through Postmark's HTTP API. */
export class PostmarkMessenger implements Messenger {
  constructor(
    private readonly token: string,
    private readonly from: string,
  ) {}

  async send(msg: OutboundMessage) {
    if (msg.channel !== 'email') throw new Error('PostmarkMessenger only sends email');
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': this.token },
      body: JSON.stringify({
        From: this.from,
        To: msg.to,
        Subject: msg.subject ?? 'Bullizard',
        TextBody: msg.body,
        HtmlBody: msg.html,
        MessageStream: 'outbound',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`postmark ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** SMS through Twilio's Messages API. */
export class TwilioSmsMessenger implements Messenger {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly from: string, // E.164 number or a Messaging Service SID (MG...)
  ) {}

  async send(msg: OutboundMessage) {
    if (msg.channel !== 'sms') throw new Error('TwilioSmsMessenger only sends SMS');
    const form = new URLSearchParams({ To: msg.to, Body: msg.body });
    form.set(this.from.startsWith('MG') ? 'MessagingServiceSid' : 'From', this.from);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64') },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** Sends each channel through its own provider. */
export class RoutingMessenger implements Messenger {
  constructor(private readonly routes: { email: Messenger; sms: Messenger }) {}
  send(msg: OutboundMessage) {
    return this.routes[msg.channel].send(msg);
  }
}

// ---------------------------------------------------------------------------
// Phone checks: refuse VoIP / virtual numbers for verification. Disposable
// virtual numbers are how banned sellers come back under new accounts.
// ---------------------------------------------------------------------------
export interface PhoneChecker {
  check(phone: string): Promise<{ ok: boolean; lineType?: string }>;
}

export class TwilioLookupChecker implements PhoneChecker {
  private static readonly BLOCKED = new Set(['nonFixedVoip', 'fixedVoip', 'voip']);
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
  ) {}

  async check(phone: string) {
    const res = await fetch(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(phone)}?Fields=line_type_intelligence`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64') },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 404) return { ok: false, lineType: 'invalid' };
    if (!res.ok) throw new Error(`twilio lookup ${res.status}`);
    const body = (await res.json()) as any;
    if (body.valid === false) return { ok: false, lineType: 'invalid' };
    const lineType: string | undefined = body.line_type_intelligence?.type;
    return { ok: !lineType || !TwilioLookupChecker.BLOCKED.has(lineType), lineType };
  }
}

/** Development/test checker: numbers starting +1555 or +44700 are treated as VoIP. */
export class MockPhoneChecker implements PhoneChecker {
  async check(phone: string) {
    const voip = phone.startsWith('+1555') || phone.startsWith('+44700');
    return { ok: !voip, lineType: voip ? 'nonFixedVoip' : 'mobile' };
  }
}
