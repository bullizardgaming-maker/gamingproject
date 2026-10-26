import { Link } from 'react-router-dom';
import { t } from '../i18n';

/** Round 23f (item 3): the Terms changed while the buyer was on the page: read the new version, accept, continue. */
export function TermsChanged({ onAccept, busy }: { onAccept: () => void; busy: boolean }) {
  return (
    <div className="alert small" role="alert" data-testid="terms-changed">
      <p style={{ margin: 0 }}>{t('legal.changedNotice')}</p>
      <p style={{ margin: '.5rem 0 0', display: 'flex', gap: '.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <Link to="/legal/terms" target="_blank" rel="noopener">{t('legal.readNew')}</Link>
        <button type="button" className="btn sm" disabled={busy} onClick={onAccept}>{t('legal.acceptAndContinue')}</button>
      </p>
    </div>
  );
}
