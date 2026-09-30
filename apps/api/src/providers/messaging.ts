export interface OutboundMessage {
  channel: 'email' | 'sms';
  to: string;
  body: string;
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
    this.log(`[${msg.channel} -> ${msg.to}] ${msg.body}`);
  }
  lastTo(to: string) {
    return [...this.outbox].reverse().find((m) => m.to === to);
  }
}
