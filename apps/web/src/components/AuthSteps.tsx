import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, CircleNotch, ShieldCheck } from '@phosphor-icons/react';
import { BrandMark } from './Brand';

/**
 * Sign-in, Round 25c: the code step and the "You're in" step, with the motion of the reference design. The card
 * slides up when a step opens; the shield rises into place on the code step; the six boxes glow once when full and
 * shake on a wrong code; "You're in" lands as a stamp. Every animation is skipped under prefers-reduced-motion.
 */
const EASE = 'cubic-bezier(.22,1,.36,1)';
const LENGTH = 6;
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const digits = (v: string) => v.replace(/\D/g, '').slice(0, LENGTH);

function useEnter(ref: React.RefObject<HTMLElement | null>, extra?: (root: HTMLElement) => Animation[]) {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || reducedMotion() || !root.animate) return;
    const list = [root.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 280, easing: EASE }), ...(extra?.(root) ?? [])];
    return () => list.forEach((a) => a.cancel());
  }, []);
}

/**
 * Two-step sign-in code: six boxes (typing, paste and the phone's one-time-code autofill fill them), sent as soon as
 * the sixth digit is in. A recovery code (letters and dashes) goes in a single box instead.
 */
export function CodeStep({ onSubmit, error, busy, onBack }: { onSubmit: (code: string) => void; error: string; busy: boolean; onBack: () => void }) {
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  const fields = useRef<HTMLDivElement>(null);
  const sent = useRef<string | null>(null);

  useEnter(root, (r) => {
    const paper = r.querySelector('[data-paper]');
    return paper ? [paper.animate([{ transform: 'translateY(14px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 720, easing: EASE })] : [];
  });
  useEffect(() => boxes.current[0]?.focus({ preventScroll: true }), []);

  // Full: glow once, then send it (only once per code).
  useEffect(() => {
    if (code.length !== LENGTH || sent.current === code || busy) return;
    sent.current = code;
    if (!reducedMotion()) {
      for (const b of boxes.current) b?.animate?.([{ boxShadow: '0 0 0 0 transparent' }, { boxShadow: '0 0 0 2px var(--rune), 0 0 14px color-mix(in srgb, var(--rune) 30%, transparent)', offset: 0.45 }, { boxShadow: '0 0 0 0 transparent' }], { duration: 440, easing: 'ease-out' });
    }
    onSubmit(code);
  }, [code, busy, onSubmit]);

  // Wrong code: shake, clear, start again from the first box.
  useEffect(() => {
    if (!error) return;
    if (!reducedMotion()) fields.current?.animate?.([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(0)' }], { duration: 420, easing: 'ease-in-out' });
    sent.current = null;
    setCode('');
    boxes.current[0]?.focus({ preventScroll: true });
  }, [error]);

  const put = (text: string, index: number) => {
    const clean = digits(text);
    if (!clean || busy) return;
    const start = clean.length === LENGTH ? 0 : Math.min(index, code.length);
    const next = (code.slice(0, start) + clean + code.slice(start + clean.length)).slice(0, LENGTH);
    setCode(next);
    boxes.current[Math.min(start + clean.length, LENGTH - 1)]?.focus();
  };
  const key = (e: React.KeyboardEvent, index: number) => {
    if (busy) return;
    if (e.key === 'Backspace') {
      e.preventDefault();
      const at = code[index] ? index : Math.max(0, index - 1);
      setCode(code.slice(0, at) + code.slice(at + 1));
      boxes.current[Math.max(0, index - 1)]?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const rtl = document.documentElement.dir === 'rtl';
      const step = (e.key === 'ArrowLeft') !== rtl ? -1 : 1;
      boxes.current[Math.max(0, Math.min(LENGTH - 1, index + step))]?.focus();
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card auth-step" ref={root} aria-busy={busy}>
        <div className="auth-shield" aria-hidden>
          <span data-paper className="auth-shield-paper auth-appicon"><BrandMark style={{ height: 24, width: 'auto' }} /></span>
        </div>
        <h1 className="auth-title">Enter your sign-in code</h1>
        <p className="auth-sub">From your authenticator app for Bullizard.</p>
        {recovery ? (
          <form className="auth-form" onSubmit={(e) => (e.preventDefault(), recoveryCode.trim() && onSubmit(recoveryCode.trim()))}>
            <input name="code" className="mono" autoComplete="one-time-code" required maxLength={20} placeholder="Recovery code" aria-label="Recovery code" value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} autoFocus />
            {error && <div className="auth-error" role="alert">{error}</div>}
            <button className="auth-submit" type="submit" disabled={busy}>Sign in</button>
          </form>
        ) : (
          <>
            <div ref={fields} className="auth-code" role="group" aria-label="Sign-in code" dir="ltr">
              {Array.from({ length: LENGTH }, (_, i) => (
                <input
                  key={i}
                  ref={(n) => { boxes.current[i] = n; }}
                  className="num"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete={i === 0 ? 'one-time-code' : 'off'}
                  aria-label={`Digit ${i + 1} of ${LENGTH}`}
                  aria-invalid={error ? true : undefined}
                  data-filled={code[i] ? '' : undefined}
                  value={code[i] ?? ''}
                  disabled={busy}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => key(e, i)}
                  onChange={(e) => (e.target.value ? put(e.target.value, i) : setCode(code.slice(0, i) + code.slice(i + 1)))}
                  onPaste={(e) => (e.preventDefault(), put(e.clipboardData.getData('text'), i))}
                />
              ))}
            </div>
            <div className="auth-code-status" aria-live="polite">
              {error ? <p className="auth-error" role="alert">{error}</p> : busy ? <p><CircleNotch className="size-3.5 auth-spin" aria-hidden /> Checking your code…</p> : <p>Your code signs you in automatically</p>}
            </div>
          </>
        )}
        <div className="auth-links">
          <button type="button" onClick={onBack} disabled={busy}>Back</button>
          <button type="button" onClick={() => setRecovery((r) => !r)} disabled={busy}>{recovery ? 'Use the 6-digit code' : 'Use a recovery code'}</button>
        </div>
      </div>
    </div>
  );
}

/** "You're in": a stamp, then the buyer goes to the shop (the caller navigates). */
export function YoureIn({ name, where }: { name?: string | null; where: string }) {
  const root = useRef<HTMLDivElement>(null);
  useEnter(root, (r) => {
    const stamp = r.querySelector('[data-stamp]');
    return stamp ? [stamp.animate([{ opacity: 0, transform: 'scale(1.3) rotate(-16deg)' }, { opacity: 1, transform: 'scale(.94) rotate(3deg)', offset: 0.7 }, { opacity: 1, transform: 'scale(1) rotate(0deg)' }], { duration: 480, easing: EASE })] : [];
  });
  return (
    <div className="auth-wrap">
      <div className="auth-card auth-step auth-done" ref={root} role="status" aria-live="polite" data-testid="youre-in">
        <span data-stamp className="auth-stamp" aria-hidden><Check className="size-9" weight="bold" /></span>
        <h1 className="auth-title">{name ? `You're in, ${name}` : "You're in"}</h1>
        <p className="auth-sub">{where}</p>
        <span className="auth-verified"><ShieldCheck className="size-3.5" aria-hidden /> Signed in securely</span>
      </div>
    </div>
  );
}
