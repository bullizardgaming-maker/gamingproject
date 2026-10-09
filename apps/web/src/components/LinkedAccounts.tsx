import { useEffect, useState } from 'react';
import { api } from '../api';
import { intlLocale, t, type MessageKey } from '../i18n';

export interface LinkedAccount {
  id: string;
  provider: 'steam' | 'riot';
  display_name: string;
  profile_url: string | null;
  account_created_at: string | null;
  linked_at: string;
}

export const platformName = (p: string) => (p === 'steam' ? 'Steam' : 'Riot');
const ERRORS = ['link_expired', 'link_failed', 'linked_elsewhere'];

/**
 * Steam and Riot accounts the seller signed in to. Signing in proves they control the account
 * now; a listing that shows one gets a verified badge (platform and account age, never the name).
 */
export function LinkedAccounts({ accounts, onChange }: { accounts: LinkedAccount[]; onChange: () => void }) {
  const [msg, setMsg] = useState<{ kind: 'ok' | 'alert'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Back from the platform's sign-in page: say how it went, then tidy the address bar.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const linked = q.get('linked');
    const error = q.get('link_error');
    if (!linked && !error) return;
    if (linked) setMsg({ kind: 'ok', text: t('linked.done', { platform: platformName(linked) }) });
    else setMsg({ kind: 'alert', text: t(`linked.error.${ERRORS.includes(error!) ? error : 'link_failed'}` as MessageKey) });
    q.delete('linked');
    q.delete('link_error');
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${q.toString() ? `?${q}` : ''}`);
  }, []);

  const start = async (provider: 'steam' | 'riot') => {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>(`/seller/linked-accounts/${provider}/start`, { body: {} });
      window.location.assign(url);
    } catch (e: any) {
      setMsg({ kind: 'alert', text: e.message });
      setBusy(false);
    }
  };

  const remove = async (a: LinkedAccount) => {
    if (!window.confirm(t('linked.unlinkConfirm', { name: a.display_name }))) return;
    try {
      await api(`/seller/linked-accounts/${a.id}`, { method: 'DELETE' });
      onChange();
    } catch (e: any) {
      setMsg({ kind: 'alert', text: e.message });
    }
  };

  return (
    <section className="card stack" aria-labelledby="linked-title">
      <div>
        <h3 id="linked-title" style={{ margin: 0 }}>{t('linked.title')}</h3>
        <p className="small muted" style={{ margin: '4px 0 0' }}>{t('linked.lede')}</p>
      </div>
      {accounts.length > 0 && (
        <ul className="m-0 list-none p-0">
          {accounts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-2 last:border-b-0">
              <span>
                <span className="chip released">{platformName(a.provider)}</span>{' '}
                {a.profile_url ? <a href={a.profile_url} target="_blank" rel="noreferrer noopener">{a.display_name}</a> : <b>{a.display_name}</b>}
                <span className="small muted">
                  {' · '}
                  {a.account_created_at ? t('linked.created', { year: String(new Date(a.account_created_at).getFullYear()) }) : t('linked.ageUnknown')}
                  {' · '}
                  {t('linked.linkedOn', { date: new Date(a.linked_at).toLocaleDateString(intlLocale()) })}
                </span>
              </span>
              <button className="btn ghost" onClick={() => remove(a)} aria-label={t('linked.unlinkNamed', { name: a.display_name })}>{t('linked.unlink')}</button>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <button className="btn" disabled={busy} onClick={() => start('steam')}>{t('linked.link', { platform: 'Steam' })}</button>
        <button className="btn" disabled={busy} onClick={() => start('riot')}>{t('linked.link', { platform: 'Riot' })}</button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>{t('linked.footnote')}</p>
      {msg && <div className={msg.kind} role={msg.kind === 'alert' ? 'alert' : 'status'}>{msg.text}</div>}
    </section>
  );
}
