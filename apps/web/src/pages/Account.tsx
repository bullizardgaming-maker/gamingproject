import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { DEMO, api, money, session } from '../api';
import { DemoSignIn } from '../demo/DemoUi';
import { PushSettings } from '../components/NotificationSettings';
import { MyBuyerReputation } from '../components/BuyerReputation';
import { Turnstile } from '../components/Turnstile';
import { BrandMark, BrandWordmark } from '../components/Brand';
import { CodeStep as SignInCode, YoureIn } from '../components/AuthSteps';
import { useSession } from '../session';
import { currentLocale, t } from '../i18n';
import { usePageMeta } from '@/lib/seo';

export function Login() {
  usePageMeta({ title: 'Sign in', noindex: true });
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const [params] = useSearchParams();
  const nav = useNavigate();

  const [done, setDone] = useState<string | null>(null);
  const [codeBusy, setCodeBusy] = useState(false);
  // Round 25c: "You're in" for a moment, then on to the shop (or where the buyer was going).
  const finish = (token: string, registered = false) => {
    session.set(token);
    const to = registered ? '/account' : params.get('next') ?? '/';
    setDone(registered ? 'Taking you to your account…' : 'Taking you to the shop…');
    setTimeout(() => nav(to), 1400);
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setError('');
    try {
      const captcha = captchaToken ? { captchaToken } : {};
      const res = await api<{ token?: string; mfaRequired?: boolean; mfaToken?: string }>(mode === 'login' ? '/auth/login' : '/auth/register', {
        body:
          mode === 'login'
            ? { email: f.email, password: f.password, ...captcha }
            : { ...f, ...captcha, code: f.code?.trim() || undefined, acceptTerms: f.acceptTerms === 'true', newsOptIn: f.newsOptIn === 'true', locale: currentLocale() },
      });
      if (res.mfaRequired && res.mfaToken) setMfaToken(res.mfaToken);
      else finish(res.token!, mode === 'register');
    } catch (err: any) {
      setCaptchaReset((n) => n + 1); // a Turnstile token works once
      setError(err.code === 'validation_error' ? 'Use a valid email and a password of at least 10 characters.' : err.message);
    }
  };

  const submitCode = async (code: string) => {
    setError('');
    setCodeBusy(true);
    try {
      const res = await api<{ token: string }>('/auth/mfa', { body: { mfaToken, code } });
      finish(res.token);
    } catch (err: any) {
      setError(err.message);
      if (err.code === 'reauth_required') setMfaToken(null); // the 5-minute challenge ran out: start again with the password
    } finally {
      setCodeBusy(false);
    }
  };

  if (done) return <YoureIn where={done} />;
  if (mfaToken) return <SignInCode onSubmit={submitCode} error={error} busy={codeBusy} onBack={() => (setMfaToken(null), setError(''))} />;

  return (
    <div className="auth-wrap">
      {DEMO && mode === 'login' && <DemoSignIn next={params.get('next') ?? '/market'} />}
      <div className="auth-card">
        {/* Header: our icon and wordmark (Round 25c design) */}
        <span className="auth-icon auth-appicon" aria-hidden><BrandMark style={{ height: 26, width: 'auto' }} /></span>
        <h1 className="auth-brand">
          <span className="sr-only">{mode === 'login' ? 'Sign in to Bullizard' : 'Create a Bullizard account'}</span>
          <BrandWordmark style={{ height: 22, width: 'auto' }} />
        </h1>
        <form className="auth-form" onSubmit={submit}>
          {mode === 'register' && <input name="displayName" required minLength={2} maxLength={40} placeholder="Display name" aria-label="Display name" autoComplete="nickname" />}
          {mode === 'register' && (
            <label className="field">
              <span className="sr-only">{t('auth.code')}</span>
              <input name="code" maxLength={20} defaultValue={params.get('ref') ?? params.get('code') ?? ''} placeholder={t('auth.code')} aria-describedby="auth-code-hint" autoCapitalize="characters" />
              <span id="auth-code-hint" className="small muted">{params.get('ref') ? t('auth.codeFromLink', { code: params.get('ref')!.toUpperCase() }) + ' ' : ''}{t('auth.codeHint')}</span>
            </label>
          )}
          <input name="email" type="email" required autoComplete="email" placeholder="Email" aria-label="Email" />
          <input name="password" type="password" required minLength={10} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder="Password" aria-label="Password" />
          {mode === 'login' && <Link to="/forgot-password" className="auth-forgot">Forgot your password?</Link>}
          {mode === 'register' && (
            <label className="auth-check">
              <input name="acceptTerms" type="checkbox" required value="true" />
              <span>
                {t('auth.accept.before')}<Link to="/terms" target="_blank" rel="noopener">{t('auth.accept.terms')}</Link>{t('auth.accept.and')}<Link to="/privacy" target="_blank" rel="noopener">{t('auth.accept.privacy')}</Link>
              </span>
            </label>
          )}
          {mode === 'register' && (
            <label className="auth-check">
              {/* Newsletter consent: optional and unticked (Round 23a). */}
              <input name="newsOptIn" type="checkbox" value="true" defaultChecked={false} aria-describedby="news-opt-in-hint" />
              <span>{t('auth.newsOptIn')} <span id="news-opt-in-hint" className="muted">{t('auth.newsOptIn.hint')}</span></span>
            </label>
          )}
          <Turnstile action={mode === 'login' ? 'signin' : 'signup'} onToken={setCaptchaToken} resetKey={captchaReset} />
          {error && <div className="auth-error" role="alert">{error}</div>}
          <hr className="auth-rule" />
          <button className="auth-submit" type="submit">{mode === 'login' ? 'Sign in' : 'Create account'}</button>
          <p className="auth-switch">
            {mode === 'login' ? 'Don’t have an account?' : 'Already have an account?'}{' '}
            <button type="button" onClick={() => (setError(''), setMode(mode === 'login' ? 'register' : 'login'))}>{mode === 'login' ? 'Sign up, it’s free!' : 'Sign in'}</button>
          </p>
        </form>
      </div>
      <div className="auth-social">
        <p>Join <b>thousands</b> of Gamers who are already using Bullizard.</p>
        <span className="auth-faces" aria-hidden>
          {['K', 'R', 'V', 'N'].map((l) => <span key={l} className="avatar-ini">{l}</span>)}
        </span>
      </div>
    </div>
  );
}

