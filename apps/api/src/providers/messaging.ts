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

/**
 * Email through Postmark's HTTP API; SMS falls through to `sms` (console by default,
 * swap for Twilio Verify in production).
 */
export class PostmarkMessenger implements Messenger {
  constructor(
    private readonly token: string,
    private readonly from: string,
    private readonly sms: Messenger,
  ) {}

  async send(msg: OutboundMessage) {
    if (msg.channel === 'sms') return this.sms.send(msg);
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
