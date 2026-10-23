import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { currentLocale, t } from '../i18n';
import { usePageMeta } from '@/lib/seo';

/**
 * Legal pages (Legal pack, Oct 24): /terms, /privacy, /seller-agreement, /refunds, /restricted-countries.
 * The text comes from the API (`GET /legal/:doc`), versioned and dated; /terms/history lists past versions.
 * Each page opens in a new tab from the buy box and sign-up, so nothing in progress is lost.
 */
export const LEGAL_DOCS = ['terms', 'privacy', 'seller-agreement', 'refunds', 'restricted-countries'] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];

interface LegalRow {
  doc: LegalDoc;
  locale: string;
  version: string;
  effective_at: string;
  title: string;
  content_md: string;
  sha256: string;
}

export const legalTitle = (doc: LegalDoc) => t(`legal.title.${doc}` as any);

const dateOf = (iso: string) => new Date(iso).toLocaleDateString(currentLocale() === 'ar' ? 'ar-EG' : undefined, { year: 'numeric', month: 'long', day: 'numeric' });

/** Just enough Markdown for a policy: headings, paragraphs, numbered and bulleted lists, **bold**, _italic_, [links](/path). */
export function renderMarkdown(md: string): ReactNode[] {
  const inline = (text: string, key: string): ReactNode[] => {
    const parts: ReactNode[] = [];
    const re = /\*\*(.+?)\*\*|_(.+?)_|\[([^\]]+)\]\(([^)]+)\)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(text))) {
      if (m.index > last) parts.push(text.slice(last, m.index));
      if (m[1]) parts.push(<b key={`${key}-${i++}`}>{m[1]}</b>);
      else if (m[2]) parts.push(<em key={`${key}-${i++}`}>{m[2]}</em>);
      else if (m[3]) parts.push(m[4]!.startsWith('/') ? <Link key={`${key}-${i++}`} to={m[4]!}>{m[3]}</Link> : <a key={`${key}-${i++}`} href={m[4]} rel="noopener noreferrer" target="_blank">{m[3]}</a>);
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  };
  const out: ReactNode[] = [];
  const lines = md.replace(/\r/g, '').split('\n');
  let list: { kind: 'ol' | 'ul'; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.kind;
    out.push(<Tag key={`l${out.length}`}>{list.items.map((it, k) => <li key={k}>{inline(it, `li${out.length}-${k}`)}</li>)}</Tag>);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { flush(); const lvl = h[1]!.length; out.push(lvl === 1 ? <h1 key={`h${out.length}`}>{h[2]}</h1> : lvl === 2 ? <h2 key={`h${out.length}`}>{h[2]}</h2> : <h3 key={`h${out.length}`}>{h[2]}</h3>); continue; }
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    const ul = /^[-*•]\s+(.*)$/.exec(line);
    if (ol || ul) {
      const kind = ol ? 'ol' : 'ul';
      if (!list || list.kind !== kind) { flush(); list = { kind, items: [] }; }
      list.items.push((ol ?? ul)![1]!);
      continue;
    }
    flush();
    out.push(<p key={`p${out.length}`}>{inline(line, `p${out.length}`)}</p>);
  }
  flush();
  return out;
}

export function LegalPage({ doc: fixed }: { doc?: LegalDoc }) {
  const params = useParams();
  const doc = (fixed ?? params.doc) as LegalDoc;
  const version = params.version;
  const [row, setRow] = useState<LegalRow | null>(null);
  const [error, setError] = useState('');
  const lang = currentLocale();
  usePageMeta({ title: LEGAL_DOCS.includes(doc) ? legalTitle(doc) : 'Bullizard', description: t('legal.lede') });
  useEffect(() => {
    if (!LEGAL_DOCS.includes(doc)) { setError(t('legal.notFound')); return; }
    setRow(null); setError('');
    api<LegalRow>(version ? `/legal/${doc}/versions/${encodeURIComponent(version)}?lang=${lang}` : `/legal/${doc}?lang=${lang}`)
      .then(setRow)
      .catch((e: any) => setError(e.message));
  }, [doc, version, lang]);

  return (
    <article className="stack" style={{ maxWidth: 760 }} data-testid={`legal-${doc}`}>
      <div>
        <div className="eyebrow">Bullizard</div>
        <h1 style={{ margin: 0 }}>{LEGAL_DOCS.includes(doc) ? legalTitle(doc) : t('legal.notFound')}</h1>
        {row && (
          <p className="muted small" style={{ margin: '6px 0 0' }} data-testid="legal-version">
            {t('legal.version', { version: row.version, date: dateOf(row.effective_at) })}
            {version && <> · <Link to={`/${doc}`}>{t('legal.current')}</Link></>}
            {row.locale !== lang && <> · {t('legal.englishOnly')}</>}
          </p>
        )}
      </div>
      {error && <div className="alert" role="alert">{error}</div>}
      {!row && !error && <p className="muted">{t('home.loading')}</p>}
      {row && <div className="card legal-body stack" dir="auto">{renderMarkdown(row.content_md.replace(/^#\s.*\n?/, ''))}</div>}
      <nav className="small muted" aria-label={t('legal.nav')} style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px' }}>
        {LEGAL_DOCS.filter((d) => d !== doc).map((d) => <Link key={d} to={`/${d}`}>{legalTitle(d)}</Link>)}
        {doc === 'terms' && !version && <Link to="/terms/history">{t('legal.history')}</Link>}
        <Link to="/help">{t('footer.helpCentre')}</Link>
      </nav>
    </article>
  );
}

/** Every version of the Terms, newest first, with its hash so anyone can check the copy they accepted. */
export function LegalHistory({ doc = 'terms' }: { doc?: LegalDoc }) {
  const [rows, setRows] = useState<Array<Omit<LegalRow, 'content_md'>> | null>(null);
  usePageMeta({ title: `${legalTitle(doc)} — ${t('legal.history')}`, noindex: true });
  useEffect(() => { api(`/legal/${doc}/history`).then(setRows).catch(() => setRows([])); }, [doc]);
  return (
    <article className="stack" style={{ maxWidth: 760 }} data-testid="legal-history">
      <div>
        <div className="eyebrow"><Link to={`/${doc}`}>{legalTitle(doc)}</Link></div>
        <h1 style={{ margin: 0 }}>{t('legal.history')}</h1>
        <p className="muted" style={{ margin: '6px 0 0' }}>{t('legal.historyLede')}</p>
      </div>
      {!rows ? <p className="muted">{t('home.loading')}</p> : (
        <table className="table">
          <thead><tr><th>{t('legal.col.version')}</th><th>{t('legal.col.effective')}</th><th>{t('legal.col.language')}</th><th>SHA-256</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.version}-${r.locale}`}>
                <td><Link to={`/${doc}/versions/${encodeURIComponent(r.version)}`}>{r.version}</Link></td>
                <td>{dateOf(r.effective_at)}</td>
                <td>{r.locale.toUpperCase()}</td>
                <td className="mono small">{r.sha256.slice(0, 16)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
}