function TwoFactor() {
  const { user, refresh } = useSession();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  if (!user) return null;

  const start = async () => {
    setError('');
    try {
      const res = await api<{ secret: string; otpauthUri: string }>('/me/2fa/setup', { body: {} });
      setSetup({ secret: res.secret, qr: await QRCode.toDataURL(res.otpauthUri, { margin: 1, width: 180 }) });
    } catch (e: any) {
      setError(e.message);
    }
  };
  const turnOn = async () => {
    setError('');
    try {
      const res = await api<{ recoveryCodes: string[]; token: string }>('/me/2fa/enable', { body: { code } });
      session.set(res.token);
      setCodes(res.recoveryCodes);
      setSetup(null);
      setCode('');
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };
  const turnOff = async () => {
    setError('');
    try {
      const res = await api<{ token: string }>('/me/2fa/disable', { body: { code } });
      session.set(res.token);
      setCode('');
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="card stack">
      <div className="eyebrow">{t('account.2fa.eyebrow')}</div>
      <h3>{t('account.2fa.title')}</h3>
      {codes && (
        <div className="ok stack">
          <b>{t('account.2fa.recovery')}</b>
          <div className="secret">{codes.join('\n')}</div>
        </div>
      )}
      {user.totp_enabled ? (
        <>
          <div className="ok">{t('account.2fa.on')}</div>
          <div className="row">
            <input className="mono" placeholder={t('account.2fa.codePlaceholder')} value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 220 }} />
            <button className="btn ghost" disabled={!code} onClick={turnOff}>{t('account.2fa.turnOff')}</button>
          </div>
        </>
      ) : setup ? (
        <div className="stack">
          <p className="muted small">{t('account.2fa.scan')}</p>
          <img src={setup.qr} alt={t('account.2fa.qrAlt')} width={180} height={180} />
          <p className="small muted">
            {t('account.2fa.cantScan', { key: '\u0000' }).split('\u0000')[0]}
            <span className="mono">{setup.secret}</span>
            {t('account.2fa.cantScan', { key: '\u0000' }).split('\u0000')[1]}
          </p>
          <div className="row">
            <input className="mono" inputMode="numeric" maxLength={6} placeholder={t('account.sixDigit')} value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 160 }} />
            <button className="btn" disabled={code.length !== 6} onClick={turnOn}>{t('account.2fa.turnOn')}</button>
          </div>
        </div>
      ) : (
        <>
          <p className="muted small">
            {t('account.2fa.protects')}{user.role !== 'user' && ` ${t('account.2fa.staff')}`}
          </p>
          <button className="btn ghost" onClick={start}>{t('account.2fa.setUp')}</button>
        </>
      )}
      {error && <div className="alert" role="alert">{error}</div>}
    </div>
  );
}

