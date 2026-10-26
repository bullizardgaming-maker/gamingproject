/**
 * Staging kill-switch test (launch gate §4). Pauses orders, withdrawals, chat and sign-ups through the staff API
 * (PUT /v1/admin/controls, permission controls.manage), checks that each paused action is refused with its 503 code
 * and that /v1/features reports it, then resumes everything and checks chat works again. The switches are always
 * resumed at the end, also when a check fails or the script is interrupted (and the workflow resumes them once more).
 *
 *   API_URL=https://api-staging.bullizard.com STAGING_TEST_TOKEN=... STAFF_EMAIL=... STAFF_PASSWORD=... \
 *   STAFF_TOTP_SECRET=... BUYER_EMAIL=... BUYER_PASSWORD=... SELLER_EMAIL=... SELLER_PASSWORD=... npx tsx scripts/kill-switch.ts
 *   npx tsx scripts/kill-switch.ts --resume-only     # just switch everything back on
 *
 * Needs SANDBOX_MODE (the seller is made Tier 2 with /v1/sandbox/verify-me so the withdrawal check reaches the switch).
 * Creates one listing and one pre-sale chat; never creates orders, withdrawals or accounts (they are refused).
 */
import { api, call, need, signIn, type Api } from './staging-client.js';

const SWITCHES = ['orders', 'withdrawals', 'chat', 'signups'] as const;
const OFF = { pause_orders: false, pause_withdrawals: false, pause_chat: false, pause_signups: false, pause_message: null };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(ok: boolean, what: string, note = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${note ? ` — ${note}` : ''}`);
}

/** The API caches the switches for 5 s per instance: retry for up to 30 s. */
async function eventually(fn: () => Promise<boolean>, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > until) return false;
    await sleep(2_000);
  }
}

async function resume(staff: Api) {
  const r = await staff.put('/admin/controls', OFF);
  const ok = r.status === 200 && SWITCHES.every((s) => r.body[`pause_${s}`] === false);
  check(ok, 'resume all switches', ok ? '' : `${r.status} ${r.body?.error?.code ?? ''}`);
  return ok;
}

async function main() {
  const staff = api(await signIn('staff', need('STAFF_EMAIL'), need('STAFF_PASSWORD'), process.env.STAFF_TOTP_SECRET || undefined));
  if (process.argv.includes('--resume-only')) {
    process.exit((await resume(staff)) ? 0 : 1);
  }
  const before = await staff.get('/admin/controls');
  if (before.status !== 200) throw new Error(`staff cannot read the controls: ${before.status} ${before.body?.error?.code ?? ''} (needs controls.manage and a 2FA session)`);
  if (SWITCHES.some((s) => before.body[`pause_${s}`])) console.log('note: some switches were already on; they are all off at the end');

  const seller = api(await signIn('seller', need('SELLER_EMAIL'), need('SELLER_PASSWORD')));
  const buyer = api(await signIn('buyer', need('BUYER_EMAIL'), need('BUYER_PASSWORD')));
  await seller.post('/sandbox/verify-me');
  await buyer.post('/sandbox/verify-me');
  const run = Date.now().toString(36);
  const offer = (await seller.post('/offers', { categorySlug: 'currency', game: 'Albion Online', title: `Kill switch ${run}`, priceCents: 5_00, deliveryMode: 'manual', stock: 10, unitLabel: 'M', unitSize: 1_000_000, minQty: 1, attributes: { server: 'Europe' } })).body;
  if (!offer?.id) throw new Error('could not create the test listing');
  const room = (await buyer.post('/chat/rooms', { offerId: offer.id })).body;
  if (!room?.id) throw new Error('could not open the pre-sale chat');

  let interrupted = false;
  const onSignal = async () => {
    if (interrupted) return;
    interrupted = true;
    await resume(staff).catch(() => {});
    process.exit(1);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const paused = await staff.put('/admin/controls', { pause_orders: true, pause_withdrawals: true, pause_chat: true, pause_signups: true, pause_message: 'Staging kill-switch test' });
    check(paused.status === 200, 'pause all switches', `${paused.status}`);

    check(await eventually(async () => {
      const f = (await call('GET', '/features')).body;
      return SWITCHES.every((s) => f?.paused?.[s] === true);
    }), '/features shows every switch paused');

    const refused = async (what: string, code: string, fn: () => Promise<{ status: number; body: any }>) => {
      let last: { status: number; body: any } = { status: 0, body: null };
      const ok = await eventually(async () => {
        last = await fn();
        return last.status === 503 && last.body?.error?.code === code;
      });
      check(ok, `${what} refused while paused`, `${last.status} ${last.body?.error?.code ?? ''}`);
    };
    await refused('new order', 'orders_paused', () => buyer.post('/orders', { offerId: offer.id, quantity: 1, acceptTos: true, characterName: 'KillSwitch' }));
    await refused('withdrawal', 'withdrawals_paused', () => seller.post('/seller/withdrawals', { amountCents: 2_000 }));
    await refused('chat message', 'chat_paused', () => buyer.post(`/chat/rooms/${room.id}/messages`, { body: 'Is this still available?' }));
    await refused('sign-up', 'signups_paused', () =>
      call('POST', '/auth/register', { email: `killswitch-${run}@example.invalid`, password: 'correct horse battery staple', displayName: 'Kill switch', acceptTerms: true }),
    );
  } finally {
    await resume(staff);
  }

  check(await eventually(async () => {
    const f = (await call('GET', '/features')).body;
    return SWITCHES.every((s) => f?.paused?.[s] === false);
  }), '/features shows every switch resumed');
  let chat = { status: 0 };
  check(await eventually(async () => (chat = await buyer.post(`/chat/rooms/${room.id}/messages`, { body: 'Is this still available?' })).status === 201), 'chat works again after resume', `${chat.status}`);
  await seller.patch(`/offers/${offer.id}`, { version: offer.version, status: 'removed' }).catch(() => {}); // tidy up

  console.log(`\n${failures ? `${failures} check(s) failed` : 'all kill-switch checks passed'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
