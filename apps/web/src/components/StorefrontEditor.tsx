import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiUpload, assetUrl } from '../api';
import { t, type MessageKey } from '../i18n';

const ACCENTS = ['steel', 'teal', 'amber', 'rose', 'violet'] as const;
type Accent = (typeof ACCENTS)[number];
const MAX_INTRO = 600;
const MAX_PINNED = 4;

interface Storefront { intro: string; accent: Accent; banner_url: string | null; pinned: Array<{ id: string }> }
interface Listing { id: string; title: string; game: string; status: string; reserved_for?: string | null }

/** Seller hub: banner, intro, accent colour and pinned listings for the public shop page. */
export function StorefrontEditor({ sellerId }: { sellerId: string }) {
  const [shop, setShop] = useState<Storefront | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [intro, setIntro] = useState('');
  const [accent, setAccent] = useState<Accent>('steel');
  const [pinned, setPinned] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'alert'; text: string } | null>(null);

  useEffect(() => {
    api<Storefront>('/seller/storefront').then((s) => {
      setShop(s);
      setIntro(s.intro);
      setAccent(s.accent);
      setPinned(s.pinned.map((p) => p.id));
    }).catch(() => {});
    api<Listing[]>('/seller/offers').then((o) => setListings(o.filter((x) => x.status === 'active' && !x.reserved_for))).catch(() => {});
  }, []);
  if (!shop) return null;

  const run = async (fn: () => Promise<Storefront>, ok: string) => {
    setBusy(true);
    setNote(null);
    try {
      setShop(await fn());
      setNote({ kind: 'ok', text: ok });
    } catch (e: any) {
      setNote({ kind: 'alert', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) => setPinned((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < MAX_PINNED ? [...p, id] : p));

  return (
    <section className="card stack" aria-labelledby="storefront-title">
      <div className="row spread">
        <h2 id="storefront-title" style={{ margin: 0 }}>{t('shop.title')}</h2>
        <Link to={`/sellers/${sellerId}`} className="small">{t('shop.view')}</Link>
      </div>
      <p className="small muted" style={{ margin: 0 }}>{t('shop.lede')}</p>

      <div className="stack" style={{ gap: 8 }}>
        <b className="small">{t('shop.banner')}</b>
        {shop.banner_url ? (
          <img className="shop-banner" src={assetUrl(shop.banner_url)} alt={t('shop.bannerAlt')} />
        ) : (
          <div className="shop-banner" style={{ background: `var(--shop-${accent})`, opacity: 0.85 }} aria-hidden="true" />
        )}
        <div className="row small">
          <label className="btn ghost" style={{ cursor: 'pointer' }}>
            {t('shop.upload')}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void run(() => apiUpload<Storefront>('/seller/storefront/banner', f), t('shop.bannerSaved'));
              }}
            />
          </label>
          {shop.banner_url && (
            <button className="btn ghost" disabled={busy} onClick={() => run(() => api<Storefront>('/seller/storefront/banner', { method: 'DELETE' }), t('shop.bannerRemoved'))}>{t('shop.remove')}</button>
          )}
          <span className="muted">{t('shop.bannerHint')}</span>
        </div>
      </div>

      <label className="field">
        {t('shop.intro')}
        <textarea value={intro} maxLength={MAX_INTRO} onChange={(e) => setIntro(e.target.value)} aria-describedby="shop-intro-hint" rows={3} />
        <span id="shop-intro-hint" className="small muted">{t('shop.introHint', { n: MAX_INTRO - intro.length })}</span>
      </label>

      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 8 }}>
        <legend className="small" style={{ fontWeight: 600, marginBottom: 6 }}>{t('shop.accent')}</legend>
        <div className="row" style={{ gap: 12 }}>
          {ACCENTS.map((a) => (
            <label key={a} className="row small" style={{ gap: 6 }}>
              <input type="radio" name="shop-accent" value={a} checked={accent === a} onChange={() => setAccent(a)} style={{ width: 'auto' }} />
              <span aria-hidden="true" style={{ display: 'inline-block', width: 16, height: 16, borderRadius: 4, background: `var(--shop-${a})` }} />
              {t(`shop.accent.${a}` as MessageKey)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 6 }}>
        <legend className="small" style={{ fontWeight: 600, marginBottom: 6 }}>{t('shop.pinned', { n: MAX_PINNED })}</legend>
        {listings.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>{t('shop.noListings')}</p>
        ) : (
          listings.slice(0, 30).map((o) => (
            <label key={o.id} className="row small" style={{ gap: 8 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={pinned.includes(o.id)} disabled={!pinned.includes(o.id) && pinned.length >= MAX_PINNED} onChange={() => toggle(o.id)} />
              <span>{o.title} <span className="muted">· {o.game}</span></span>
            </label>
          ))
        )}
      </fieldset>

      <div className="row">
        <button className="btn" disabled={busy} onClick={() => run(() => api<Storefront>('/seller/storefront', { method: 'PUT', body: { intro, accent, pinned } }), t('shop.saved'))}>{t('shop.save')}</button>
        {note && <span className={note.kind === 'ok' ? 'small text-released' : 'small'} role={note.kind === 'ok' ? 'status' : 'alert'}>{note.text}</span>}
      </div>
    </section>
  );
}