/** Level 1 is a verified email only (Round 24: no phone step anywhere). */
function CodeStep({ done, onDone }: { done: boolean; onDone: () => void }) {
  const channel = 'email';
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  if (done) return <div className="ok">{t('account.emailVerified')}</div>;
  return (
    <div className="stack">
      {!sent ? (
        <button
          className="btn ghost"
          onClick={async () => {
            setError('');
            try {
              await api(`/verify/${channel}/send`, { body: {} });
              setSent(true);
            } catch (e: any) {
              setError(e.message);
            }
          }}
        >
          {t('account.sendCode')}
        </button>
      ) : (
        <div className="row">
          <input className="mono" inputMode="numeric" maxLength={6} placeholder={DEMO ? t('account.demoCode') : t('account.sixDigit')} value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 180 }} />
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
            {t('account.verify')}
          </button>
        </div>
      )}
      {error && <div className="alert" role="alert">{error}</div>}
    </div>
  );
}

export function Account() {
  usePageMeta({ title: t('account.meta'), noindex: true });
  const { user, refresh } = useSession();
  const [kyc, setKyc] = useState<string>('');
  if (!user) return <p className="muted">{t('account.signIn')} <Link to="/login">{t('nav.signIn')}</Link></p>;

  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <h1 style={{ fontSize: 40 }}>{t('account.title')}</h1>
      <p className="lede">{t('account.lede', { tier: String(user.kyc_tier) })}</p>

      <div className="card stack">
        <div className="eyebrow">{t('account.level1')}</div>
        <h3>{t('account.confirmEmail')}</h3>
        <CodeStep done={!!user.email_verified_at} onDone={refresh} />
      </div>

      <div className="card stack">
        <div className="eyebrow">{t('account.level2')}</div>
        <h3>{t('sell.kyc.verify')}</h3>
        <p className="muted small">{t('account.id.text')}</p>
        {user.kyc_tier >= 2 ? (
          <div className="ok">{t('account.id.verified')}</div>
        ) : (
          <button
            className="btn"
            disabled={user.kyc_tier < 1}
            onClick={async () => {
              try {
                const s = await api<{ externalId: string; url?: string }>('/kyc/start', { body: { level: 'tier2_individual' } });
                if (s.url) window.location.assign(s.url);
                else setKyc(t('account.id.started', { ref: s.externalId }));
              } catch (e: any) {
                setKyc(e.message);
              }
            }}
          >
            {t('account.id.start')}
          </button>
        )}
        {kyc && <div className="notice">{kyc}</div>}
      </div>

      <MyBuyerReputation />
      <TwoFactor />
      <Devices />
      <PasswordChange />
      <div id="notifications" />
      <EmailPreferences />
      <Newsletter />
      <PushSettings />
      <CreditCard />
      <InviteFriends />
      <CreatorCode />
      <PrivacyControls />
    </div>
  );
}

function Devices() {
  const [devices, setDevices] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const load = () => api<any[]>('/me/sessions').then(setDevices).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="card stack">
      <div className="row spread">
        <h3 style={{ margin: 0 }}>{t('account.devices')}</h3>
        {devices && devices.length > 1 && (
          <button className="btn ghost" onClick={() => run(() => api('/me/sessions/revoke-others', { body: {} }))}>{t('account.devices.signOutOthers')}</button>
        )}
      </div>
      {error && <div className="alert" role="alert">{error}</div>}
      {devices?.map((d) => (
        <div key={d.id} className="row spread small" style={{ borderTop: '1px solid var(--rule)', paddingTop: 10 }}>
          <span>
            <b>{d.device}</b>
            {d.current && <span className="chip released" style={{ marginInlineStart: 8 }}>{t('account.devices.this')}</span>}
            <div className="muted">
              {t('account.devices.lastActive', { ip: d.ip ?? t('account.devices.unknownIp'), when: new Date(d.lastActiveAt).toLocaleString() })}
            </div>
          </span>
          {!d.current && <button className="btn ghost" onClick={() => run(() => api(`/me/sessions/${d.id}`, { method: 'DELETE' }))}>{t('nav.signOut')}</button>}
        </div>
      ))}
    </div>
  );
}

