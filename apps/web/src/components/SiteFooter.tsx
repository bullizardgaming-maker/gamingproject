import { Link } from 'react-router-dom';
import { CATEGORY_META, CATEGORY_ORDER } from '@/lib/catalog';

const COLUMNS: Array<[string, Array<[string, string]>]> = [
  ['Buy', CATEGORY_ORDER.slice(0, 6).map((slug) => [CATEGORY_META[slug]!.label, `/market?category=${slug}`])],
  ['Sell', [['Open a shop', '/sell'], ['Money & tax', '/sell/money'], ['Seller fees', '/#fees'], ['API & webhooks', '/developers']]],
  ['Protection', [['How escrow works', '/#how'], ['72-hour inspection', '/#how'], ['14-day account insurance', '/#how'], ['Your orders', '/orders']]],
  ['Account', [['Sign in', '/login'], ['Settings & security', '/account'], ['Notifications', '/account#notifications'], ['Watchlist & price alerts', '/watchlist'], ['All games A–Z', '/games'], ['System status', '/status']]],
];

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell">
        <div className="grid gap-8 py-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_repeat(4,1fr)]">
          <div className="stack" style={{ maxWidth: 320 }}>
            <Link to="/" className="brand"><span className="brand-mark" aria-hidden />Bullizard</Link>
            <p className="small muted" style={{ margin: '12px 0 0' }}>
              The gaming marketplace where your money waits in escrow until the account, key or gold is really yours.
            </p>
          </div>
          {COLUMNS.map(([title, links]) => (
            <div key={title}>
              <div className="eyebrow">{title}</div>
              <ul className="m-0 list-none space-y-2 p-0">
                {links.map(([label, to]) => (
                  <li key={label}><Link to={to} className="text-sm text-muted-foreground no-underline hover:text-foreground">{label}</Link></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="row spread border-t border-border py-5 text-[13px]">
          <span>Payments held in escrow until delivery is confirmed or the protection window ends.</span>
          <span className="mono">Card data is entered only on our payment partner's hosted page.</span>
        </div>
      </div>
    </footer>
  );
}
