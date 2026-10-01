import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from './session';
import { Home } from './pages/Home';
import { Market } from './pages/Market';
import { OfferPage } from './pages/OfferPage';
import { OrderPage } from './pages/OrderPage';
import { InquiryChat, Orders } from './pages/Orders';
import { Sell } from './pages/Sell';
import { Developers } from './pages/Developers';
import { Account, ForgotPassword, Login, ResetPassword } from './pages/Account';
import { Admin } from './pages/Admin';
import { DEMO } from './api';
import { NotificationBell } from './components/NotificationBell';
import { DemoBanner, DemoCheckout } from './demo/DemoUi';
import './tailwind.css';
import './styles.css';

function TopBar() {
  const { user, signOut } = useSession();
  return (
    <header className="topbar">
      <div className="shell">
        <Link to="/" className="brand"><span className="brand-mark" aria-hidden />Bullizard</Link>
        <nav className="nav" aria-label="Main">
          <NavLink to="/market">Market</NavLink>
          {user && <NavLink to="/orders">Orders</NavLink>}
          <NavLink to="/sell">Sell</NavLink>
          <NavLink to="/developers">API</NavLink>
          {user && user.role !== 'user' && <NavLink to="/admin">Operations</NavLink>}
        </nav>
        <div className="who">
          {user ? (
            <>
              <NotificationBell />
              <Link to="/account" className="small">
                <span className="email">{user.display_name} · </span>level {user.kyc_tier}
              </Link>
              <button className="btn ghost" onClick={signOut}>Sign out</button>
            </>
          ) : (
            <Link className="btn" to="/login">Sign in</Link>
          )}
        </div>
      </div>
    </header>
  );
}

function App() {
  return (
    <SessionProvider>
      {DEMO && <DemoBanner />}
      <TopBar />
      <main className="shell">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/market" element={<Market />} />
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
          <Route path="*" element={<div className="card"><h2>Page not found</h2><Link to="/market">Go to the market</Link></div>} />
        </Routes>
      </main>
      <footer>
        <div className="shell row spread">
          <span>Payments held in escrow until delivery is confirmed or the protection window ends.</span>
          <span className="mono">Card data is entered only on our payment partner's hosted page.</span>
        </div>
      </footer>
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