function PasswordChange() {
  const [msg, setMsg] = useState<{ kind: 'ok' | 'alert'; text: string } | null>(null);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    try {
      const r = await api<{ signedOutDevices: number }>('/me/password', { body: f });
      form.reset();
      setMsg({ kind: 'ok', text: t('account.password.changed', { count: r.signedOutDevices }) });
    } catch (err: any) {
      setMsg({ kind: 'alert', text: err.code === 'validation_error' ? t('account.password.tooShort') : err.message });
    }
  };
  return (
    <form className="card stack" onSubmit={submit}>
      <h3>{t('account.password.title')}</h3>
      <div className="grid two">
        <label className="field">{t('account.password.current')}<input name="currentPassword" type="password" required autoComplete="current-password" /></label>
        <label className="field">{t('account.password.new')}<input name="newPassword" type="password" required minLength={10} autoComplete="new-password" /></label>
      </div>
      <p className="small muted">{t('account.password.note')}</p>
      {msg && <div className={msg.kind}>{msg.text}</div>}
      <button className="btn ghost">{t('account.password.title')}</button>
    </form>
  );
}

/** Newsletter consent (Round 23a): off unless ticked; the API stores the choice and its time. */
function Newsletter() {
  const { user, refresh } = useSession();
  const [on, setOn] = useState(!!user?.news_opt_in);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => setOn(!!user?.news_opt_in), [user?.news_opt_in]);
  if (!user) return null;
  const toggle = async (optIn: boolean) => {
    setError('');
    setSaved(false);
    setOn(optIn);
    try {
      const res = await api<{ newsOptIn: boolean }>('/me/newsletter', { method: 'PUT', body: { optIn } });
      setOn(res.newsOptIn);
      setSaved(true);
      refresh();
    } catch (e: any) {
      setOn(!optIn);
      setError(e.message);
    }
  };
  return (
    <div className="card stack checklist">
      <h3>{t('account.newsletter.title')}</h3>
      <p className="small muted">{t('account.newsletter.hint')}</p>
      <div>
        <label>
          <input type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} />
          <span>{t('account.newsletter.toggle')}</span>
        </label>
      </div>
      {saved && <div className="ok small" role="status">{t('account.newsletter.saved')}</div>}
      {error && <div className="alert" role="alert">{error}</div>}
    </div>
  );
}

