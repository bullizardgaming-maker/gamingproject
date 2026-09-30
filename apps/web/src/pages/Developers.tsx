import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../session';

const SCOPES = ['orders:read', 'orders:write', 'inventory:write', 'offers:write', 'chat:write'];
const EVENTS = ['order.created', 'order.delivered', 'order.completed', 'order.disputed', 'order.refunded', 'order.cancelled', 'offer.low_stock', 'chat.message', 'chargeback.created'];

const VERIFY_SNIPPET = `import { createHmac, timingSafeEqual } from 'node:crypto';

// Express: app.post('/hooks', express.raw({ type: 'application/json' }), handler)
function handler(req, res) {
  const expected = createHmac('sha256', process.env.WEBHOOK_SECRET).update(req.body).digest('hex');
  const given = Buffer.from(req.get('X-Hook-Signature') ?? '');
  if (given.length !== expected.length || !timingSafeEqual(given, Buffer.from(expected))) {
    return res.sendStatus(401);
  }
  const event = JSON.parse(req.body);
  // Retries reuse the same Idempotency-Key (= event.id): skip ones you've processed.
  if (alreadyProcessed(req.get('Idempotency-Key'))) return res.sendStatus(200);
  handle(event);
  res.sendStatus(200);
}`;

export function Developers() {
  const { user } = useSession();
  const [keys, setKeys] = useState<any[]>([]);
  const [hooks, setHooks] = useState<any[]>([]);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [k, h] = await Promise.all([api<any[]>('/developer/api-keys'), api<any[]>('/developer/webhooks')]);
    setKeys(k);
    setHooks(h);
  }, []);
  useEffect(() => {
    if (user && user.kyc_tier >= 2) load().catch(() => {});
  }, [user, load]);

  const run = async (fn: () => Promise<void>) => {
    setError('');
    try {
      await fn();
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="stack">
      <h1 style={{ fontSize: 40 }}>Seller API</h1>
      <p className="lede">
        Automate your shop: read orders, push stock, change prices, deliver and reply to buyers. Every request is recorded exactly like an
        action in the website.
      </p>
      <p>
        <a className="btn ghost" href="/v1/docs/" target="_blank" rel="noreferrer">Full API reference</a>{' '}
        <a className="small" href="/v1/openapi.json" target="_blank" rel="noreferrer">OpenAPI JSON</a>
      </p>
      <div className="card">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Endpoint</th><th>Scope</th><th>Does</th></tr></thead>
            <tbody>
              <tr><td className="mono">GET /v1/merchant/orders</td><td className="mono">orders:read</td><td>List orders, filter by status and updated time</td></tr>
              <tr><td className="mono">POST /v1/merchant/orders/:id/deliver</td><td className="mono">orders:write</td><td>Deliver a manual order, optionally with encrypted details</td></tr>
              <tr><td className="mono">POST /v1/merchant/inventory</td><td className="mono">inventory:write</td><td>Upload codes (.txt or JSON) for instant delivery</td></tr>
              <tr><td className="mono">PATCH /v1/merchant/prices</td><td className="mono">offers:write</td><td>Change up to 500 prices; pass a version to avoid overwriting newer edits</td></tr>
              <tr><td className="mono">POST /v1/merchant/chat/:roomId/messages</td><td className="mono">chat:write</td><td>Reply to a buyer in the order chat</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      {!user || user.kyc_tier < 2 ? (
        <div className="notice">API keys and webhooks are available to identity-verified sellers. <Link to="/account">Verify your identity</Link></div>
      ) : (
        <>
          {error && <div className="alert">{error}</div>}
          {secret && (
            <div className="ok stack">
              <b>Copy this now. It won't be shown again.</b>
              <div className="secret">{secret}</div>
            </div>
          )}
          <div className="grid two">
            <form
              className="card stack"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                run(async () => {
                  const k = await api<{ key: string }>('/developer/api-keys', { body: { name: fd.get('name'), scopes: fd.getAll('scope') } });
                  setSecret(k.key);
                });
              }}
            >
              <h3>API keys</h3>
              {keys.filter((k) => !k.revoked_at).map((k) => (
                <div key={k.id} className="row spread small">
                  <span><b>{k.name}</b> <span className="mono muted">mk_{k.prefix}_…</span></span>
                  <button type="button" className="btn ghost" onClick={() => run(() => api(`/developer/api-keys/${k.id}`, { method: 'DELETE' }))}>Revoke</button>
                </div>
              ))}
              <label className="field">Key name<input name="name" required placeholder="Pricing bot" /></label>
              <div className="row small">
                {SCOPES.map((s) => (
                  <label key={s} className="row" style={{ gap: 6 }}><input type="checkbox" name="scope" value={s} style={{ width: 'auto' }} /> <span className="mono">{s}</span></label>
                ))}
              </div>
              <button className="btn">Create key</button>
            </form>

            <form
              className="card stack"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                run(async () => {
                  const h = await api<{ secret: string }>('/developer/webhooks', { body: { url: fd.get('url'), events: fd.getAll('event') } });
                  setSecret(h.secret);
                });
              }}
            >
              <h3>Webhooks</h3>
              {hooks.filter((h) => h.active).map((h) => (
                <div key={h.id} className="row spread small">
                  <span className="mono">{h.url}</span>
                  <span className="row">
                    <button type="button" className="btn ghost" onClick={() => run(() => api(`/developer/webhooks/${h.id}/test`, { body: {} }))}>Send test</button>
                    <button type="button" className="btn ghost" onClick={() => run(() => api(`/developer/webhooks/${h.id}`, { method: 'DELETE' }))}>Remove</button>
                  </span>
                </div>
              ))}
              <label className="field">Endpoint URL<input name="url" type="url" required placeholder="https://your-shop.example/hooks" /></label>
              <div className="row small">
                {EVENTS.map((ev) => (
                  <label key={ev} className="row" style={{ gap: 6 }}><input type="checkbox" name="event" value={ev} style={{ width: 'auto' }} /> <span className="mono">{ev}</span></label>
                ))}
              </div>
              <button className="btn">Add endpoint</button>
            </form>
          </div>
        </>
      )}

      <div className="card stack">
        <h3>Verifying webhooks</h3>
        <p className="muted small">
          Each delivery is a POST with the event JSON. <span className="mono">X-Hook-Signature</span> is the hex HMAC-SHA256 of the exact raw body,
          keyed with your endpoint secret. Failed deliveries are retried with exponential backoff (30s, 1m, 2m … up to 6h, 12 attempts),
          always with the same <span className="mono">Idempotency-Key</span>, so never deliver goods twice for one key.
        </p>
        <pre className="secret" style={{ whiteSpace: 'pre', overflowX: 'auto' }}>{VERIFY_SNIPPET}</pre>
      </div>
    </div>
  );
}
