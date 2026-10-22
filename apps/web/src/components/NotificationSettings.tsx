import { useEffect, useState } from 'react';
import { BellRinging as BellRing, DeviceMobile as Smartphone, Trash as Trash2 } from '@phosphor-icons/react';
import { DEMO, api } from '../api';

interface Pref {
  category: string;
  label: string;
  enabled: boolean;
}

function keyToBytes(base64url: string) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Web Push on this device, plus which kinds of notification are pushed. */
export function PushSettings() {
  const [config, setConfig] = useState<{ enabled: boolean; vapidPublicKey: string | null } | null>(null);
  const [devices, setDevices] = useState<Array<{ id: string; user_agent: string | null; created_at: string; last_success_at: string | null }>>([]);
  const [prefs, setPrefs] = useState<Pref[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'alert' | 'notice'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  const load = async () => {
    const c = await api<{ enabled: boolean; vapidPublicKey: string | null }>('/push/config');
    setConfig(c);
    if (c.enabled) {
      setDevices(await api('/me/push-subscriptions'));
      setPrefs(await api('/me/push-preferences'));
    }
  };
  useEffect(() => {
    load().catch(() => setConfig({ enabled: false, vapidPublicKey: null }));
  }, []);

  const enable = async () => {
    setMsg(null);
    setBusy(true);
    try {
      if ((await Notification.requestPermission()) !== 'granted') {
        setMsg({ kind: 'alert', text: 'Notifications are blocked for this site in your browser settings.' });
        return;
      }
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(config!.vapidPublicKey!) }));
      await api('/me/push-subscriptions', { body: sub.toJSON() });
      setMsg({ kind: 'ok', text: 'Push notifications are on for this device.' });
      await load();
    } catch (e: any) {
      setMsg({ kind: 'alert', text: e.message ?? 'Could not turn on push notifications.' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await api(`/me/push-subscriptions/${id}`, { method: 'DELETE' });
    await load();
  };
  const toggle = async (category: string, enabled: boolean) => setPrefs(await api('/me/push-preferences', { method: 'PATCH', body: { [category]: enabled } }));

  return (
    <div className="card stack">
      <div className="row spread">
        <h3 style={{ margin: 0 }} className="inline-flex items-center gap-2"><BellRing className="size-5" /> Push notifications</h3>
      </div>
      {config === null ? (
        <p className="muted small">Loading…</p>
      ) : !config.enabled ? (
        <p className="muted small">
          {DEMO
            ? 'In the live app, order updates, payouts and security alerts can also arrive as push notifications on your phone or desktop. This preview shows them in the bell only.'
            : 'Push notifications aren’t switched on for this marketplace yet. You still get everything in the bell and by email.'}
        </p>
      ) : (
        <>
          <p className="muted small">Get order updates, payouts and security alerts on this device, even when the site is closed.</p>
          {supported ? (
            <button className="btn" disabled={busy} onClick={enable} style={{ alignSelf: 'flex-start' }}>
              {busy ? 'Turning on…' : 'Turn on for this device'}
            </button>
          ) : (
            <div className="notice">This browser doesn’t support push. On iPhone, add the site to your Home Screen first.</div>
          )}
          {devices.map((d) => (
            <div key={d.id} className="row spread small" style={{ borderTop: '1px solid var(--rule)', paddingTop: 10 }}>
              <span className="inline-flex items-center gap-2">
                <Smartphone className="size-4" />
                <span>
                  {(d.user_agent ?? 'Device').slice(0, 60)}
                  <span className="muted"> · {d.last_success_at ? `last push ${new Date(d.last_success_at).toLocaleDateString()}` : 'added ' + new Date(d.created_at).toLocaleDateString()}</span>
                </span>
              </span>
              <button className="btn ghost" aria-label="Remove device" onClick={() => remove(d.id)}><Trash2 className="size-4" /></button>
            </div>
          ))}
          {prefs.length > 0 && (
            <div className="checklist">
              <div>
                {prefs.map((p) => (
                  <label key={p.category}>
                    <input type="checkbox" checked={p.enabled} onChange={(e) => toggle(p.category, e.target.checked)} />
                    <span>{p.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      {msg && <div className={msg.kind}>{msg.text}</div>}
    </div>
  );
}