function EmailPreferences() {
  const [prefs, setPrefs] = useState<Array<{ category: string; label: string; mandatory: boolean; enabled: boolean }>>([]);
  useEffect(() => {
    api('/me/email-preferences').then(setPrefs).catch(() => {});
  }, []);
  const toggle = async (category: string, enabled: boolean) => setPrefs(await api('/me/email-preferences', { method: 'PATCH', body: { [category]: enabled } }));
  return (
    <div className="card stack checklist">
      <h3>{t('account.email.title')}</h3>
      <div>
        {prefs.map((p) => (
          <label key={p.category}>
            <input type="checkbox" checked={p.enabled} disabled={p.mandatory} onChange={(e) => toggle(p.category, e.target.checked)} />
            <span>
              {p.label}
              {p.mandatory && <span className="small muted"> · {t('account.email.alwaysOn')}</span>}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function ForgotPassword() {
  usePageMeta({ title: 'Reset your password', noindex: true });
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    try {
      await api('/auth/password/forgot', { body: { email: new FormData(e.currentTarget).get('email'), ...(captchaToken ? { captchaToken } : {}) } });
    } catch (err: any) {
      // Only the bot check is reported: anything else must not reveal whether the email has an account.
      if (String(err.code).startsWith('captcha_')) {
        setCaptchaReset((n) => n + 1);
        return setError(err.message);
      }
    }
    setSent(true);
  };
  return (
    <form className="card stack" style={{ maxWidth: 440, margin: '24px auto' }} onSubmit={submit}>
      <h1 className="auth-h1">Reset your password</h1>
      {sent ? (
        <div className="ok" role="status">{t('auth.resetSent')}</div>
      ) : (
        <>
          <label className="field">Email<input name="email" type="email" required autoComplete="email" /></label>
          <Turnstile action="reset" onToken={setCaptchaToken} resetKey={captchaReset} />
          {error && <div className="alert" role="alert">{error}</div>}
          <button className="btn">Email me a reset link</button>
        </>
      )}
    </form>
  );
}

export function ResetPassword() {
  usePageMeta({ title: 'Choose a new password', noindex: true });
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    try {
      await api('/auth/password/reset', { body: { token: params.get('token'), newPassword: new FormData(e.currentTarget).get('newPassword') } });
      nav('/login?reset=1');
    } catch (err: any) {
      setError(err.code === 'validation_error' ? 'Use at least 10 characters.' : err.message);
    }
  };
  return (
    <form className="card stack" style={{ maxWidth: 440, margin: '24px auto' }} onSubmit={submit}>
      <h2>Choose a new password</h2>
      <label className="field">New password<input name="newPassword" type="password" required minLength={10} autoComplete="new-password" /></label>
      <p className="small muted">You'll be signed out on all devices. Two-factor login stays on.</p>
      {error && <div className="alert" role="alert">{error} {error.includes('expired') && <Link to="/forgot-password">Request a new link</Link>}</div>}
      <button className="btn">Set password</button>
    </form>
  );
}

function PrivacyControls() {
  const { user, refresh } = useSession();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const download = async () => {
    const data = await api('/me/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bullizard-data.json';
    a.click();
    URL.revokeObjectURL(url);
  };
  const remove = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setError('');
    try {
      await api('/me/delete', { body: { password: f.password, code: f.code || undefined } });
      session.set(null);
      refresh();
    } catch (err: any) {
      setError(err.message);
    }
  };
  return (
    <div className="card stack">
      <h3>{t('account.data.title')}</h3>
      <p className="small muted" style={{ margin: 0 }}>{t('account.data.before')}</p>
      <div className="row">
        <button className="btn ghost" onClick={download}>{t('account.data.download')}</button>
        <button className="btn dispute" onClick={() => setOpen(!open)}>{t('account.data.delete')}</button>
      </div>
      {open && (
        <form className="stack" onSubmit={remove}>
          <p className="small muted">
            {t('account.data.text')}
          </p>
          <label className="field">{t('account.data.password')}<input name="password" type="password" required autoComplete="current-password" /></label>
          {user?.totp_enabled && <label className="field">{t('account.data.code')}<input name="code" className="mono" required /></label>}
          {error && <div className="alert" role="alert">{error}</div>}
          <button className="btn dispute">{t('account.data.deleteForever')}</button>
        </form>
      )}
    </div>
  );
}


interface AffiliateSummary {
  code: string;
  rate_bps: number;
  status: string;
  buyers: number;
  orders: number;
  earned_cents: number;
  earned_month_cents: number;
  recent: Array<{ order_id: string; commission_cents: number; earned_cents: number; currency: string; created_at: string }>;
}

/**
 * Creator codes: a buyer enters a streamer's code once (their orders then earn the creator a share
 * of the commission); a creator sees their own code and earnings here.
 */
interface ReferralSummary {
  code: string;
  link: string;
  rateBps: number;
  activeDays: number;
  friendsSignedUp: number;
  friendsActive: number;
  earnedCents: number;
  earnedMonthCents: number;
  ordersPaid: number;
  rewards: Array<{ order_id: string; amount_cents: number; currency: string; status: 'granted' | 'blocked'; reason: string | null; created_at: string; friend: string }>;
}

/** Invite friends: a share of Bullizard's commission on every order they make, for as long as they stay active. */
function InviteFriends() {
  const [ref, setRef] = useState<ReferralSummary | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api<ReferralSummary>('/me/referral').then(setRef).catch(() => setRef(null));
  }, []);
  if (!ref) return null;
  const pct = (ref.rateBps / 100).toFixed(0);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ref.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the link is selectable */
    }
  };
  return (
    <div className="card stack" id="invite" data-testid="invite-friends">
      <h3 style={{ margin: 0 }}>{t('invite.title')}</h3>
      <p className="small muted" style={{ margin: 0 }}>{t('invite.text', { pct })}</p>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <code className="num" style={{ userSelect: 'all' }} data-testid="invite-link">{ref.link}</code>
        <button type="button" className="btn ghost sm" onClick={copy}>{copied ? t('invite.copied') : t('invite.copy')}</button>
      </div>
      <div className="grid three">
        <div><div className="eyebrow">{t('invite.friends')}</div><b className="num">{ref.friendsSignedUp}</b> <span className="small muted">{t('invite.active', { n: ref.friendsActive })}</span></div>
        <div><div className="eyebrow">{t('invite.earned')}</div><b className="num">{money(ref.earnedCents)}</b> <span className="small muted">{t('invite.month', { amount: money(ref.earnedMonthCents) })}</span></div>
        <div><div className="eyebrow">{t('invite.orders')}</div><b className="num">{ref.ordersPaid}</b></div>
      </div>
      {ref.rewards.length > 0 && (
        <ul className="small" style={{ margin: 0, paddingInlineStart: 18 }}>
          {ref.rewards.slice(0, 5).map((r) => (
            <li key={r.order_id}>{r.friend} · {money(r.amount_cents, r.currency)} · {r.status === 'granted' ? t('invite.granted') : t('invite.blocked')}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreatorCode() {
  const [mine, setMine] = useState<AffiliateSummary | null | undefined>(undefined);
  useEffect(() => {
    api<AffiliateSummary | null>('/me/affiliate').then(setMine).catch(() => setMine(null));
  }, []);
  // Codes are entered once, at sign-up (CEO, Oct 24): this card only shows a creator their own code.
  if (!mine) return null;
  return (
    <div className="card stack" id="creator-code" data-testid="creator-code">
      <h3 style={{ margin: 0 }}>{t('creator.title')}</h3>
      <p className="small muted" style={{ margin: 0 }}>{t('creator.yours', { pct: (mine.rate_bps / 100).toFixed(0) })}</p>
      <div className="grid three">
        <div><div className="eyebrow">{t('creator.code')}</div><b className="mono">{mine.code}</b>{mine.status === 'paused' && <span className="chip held" style={{ marginInlineStart: 6 }}>{t('creator.paused')}</span>}</div>
        <div><div className="eyebrow">{t('creator.buyers')}</div><b className="mono">{mine.buyers}</b></div>
        <div><div className="eyebrow">{t('creator.earned')}</div><b className="mono">{money(mine.earned_cents)}</b> <span className="small muted">{t('creator.month', { amount: money(mine.earned_month_cents), count: mine.orders })}</span></div>
      </div>
      <p className="small muted" style={{ margin: 0 }}>{t('creator.signupOnly')}</p>
    </div>
  );
}


/** Credit on the account (kept underpayments, referral rewards): spend at checkout or withdraw. */
function CreditCard() {
  const [credit, setCredit] = useState<{ balanceCents: number; availableCents: number; currency: string } | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const load = () => api<{ balanceCents: number; availableCents: number; currency: string }>('/me/credit').then(setCredit).catch(() => setCredit(null));
  useEffect(() => {
    load();
  }, []);
  if (!credit || credit.balanceCents <= 0) return null;
  const withdraw = async () => {
    setError('');
    setMsg('');
    try {
      await api('/me/credit/withdraw', { body: { amountCents: credit.availableCents } });
      setMsg(t('credit.requested'));
      load();
    } catch (e: any) {
      setError(e.code === 'no_payout_address' ? t('credit.needAddress') : e.message);
    }
  };
  return (
    <div className="card stack" id="credit" data-testid="credit-card">
      <h3 style={{ margin: 0 }}>{t('credit.title')}</h3>
      <p className="small muted" style={{ margin: 0 }}>{t('credit.text')}</p>
      <div className="row spread">
        <span><span className="eyebrow">{t('credit.available')}</span> <b className="mono">{money(credit.availableCents, credit.currency)}</b></span>
        <button className="btn ghost" disabled={credit.availableCents < 150} onClick={withdraw}>{t('credit.withdraw', { amount: money(credit.availableCents, credit.currency) })}</button>
      </div>
      {msg && <div className="ok" role="status">{msg}</div>}
      {error && <div className="alert" role="alert">{error}</div>}
    </div>
  );
}
