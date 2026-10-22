import { useEffect, useState } from 'react';
import { api, apiBlob, apiUpload } from '../api';
import { t } from '../i18n';

export interface ProgressUpdate {
  id: string;
  percent: number;
  note: string;
  attachment_id: string | null;
  created_at: string;
}

/** A chat screenshot, fetched with the viewer's session (attachments aren't public URLs). */
function Shot({ id }: { id: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    apiBlob(`/chat/attachments/${id}`).then(
      (b) => setSrc((url = URL.createObjectURL(b))),
      () => setFailed(true),
    );
    return () => void (url && URL.revokeObjectURL(url));
  }, [id]);
  if (failed) return <span className="small muted">{t('boost.shotUnavailable')}</span>;
  if (!src) return <span className="small muted">{t('boost.shotLoading')}</span>;
  return (
    <a href={src} target="_blank" rel="noreferrer" className="block w-fit">
      <img src={src} alt={t('boost.shotAlt')} className="max-h-40 rounded-md border border-border" />
    </a>
  );
}

/**
 * Boosting orders: progress bar and milestone timeline for both sides, and the seller's form to post
 * the next milestone with an optional screenshot (uploaded to the order chat first, so it's evidence).
 */
export function BoostProgress({ order, isSeller, onDone }: {
  order: { id: string; room_id: string; status: string; category_kind: string; progress?: ProgressUpdate[] };
  isSeller: boolean;
  onDone: () => void;
}) {
  const updates = order.progress ?? [];
  const last = updates.at(-1)?.percent ?? 0;
  const [percent, setPercent] = useState(last);
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => setPercent((p) => Math.max(p, last)), [last]);

  const canPost = isSeller && order.status === 'paid';
  if (order.category_kind !== 'boosting' || (!updates.length && !canPost)) return null;
  const shown = order.status === 'delivered' || order.status === 'completed' ? 100 : last;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const shot = file ? await apiUpload<{ id: string }>(`/chat/rooms/${order.room_id}/attachments`, file) : null;
      await api(`/orders/${order.id}/progress`, { body: { percent, note: note.trim(), ...(shot ? { attachmentId: shot.id } : {}) } });
      setNote('');
      setFile(null);
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="progress-title">
      <div className="row spread">
        <h3 id="progress-title" style={{ margin: 0 }}>{t('boost.title')}</h3>
        <span className="mono">{shown}%</span>
      </div>
      <div className="progress" role="progressbar" aria-label={t('boost.aria')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown}>
        <div style={{ width: `${shown}%` }} />
      </div>
      {updates.length > 0 ? (
        <ol className="m-0 list-none p-0">
          {[...updates].reverse().map((u) => (
            <li key={u.id} className="stack border-b border-border py-2 last:border-b-0" style={{ gap: 6 }}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span><b className="mono">{u.percent}%</b>{u.note && <> · {u.note}</>}</span>
                <time className="small muted" dateTime={u.created_at}>{new Date(u.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
              </div>
              {u.attachment_id && <Shot id={u.attachment_id} />}
            </li>
          ))}
        </ol>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>{t('boost.empty')}</p>
      )}
      {canPost && (
        <form className="stack" onSubmit={submit} style={{ gap: 10 }}>
          <div className="row" style={{ alignItems: 'end' }}>
            <label className="field" style={{ width: 120 }}>
              {t('boost.done')}
              <input type="number" min={last} max={100} required value={percent} onChange={(e) => setPercent(Math.min(100, Math.max(0, Number(e.target.value))))} />
            </label>
            <label className="field" style={{ flex: '1 1 240px' }}>
              {t('boost.note')}
              <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={t('boost.noteHint')} />
            </label>
          </div>
          <div className="row">
            <label className="btn ghost" style={{ cursor: 'pointer' }}>
              {file ? t('boost.changeShot') : t('boost.addShot')}
              <input type="file" className="file-input" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            {file && <span className="small muted">{file.name}</span>}
            <button className="btn" disabled={busy}>{busy ? t('boost.posting') : t('boost.post')}</button>
          </div>
          {error && <div className="alert" role="alert">{error}</div>}
        </form>
      )}
    </section>
  );
}
