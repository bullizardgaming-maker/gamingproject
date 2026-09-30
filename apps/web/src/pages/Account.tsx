import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, session } from '../api';
import { useSession } from '../session';

export function Login() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState('');
  const [params] = useSearchParams();
  const nav = useNavigate();

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setError('');
    try {
      const res = await api<{ token: string }>(mode === 'login' ? '/auth/login' : '/auth/register', { body: f });
      session.set(res.token);
      nav(mode === 'register' ? '/account' : params.get('next') ?? '/market');
    } catch (err: any) {
      setError(err.code === 'validation_error' ? 'Use a valid email and a password of at least 10 characters.' : err.message);
    }
  };

  return (
    <div className="card stack" style={{ maxWidth: 440, margin: '24px auto' }}>
      <h2>{mode === 'login' ? 'Sign in' : 'Create an account'}</h2>
      <form className="stack" onSubmit={submit}>
        {mode === 'register' && (
          <label className="field">Display name<input name="displayName" required minLength={2} maxLength={40} /></label>
        )}
        <label className="field">Email<input name="email" type="email" required autoComplete="email" /></label>
        <label className="field">
          Password
          <input name="password" type="password" required minLength={10} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </label>
        {error && <div className="alert">{error}</div>}
        <button className="btn" type="submit">{mode === 'login' ? 'Sign in' : 'Create account'}</button>
      </form>
      <button className="btn ghost" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in'}
      </button>
    </div>
  );
}

function CodeStep({ channel, done, onDone }: { channel: 'email' | 'sms'; done: boolean; onDone: () => void }) {
  const [phone, setPhone] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  if (done) return <div className="ok">{channel === 'email' ? 'Email verified.' : 'Phone verified.'}</div>;
  return (
    <div className="stack">
      {channel === 'sms' && !sent && (
        <label className="field">Mobile number<input className="mono" placeholder="+14155550123" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
      )}
      {!sent ? (
        <button
          className="btn ghost"
          onClick={async () => {
            setError('');
            try {
              await api(`/verify/${channel}/send`, { body: channel === 'sms' ? { phone } : {} });
              setSent(true);
            } catch (e: any) {
              setError(e.message);
            }
          }}
        >
          Send code
        </button>
      ) : (
        <div className="row">
          <input className="mono" inputMode="numeric" maxLength={6} placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 160 }} />
          <button
            className="btn"
            onClick={async () => {
              setError('');
              try {
                await api(`/verify/${channel}/confirm`, { body: { code } });
                onDone();
              } catch (e: any) {
                setError(e.message);
              }
            }}
          >
            Verify
          </button>
        </div>
      )}
      {error && <div className="alert">{error}</div>}
    </div>
  );
}

export function Account() {
  const { user, refresh } = useSession();
  const [kyc, setKyc] = useState<string>('');
  if (!user) return <p className="muted">Sign in to manage your account. <Link to="/login">Sign in</Link></p>;

  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <h1 style={{ fontSize: 40 }}>Verification</h1>
      <p className="lede">Level {user.kyc_tier} of 2. Buying needs level 1. Selling and withdrawals need level 2.</p>

      <div className="card stack">
        <div className="eyebrow">Level 1 · buy</div>
        <h3>Confirm your email</h3>
        <CodeStep channel="email" done={!!user.email_verified_at} onDone={refresh} />
        <h3>Confirm your phone</h3>
        <CodeStep channel="sms" done={!!user.phone_verified_at} onDone={refresh} />
      </div>

      <div className="card stack">
        <div className="eyebrow">Level 2 · sell and withdraw</div>
        <h3>Verify your identity</h3>
        <p className="muted small">A government photo ID and a short selfie video, checked by our identity partner. Your name must match the billing name on any account you list with Original Owner Proof.</p>
        {user.kyc_tier >= 2 ? (
          <div className="ok">Identity verified.</div>
        ) : (
          <button
            className="btn"
            disabled={user.kyc_tier < 1}
            onClick={async () => {
              try {
                const s = await api<{ externalId: string; url?: string }>('/kyc/start', { body: { level: 'tier2_individual' } });
                if (s.url) window.location.assign(s.url);
                else setKyc(`Verification started (reference ${s.externalId}). Finish it in the identity check window; this page updates when it's approved.`);
              } catch (e: any) {
                setKyc(e.message);
              }
            }}
          >
            Start identity check
          </button>
        )}
        {kyc && <div className="notice">{kyc}</div>}
      </div>
    </div>
  );
}
