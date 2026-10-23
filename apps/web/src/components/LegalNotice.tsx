import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useFeatures } from '@/lib/features';
import { useSession } from '../session';
import { currentLocale, t } from '../i18n';

/**
 * Legal (Oct 24): a material change to the Terms is announced 14 days ahead (banner from GET /features),
 * and once it is in force signed-in users accept it again (GET /me/legal → POST /me/legal/accept).
 */
export function LegalNotice() {
  const { legal } = useFeatures();
  const { user } = useSession();
  const [status, setStatus] = useState<{ reacceptanceRequired: boolean; currentVersion: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!user) { setStatus(null); return; }
    api('/me/legal').then(setStatus).catch(() => setStatus(null));
  }, [user?.id]);

  const accept = async () => {
    setBusy(true);
    try { await api('/me/legal/accept', { body: {} }); setStatus((s) => s && { ...s, reacceptanceRequired: false }); } finally { setBusy(false); }
  };

  if (status?.reacceptanceRequired) {
    return (
      <div className="shell" style={{ paddingTop: 12 }}>
        <div className="notice" role="alert" data-testid="legal-reaccept" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          <span style={{ flex: 1, minWidth: 240 }}>{t('legal.reaccept')} <Link to="/terms" target="_blank" rel="noopener">{t('legal.title.terms')}</Link></span>
          <button type="button" className="btn" disabled={busy} onClick={accept}>{t('legal.acceptBtn')}</button>
        </div>
      </div>
    );
  }
  const notice = legal?.notice;
  if (!notice) return null;
  const at = notice.effective_at ?? notice.effectiveAt;
  const date = at ? new Date(at).toLocaleDateString(currentLocale() === 'ar' ? 'ar-EG' : undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  return (
    <div className="shell" style={{ paddingTop: 12 }}>
      <div className="notice" data-testid="legal-notice">
        {t('legal.notice', { date })} <Link to={`/terms/versions/${encodeURIComponent(notice.version)}`} target="_blank" rel="noopener">{t('legal.title.terms')} {notice.version}</Link>
      </div>
    </div>
  );
}
