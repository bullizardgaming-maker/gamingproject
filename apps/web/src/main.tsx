import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { SessionProvider } from './session';
import { Home } from './pages/Home';
import { Market } from './pages/Market';
import { OfferPage } from './pages/OfferPage';
import { OrderPage } from './pages/OrderPage';
import { InquiryChat, Orders } from './pages/Orders';
import { Sell } from './pages/Sell';
import { Developers } from './pages/Developers';
import { Account, ForgotPassword, Login, ResetPassword } from './pages/Account';
import { Admin } from './pages/Admin';
import { GamePage, Games } from './pages/Games';
import { SellerPage } from './pages/SellerPage';
import { SiteHeader } from './components/SiteHeader';
import { SiteFooter } from './components/SiteFooter';
import { DEMO } from './api';
import { DemoBanner, DemoCheckout } from './demo/DemoUi';
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

function App() {
  return (
    <SessionProvider>
      {DEMO && <DemoBanner />}
      <SiteHeader />
      <ScrollToTop />
      <main className="shell">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/market" element={<Market />} />
          <Route path="/games" element={<Games />} />
          <Route path="/games/:slug" element={<GamePage />} />
          <Route path="/games/:slug/:category" element={<GamePage />} />
          <Route path="/sellers/:id" element={<SellerPage />} />
          <Route path="/offers/:id" element={<OfferPage />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/orders/:id" element={<OrderPage />} />
          <Route path="/chat/:id" element={<InquiryChat />} />
          <Route path="/sell" element={<Sell />} />
          <Route path="/sell/money" element={<Sell />} />
          <Route path="/sell/invoices" element={<Navigate to="/sell/money" replace />} />
          <Route path="/developers" element={<Developers />} />
          <Route path="/login" element={<Login />} />
          <Route path="/account" element={<Account />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/admin" element={<Admin />} />
          {DEMO && <Route path="/demo-checkout/:id" element={<DemoCheckout />} />}
          <Route path="*" element={<div className="card"><h2>Page not found</h2><Link to="/games">Browse all games</Link></div>} />
        </Routes>
      </main>
      <SiteFooter />
    </SessionProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
