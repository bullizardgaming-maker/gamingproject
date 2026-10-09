import { useState } from 'react';
import { api, apiBlob } from '../api';
import { t } from '../i18n';

interface RowResult { row: number; id: string | null; title: string; action: 'create' | 'update' | 'unchanged' | 'error'; changes?: string[]; review?: boolean; error?: string }
interface ImportResult { rows: RowResult[]; summary: { create: number; update: number; unchanged: number; error: number }; error?: string }

/** Seller hub: download every listing as CSV, edit it in a spreadsheet, preview the import, apply it. */
export function BulkListings({ onApplied }: { onApplied: () => void }) {
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const download = async () => {
    setError('');
    try {
      const url = URL.createObjectURL(await apiBlob('/seller/listings/export.csv'));
      const a = Object.assign(document.createElement('a'), { href: url, download: 'bullizard-listings.csv' });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e: any) {
      setError(e.message);
    }
  };
  const run = async (text: string, dryRun: boolean) => {
    setBusy(true);
    setError('');
    try {
      const r = await api<ImportResult>('/seller/listings/import', { body: { csv: text, dryRun } });
      if (r.error) setError(r.error);
      if (dryRun) setPreview(r);
      else {
        setDone(r);
        setPreview(null);
        setCsv(null);
        onApplied();
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const result = (r: RowResult) =>
    r.action === 'create' ? t('bulk.create')
      : r.action === 'update' ? t('bulk.update', { changes: (r.changes ?? []).join(', ') })
        : r.action === 'unchanged' ? t('bulk.unchanged')
          : r.error;
  const shown = preview ?? done;
  const toApply = preview ? preview.summary.create + preview.summary.update : 0;

  return (
    <section className="card stack" aria-labelledby="bulk-title">
      <h2 id="bulk-title" style={{ margin: 0 }}>{t('bulk.title')}</h2>
      <p className="small muted" style={{ margin: 0 }}>{t('bulk.lede')}</p>
      <div className="row">
        <button className="btn ghost" onClick={download}>{t('bulk.download')}</button>
        <label className="btn ghost" style={{ cursor: 'pointer' }}>
          {t('bulk.choose')}
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            disabled={busy}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              const text = await f.text();
              setCsv(text);
              setDone(null);
              void run(text, true);
            }}
          />
        </label>
      </div>
      <p className="small muted" style={{ margin: 0 }}>{t('bulk.columnsHint')}</p>
      {error && <div className="alert" role="alert">{error}</div>}
      {shown && (
        <>
          <div className="small" role="status">
            {preview ? t('bulk.preview', preview.summary) : t('bulk.applied', done!.summary)}
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{t('bulk.col.row')}</th><th>{t('bulk.col.listing')}</th><th>{t('bulk.col.result')}</th></tr></thead>
              <tbody>
                {shown.rows.filter((r) => r.action !== 'unchanged').map((r) => (
                  <tr key={r.row}>
                    <td className="mono">{r.row + 1}</td>
                    <td>{r.title || '—'}</td>
                    <td className={r.action === 'error' ? 'text-disputed' : undefined}>
                      {result(r)}{r.review ? ` · ${t('bulk.review')}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview && toApply > 0 && csv && (
            <button className="btn" style={{ alignSelf: 'start' }} disabled={busy} onClick={() => run(csv, false)}>{t('bulk.apply', { count: toApply })}</button>
          )}
        </>
      )}
    </section>
  );
}
