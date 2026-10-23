import { Link } from 'react-router-dom';
import { t } from '../i18n';
import { usePageMeta } from '@/lib/seo';

/**
 * Terms of Service. The buy box says "By buying you agree to the Terms" and links here; the full
 * legal text comes from Legal and replaces `terms.body` in i18n when it is final.
 */
export function Terms() {
  usePageMeta({ title: t('terms.title'), description: t('terms.lede') });
  return (
    <article className="stack" style={{ maxWidth: 760 }} data-testid="terms-page">
      <div>
        <div className="eyebrow">Bullizard</div>
        <h1 style={{ margin: 0 }}>{t('terms.title')}</h1>
        <p className="muted" style={{ margin: '6px 0 0' }}>{t('terms.lede')}</p>
      </div>
      <ul className="card" style={{ margin: 0, paddingInlineStart: 34 }}>
        {t('terms.body').split('\n').map((li, k) => <li key={k}>{li.replace(/^- /, '')}</li>)}
      </ul>
      <p className="small muted"><Link to="/help">{t('footer.helpCentre')}</Link></p>
    </article>
  );
}
