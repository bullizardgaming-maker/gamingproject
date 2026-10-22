import { useEffect, useState } from 'react';
import { apiBlob } from '../api';
import { t } from '../i18n';

export interface ProofAttachment {
  id: string;
  mime: string;
  original_name?: string;
  created_at?: string;
}

/** The seller's delivery proof (photo or video), fetched with the viewer's session. */
export function DeliveryProof({ proof, title = t('proof.title') }: { proof: ProofAttachment; title?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    apiBlob(`/chat/attachments/${proof.id}`).then(
      (b) => setSrc((url = URL.createObjectURL(b))),
      () => setFailed(true),
    );
    return () => void (url && URL.revokeObjectURL(url));
  }, [proof.id]);
  const video = proof.mime.startsWith('video/');
  return (
    <figure className="stack" style={{ margin: 0, gap: 6 }} data-testid="delivery-proof">
      <figcaption className="small muted">{title}{proof.original_name ? ` · ${proof.original_name}` : ''}</figcaption>
      {failed ? (
        <span className="small muted">{t('proof.unavailable')}</span>
      ) : !src ? (
        <span className="small muted">{t('proof.loading')}</span>
      ) : video ? (
        <video src={src} controls playsInline className="max-h-72 w-fit rounded-md border border-border" />
      ) : (
        <a href={src} target="_blank" rel="noreferrer" className="block w-fit">
          <img src={src} alt={title} className="max-h-72 rounded-md border border-border" />
        </a>
      )}
    </figure>
  );
}
