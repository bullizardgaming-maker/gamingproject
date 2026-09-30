import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { EscrowTrack, formatRemaining } from '../components/EscrowTrack';
import { FeeLadder } from '../components/FeeLadder';

const DEMO_LOG = [
  { seq: 1, who: 'system', text: 'Payment received. $300 locked in escrow.' },
  { seq: 2, who: 'seller', text: 'Delivered login + original registration email.' },
  { seq: 3, who: 'buyer', text: 'Changed password, recovery email, 2FA.' },
  { seq: 4, who: 'system', text: '14-day insurance ended. No dispute.' },
  { seq: 5, who: 'system', text: 'Released $261.03 to seller (fee 12.99%).' },
];
const hash = (n: number) => ((n * 2654435761) >>> 0).toString(16).padStart(8, '0');

/** Hero demo: one account sale moving through escrow on a compressed clock. */
function LiveEscrow() {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [t, setT] = useState(reduced ? 45 : 0);

  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => setT((x) => (x + 1) % 120), 100);
    return () => clearInterval(id);
  }, [reduced]);

  // 0-14 pending, 15-94 held (14 days compressed), 95-119 released
  const stage = t < 15 ? 0 : t < 95 ? 1 : 2;
  const elapsed = stage === 1 ? (t - 15) / 80 : 0;
  const remaining = 14 * 86_400_000 * (1 - elapsed);
  const shown = stage === 0 ? 1 : stage === 1 ? 2 + Math.floor(elapsed * 2) : 5;

  return (
    <div className="hero-panel" aria-label="Example: a game account sale in escrow">
      <div className="receipt">
        <span>Order 7F3A · WoW account, lvl 80</span>
        <span>$300.00</span>
      </div>
      <EscrowTrack
        amountCents={300_00}
        stage={stage as 0 | 1 | 2}
        variant={stage === 2 ? 'released' : 'held'}
        elapsed={elapsed}
        windowLabel="14-day asset insurance"
        clock={stage === 1 ? formatRemaining(remaining) : stage === 2 ? 'Settled' : 'Awaiting payment'}
      />
      <div className="log" aria-live="off">
        {DEMO_LOG.slice(0, shown).slice(-3).map((l) => (
          <div key={l.seq}>
            #{l.seq} <b>{l.who}</b> {l.text} <span>· {hash(l.seq)}…</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Home() {
  return (
    <>
      <section className="hero">
        <div>
          <div className="eyebrow">Game accounts · keys · currency · boosting</div>
          <h1>
            Your money waits until the account is <em>really yours</em>.
          </h1>
          <p className="lede">
            Every payment sits in escrow. Keys, currency and items get a 72-hour inspection window. Game accounts get 14 days of
            insurance against the original owner taking them back. The seller is paid only after that.
          </p>
          <div className="row" style={{ marginTop: 24 }}>
            <Link className="btn" to="/market">Browse the market</Link>
            <Link className="btn ghost" to="/sell">Start selling</Link>
          </div>
        </div>
        <LiveEscrow />
      </section>

      <section className="section">
        <div className="eyebrow">For buyers</div>
        <h2>Two protection windows, set by what you buy</h2>
        <div className="windows" style={{ marginTop: 24 }}>
          <div className="card window-card held stack">
            <div className="big mono">72h</div>
            <h3>Inspection window</h3>
            <p className="muted">
              Keys, gift cards, currency and items. Most are delivered the second your payment clears, straight to your order page.
              Test them. If something is wrong, open a dispute and the funds freeze until an arbiter reviews the order chat.
            </p>
          </div>
          <div className="card window-card ins stack">
            <div className="big mono">14d</div>
            <h3>Asset insurance for accounts</h3>
            <p className="muted">
              Sellers submit Original Owner Proof: the original registration email and date, and billing that matches their verified ID.
              After delivery you work through a security checklist: new password, new recovery email, fresh 2FA, all other sessions signed out.
              If the account is recovered by its old owner within 14 days, you get your money back.
            </p>
          </div>
        </div>
        <p className="small muted" style={{ marginTop: 16 }}>
          Listings without Original Owner Proof are labelled <span className="chip disputed">High risk · secondary market</span> before you buy.
        </p>
      </section>

      <section className="section split">
        <div className="stack">
          <div className="eyebrow">For sellers</div>
          <h2>Fees fall as your monthly sales grow</h2>
          <p className="muted">
            Your rate is set by your completed sales over the last 30 days and locked in when each order is placed. Gift cards, top-ups and
            video games are a flat 4.99% at every level.
          </p>
          <div className="ok">
            <b>Chargeback Shield.</b> If a buyer files a card chargeback on a verified listing you delivered through the platform, the
            platform reserve covers it and files the evidence with the bank: payment checks, delivery time and the full order chat. Your
            balance is not touched.
          </div>
          <p className="muted small">
            Running a shop at volume? Upload thousands of codes as .txt or JSON for instant delivery, and connect your own tools with the
            REST API and signed webhooks. <Link to="/developers">See the API</Link>.
          </p>
        </div>
        <div className="card">
          <FeeLadder />
        </div>
      </section>

      <section className="section">
        <div className="eyebrow">House rule</div>
        <h2>Every word of a trade stays in the order chat</h2>
        <p className="lede">
          The chat is the record an arbiter reads when something goes wrong, and the record we send the bank when a payment is disputed.
          Each message is numbered and chained to the one before it, so nothing can be edited or removed later. Moving a deal to Discord,
          Telegram or another payment app takes it out of escrow, and repeated attempts get an account suspended.
        </p>
      </section>
    </>
  );
}
