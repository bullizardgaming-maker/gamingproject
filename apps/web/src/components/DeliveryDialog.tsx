import { useEffect, useRef, useState } from 'react';
import { X } from '@phosphor-icons/react';
import { handoverKey } from '../../../api/src/domain/attributeSets';
import { useSession } from '../session';
import { fieldLabel, METHODS, methodLabel, type MethodKey } from '@/lib/delivery';
import { t } from '../i18n';

export interface DeliveryChoice { method: MethodKey; info: Record<string, string>; save: boolean }

/**
 * Buy → this pop-up in the middle of the screen: the delivery methods the seller offers, then only
 * the fields that method needs (labels, no examples). The buyer's saved in-game info fills them in;
 * "Save for my next purchase" keeps it. Continue goes to the checkout page.
 */
export function DeliveryDialog({ open, game, methods, busy, error, onClose, onContinue }: {
  open: boolean;
  game: string;
  methods: MethodKey[];
  busy: boolean;
  error?: string;
  onClose: () => void;
  onContinue: (c: DeliveryChoice) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { user } = useSession();
  const saved = user?.handover_names?.[handoverKey(game)] ?? '';
  const [method, setMethod] = useState<MethodKey>(methods[0]!);
  const [info, setInfo] = useState<Record<string, string>>({});
  const [save, setSave] = useState(true);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setMethod(methods[0]!);
      setInfo(saved ? { character: saved, uid: saved } : {});
      d.showModal();
    }
    if (!open && d.open) d.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const fields = METHODS[method].fields;
  const ready = fields.every((f) => (info[f.key] ?? '').trim());

  return (
    <dialog ref={ref} className="bz-dialog dm" aria-labelledby="dm-title" onClose={onClose} onCancel={onClose}>
      <form
        method="dialog"
        className="stack"
        style={{ gap: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy) onContinue({ method, info: Object.fromEntries(fields.map((f) => [f.key, info[f.key]!.trim()])), save });
        }}
      >
        <div className="dm-head">
          <h2 id="dm-title">{t('dm.title')}</h2>
          <button type="button" className="icon-link" aria-label={t('dm.close')} onClick={onClose}><X className="size-5" aria-hidden /></button>
        </div>
        <div className="dm-methods" role="radiogroup" aria-labelledby="dm-title">
          {methods.map((m) => {
            const Icon = METHODS[m].icon;
            return (
              <label key={m} className="dm-method" data-on={m === method || undefined}>
                <input type="radio" name="dm-method" value={m} checked={m === method} onChange={() => setMethod(m)} />
                <Icon className="size-5" aria-hidden />
                <span>{methodLabel(m)}</span>
              </label>
            );
          })}
        </div>
        {fields.map((f) => (
          <label key={f.key} className="field">
            {fieldLabel(f.key)}
            {f.options ? (
              <select required value={info[f.key] ?? ''} onChange={(e) => setInfo({ ...info, [f.key]: e.target.value })}>
                <option value="" disabled>{fieldLabel(f.key)}</option>
                {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input required maxLength={60} autoComplete="off" value={info[f.key] ?? ''} onChange={(e) => setInfo({ ...info, [f.key]: e.target.value })} data-testid={`dm-${f.key}`} />
            )}
          </label>
        ))}
        <label className="check-row small">
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
          {t('dm.save')}
        </label>
        {error && <div className="alert small" role="alert">{error}</div>}
        <button type="submit" className="btn go lg block" disabled={!ready || busy}>{busy ? t('offer.opening') : t('dm.continue')}</button>
      </form>
    </dialog>
  );
}
