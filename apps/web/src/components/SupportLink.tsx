import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { supportHref } from '@/lib/support';

/** A link to a support page (Round 29): an ordinary in-app link, or a full link to support.bullizard.com from the live site. */
export function SupportLink({ to, className, children, ...rest }: { to: string; className?: string; children: ReactNode; 'data-testid'?: string }) {
  const href = supportHref(to);
  return href === to ? <Link to={to} className={className} {...rest}>{children}</Link> : <a href={href} className={className} {...rest}>{children}</a>;
}
