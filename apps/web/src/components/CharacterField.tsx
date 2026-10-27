import { useEffect, useState } from 'react';
import { HELP_CENTER } from '@/lib/features';
import { Link } from 'react-router-dom';
import { handoverFieldFor, handoverKey } from '../../../api/src/domain/attributeSets';
import { useSession } from '../session';
import { currentLocale, t } from '../i18n';

export { handoverFieldFor };

/**
 * The in-game name the seller delivers to (character name, UID…) for games that deliver in-game.
 * After the first order the name is remembered on the account: the buyer confirms it in one tap,
 * or changes it. The buyer is responsible for the name they confirm (terms link).
 */
export function CharacterField({ game, category, value, onChange, compact = false }: {
  game: string;
  category: string;
  value: string;
  onChange: (v: string, confirmed: boolean) => void;
  compact?: boolean;
}) {
  const { user } = useSession();
  const field = handoverFieldFor(game, category);
  const remembered = user?.handover_names?.[handoverKey(game)] ?? '';
  const [editing, setEditing] = useState(!remembered);
  const [confirmed, setConfirmed] = useState(false);
  // Start from the remembered name; a new sign-in or game resets the state.
  useEffect(() => {
    setEditing(!remembered);
    setConfirmed(false);
    onChange(remembered, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remembered, game]);
  if (!field) return null;
  const label = t(`handover.${field.key}` as 'handover.character' | 'handover.uid');
  // Game-specific hints are written in English; other languages get the translated general hint.
  const en = currentLocale() === 'en';
  const hint = en ? field.hint : t(`handover.hint.${field.key}` as 'handover.hint.character' | 'handover.hint.uid');
  const placeholder = en ? field.label : label;
  if (!editing && remembered) {
    return (
      <div className="field" data-testid="character-field">
        <span>{label}</span>
        <div className="pg-saved" data-on={confirmed || undefined}>
          <span className="pg-saved-ini" aria-hidden>{remembered.slice(0, 1).toUpperCase()}</span>
          <button
            type="button"
            className="pg-saved-pick"
            aria-pressed={confirmed}
            onClick={() => {
              setConfirmed(true);
              onChange(remembered, true);
            }}
          >
            <b className="num">{remembered}</b>
            <span className="small muted">{confirmed ? `✓ ${t('handover.confirmed')}` : t('handover.confirm')}</span>
          </button>
          <button type="button" className="pg-saved-change" onClick={() => { setEditing(true); setConfirmed(false); onChange('', false); }}>{t('handover.change')}</button>
        </div>
        {!compact && HELP_CENTER && <span className="small muted">{t('handover.responsible')} <Link to="/help/delivery-in-game">{t('handover.terms')}</Link></span>}
      </div>
    );
  }
  return (
    <label className="field" data-testid="character-field">
      {label}
      <input
        value={value}
        maxLength={60}
        required
        placeholder={placeholder}
        aria-describedby={`handover-hint-${field.key}`}
        onChange={(e) => {
          setConfirmed(false);
          onChange(e.target.value, e.target.value.trim().length > 0);
        }}
      />
      <span id={`handover-hint-${field.key}`} className="small muted">
        {hint} {!compact && HELP_CENTER && <>{t('handover.responsible')} <Link to="/help/delivery-in-game">{t('handover.terms')}</Link></>}
      </span>
    </label>
  );
}
