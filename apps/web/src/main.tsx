import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { HELP_CENTER } from '@/lib/features';
import { SessionProvider } from './session';
import { Home } from './pages/Home';
import { WalletPage } from './pages/Wallet';
import { Market } from './pages/Market';
import { OfferPage } from './pages/OfferPage';
import { OrderPage } from './pages/OrderPage';
import { InquiryChat, Orders } from './pages/Orders';
import { Sell } from './pages/Sell';
import { Messages } from './pages/Messages';
import { LegalHistory, LegalPage } from './pages/Legal';
import { Account, ForgotPassword, Login, ResetPassword } from './pages/Account';
import { Admin } from './pages/Admin';
import { GamePage, Games } from './pages/Games';
import { GameVotes } from './pages/GameVotes';
import { SellerPage } from './pages/SellerPage';
import { Watchlist } from './pages/Watchlist';
import { HelpArticlePage, HelpCentre, SupportList, SupportNew, SupportTicket } from './pages/Help';
import { StatusPage } from './pages/StatusPage';
import { MyProposals, MyRequests, RequestNew, RequestPage, RequestsBoard } from './pages/Requests';
import { SiteHeader } from './components/SiteHeader';
import { SiteFooter } from './components/SiteFooter';
import { LegalNotice } from './components/LegalNotice';
import { TurnstileUnloader } from './components/Turnstile';
import { DEMO } from './api';
import { DemoBanner, DemoCheckout } from './demo/DemoUi';
import { applyTheme } from '@/lib/prefs';
import { setUpPwa } from '@/lib/pwa';
import { initI18n, t, useLocale } from './i18n';
import './tailwind.css';
import './styles.css';

/** New page, new scroll position (but keep in-page #anchors and back/forward restoration). */
function ScrollToTop() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

/**
 * After a client-side navigation, screen readers hear nothing and keyboard focus is left on a link
 * that no longer exists. Announce the new page's title and put focus at the top of the content,
 * unless the page already placed it there (an autofocused field).
 */
function RouteAnnouncer() {
  const { pathname } = useLocation();
  const [message, setMessage] = useState('');
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // Where focus was when the navigation happened: if the user moves it before we act (opens a
    // menu, starts typing), leave it alone.
    const before = document.activeElement;
    // After the page has rendered and set its title.
    const timer = setTimeout(() => {
      setMessage(document.title);
      const main = document.getElementById('main');
      const active = document.activeElement;
      const untouched = !active || active === document.body || !active.isConnected || active === before;
      if (main && untouched && !main.contains(active)) main.focus({ preventScroll: true });
    }, 120);
    return () => clearTimeout(timer);
  }, [pathname]);
  return <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{message}</div>;
}

function App() {
  // A language switch remounts the app so every string, date and number re-renders in it.
  const locale = useLocale();
  return (
    <SessionProvider key={locale}>
      <a href="#main" className="skip-link">{t('a11y.skip')}</a>
      {DEMO && <DemoBanner />}
      <SiteHeader />
      <LegalNotice />
      <ScrollToTop />
      <RouteAnnouncer />
      <TurnstileUnloader />
      <main className="shell" id="main" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/market" element={<Market />} />
          <Route path="/games" element={<Games />} />
          <Route path="/games/vote" element={<GameVotes />} />
          <Route path="/games/:slug" element={<GamePage />} />
          <Route path="/games/:slug/:category" element={<GamePage />} />
          <Route path="/sellers/:id" element={<SellerPage />} />
          <Route path="/status" element={<StatusPage />} />
          <Route path="/watchlist" element={<Watchlist />} />
          <Route path="/requests" element={<RequestsBoard />} />
          <Route path="/requests/new" element={<RequestNew />} />
          <Route path="/requests/mine" element={<MyRequests />} />
          <Route path="/requests/proposals" element={<MyProposals />} />
          <Route path="/requests/:id" element={<RequestPage />} />
          <Route path="/help" element={HELP_CENTER ? <HelpCentre /> : <Navigate to="/support/new" replace />} />
          <Route path="/help/:slug" element={HELP_CENTER ? <HelpArticlePage /> : <Navigate to="/support/new" replace />} />
          <Route path="/support" element={<SupportList />} />
          <Route path="/support/new" element={<SupportNew />} />
          <Route path="/support/:id" element={<SupportTicket />} />
          <Route path="/offers/:id" element={<OfferPage />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="/orders/:id" element={<OrderPage />} />
          <Route path="/chat/:id" element={<InquiryChat />} />
          <Route path="/messages" element={<Messages />} />
          <Route path="/sell" element={<Sell />} />
          <Route path="/sell/money" element={<Sell />} />
          <Route path="/sell/analytics" element={<Sell />} />
          <Route path="/sell/invoices" element={<Navigate to="/sell/money" replace />} />
          <Route path="/terms" element={<LegalPage doc="terms" />} />
          <Route path="/terms/history" element={<LegalHistory doc="terms" />} />
          <Route path="/terms/versions/:version" element={<LegalPage doc="terms" />} />
          <Route path="/privacy" element={<LegalPage doc="privacy" />} />
          <Route path="/seller-agreement" element={<LegalPage doc="seller-agreement" />} />
          <Route path="/refunds" element={<LegalPage doc="refunds" />} />
          <Route path="/restricted-countries" element={<LegalPage doc="restricted-countries" />} />
          <Route path="/login" element={<Login />} />
          <Route path="/account" element={<Account />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/admin" element={<Admin />} />
          {DEMO && <Route path="/demo-checkout/:id" element={<DemoCheckout />} />}
          <Route path="*" element={<div className="card"><h2>{t('common.notFound')}</h2><Link to="/games">{t('game.browseAll')}</Link></div>} />
        </Routes>
      </main>
      <SiteFooter />
    </SessionProvider>
  );
}

applyTheme();

setUpPwa();
initI18n().then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  ),
);
