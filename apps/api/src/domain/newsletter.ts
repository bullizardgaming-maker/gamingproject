import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { toCsv } from './exports.js';

/**
 * Round 23a: newsletter consent. Unticked by default at sign-up and in Account settings; the choice and its time
 * are stored on the user (news_opt_in, news_opt_in_at). With BREVO_API_KEY the worker copies each change to Brevo
 * (contacts in "Newsletter EN" or "Newsletter AR" by the user's language; campaigns are sent from Brevo with the
 * sender NEWSLETTER_SENDER). Without it, Ops downloads the subscriber list as CSV.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function setNewsOptIn(q: Queryable, userId: string, optIn: boolean) {
  await q.query(`UPDATE users SET news_opt_in = $2, news_opt_in_at = now(), news_opt_out_at = CASE WHEN $2 THEN news_opt_out_at ELSE now() END WHERE id = $1 AND news_opt_in IS DISTINCT FROM $2`, [userId, optIn]);
  return one<{ news_opt_in: boolean; news_opt_in_at: string | null }>(q, `SELECT news_opt_in, news_opt_in_at FROM users WHERE id = $1`, [userId]);
}


function brevo(ctx: Ctx, fetchImpl: FetchLike) {
  const base = ctx.cfg.BREVO_API_URL.replace(/\/+$/, '');
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { 'api-key': ctx.cfg.BREVO_API_KEY!, accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return res;
  };
}

/**
 * Worker: make Brevo match what each user should be (Round 23b). A user belongs in a list only while opted in,
 * active (not banned or suspended) and not deleted: the list for their language (Arabic → AR, others → EN), under
 * their current address. Whatever Brevo holds is recorded (news_synced_email, news_synced_list), so a ban, an address
 * change or a language change takes the old contact off its list and adds the new one. Failures are retried on the
 * next run. Brevo's own unsubscribes are pulled first (pullBrevoUnsubscribes), so they are never re-subscribed.
 */
export async function syncNewsletter(ctx: Ctx, fetchImpl: FetchLike = fetch, limit = 100): Promise<number> {
  if (!ctx.cfg.BREVO_API_KEY) return 0;
  const lists = [ctx.cfg.BREVO_LIST_ID_EN, ctx.cfg.BREVO_LIST_ID_AR].filter((id): id is number => !!id);
  if (!lists.length) {
    ctx.log.warn({}, 'BREVO_API_KEY is set but BREVO_LIST_ID_EN / BREVO_LIST_ID_AR are not: newsletter sync skipped');
    return 0;
  }
  await pullBrevoUnsubscribes(ctx, fetchImpl).catch((err) => ctx.log.warn({ err: (err as Error).message }, 'newsletter unsubscribes not pulled; retried next run'));
  const en = ctx.cfg.BREVO_LIST_ID_EN ?? lists[0]!;
  const ar = ctx.cfg.BREVO_LIST_ID_AR ?? lists[0]!;
  const call = brevo(ctx, fetchImpl);
  const due = await many<{ id: string; email: string; locale: string | null; want: number | null; synced_email: string | null; synced_list: number | null }>(
    ctx.db,
    `SELECT id, email, locale, want, news_synced_email AS synced_email, news_synced_list AS synced_list FROM (
       SELECT u.*, CASE WHEN u.news_opt_in AND u.status = 'active' AND u.deleted_at IS NULL THEN (CASE WHEN u.locale = 'ar' THEN $2::int ELSE $1::int END) END AS want
         FROM users u WHERE u.news_opt_in OR u.news_synced_list IS NOT NULL) x
      WHERE (want IS DISTINCT FROM news_synced_list OR (want IS NOT NULL AND email IS DISTINCT FROM news_synced_email))
        AND (news_sync_next_at IS NULL OR news_sync_next_at <= now()) AND news_sync_attempts < $4
      ORDER BY news_opt_in_at NULLS FIRST LIMIT $3`,
    [en, ar, limit, SYNC_MAX_ATTEMPTS],
  );
  let synced = 0;
  await retryForgets(ctx, fetchImpl);
  for (const u of due) {
    try {
      // The contact Brevo has now, if it is not the one we want: off every list (a missing contact is fine).
      if (u.synced_email && (u.want === null || u.synced_email !== u.email)) {
        const res = await call('PUT', `/v3/contacts/${encodeURIComponent(u.synced_email)}`, { unlinkListIds: lists });
        if (!res.ok && res.status !== 404) throw new Error(`brevo ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      if (u.want !== null) {
        const res = await call('POST', '/v3/contacts', {
          email: u.email,
          listIds: [u.want],
          unlinkListIds: lists.filter((l) => l !== u.want),
          updateEnabled: true,
          attributes: { LANGUAGE: u.locale === 'ar' ? 'ar' : 'en' },
        });
        if (!res.ok) throw new Error(`brevo ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      await ctx.db.query(`UPDATE users SET news_synced_email = $2, news_synced_list = $3, news_synced_at = now(), news_sync_attempts = 0, news_sync_next_at = NULL WHERE id = $1`, [u.id, u.want === null ? null : u.email, u.want]);
      synced++;
    } catch (err) {
      // Round 23d (item 10): a row that keeps failing backs off (2^n minutes, at most 6 h) and after SYNC_MAX_ATTEMPTS
      // is parked with an error log, so it never blocks the rest of the queue.
      const r = await one<{ attempts: number }>(
        ctx.db,
        `UPDATE users SET news_sync_attempts = news_sync_attempts + 1,
                news_sync_next_at = CASE WHEN news_sync_attempts = 0 THEN NULL ELSE now() + least(make_interval(mins => power(2, news_sync_attempts)::int), interval '6 hours') END
          WHERE id = $1 RETURNING news_sync_attempts AS attempts`,
        [u.id],
      );
      if (r.attempts >= SYNC_MAX_ATTEMPTS) ctx.log.error({ err: (err as Error).message, userId: u.id }, 'newsletter sync gave up on this user after repeated failures; fix at Brevo and reset news_sync_attempts');
      else ctx.log.warn({ err: (err as Error).message, userId: u.id, attempts: r.attempts }, 'newsletter sync failed; retried later');
    }
  }
  return synced;
}

/**
 * Brevo → us (Round 23b): contacts that unsubscribed in Brevo (the link in a newsletter: blacklisted, or unsubscribed
 * from our list) are opted out here, so neither the sync nor the CSV export subscribes them again. Reads the contacts
 * of each list changed since the last pull (one hour of overlap). Returns the number opted out.
 */
export async function pullBrevoUnsubscribes(ctx: Ctx, fetchImpl: FetchLike = fetch): Promise<number> {
  if (!ctx.cfg.BREVO_API_KEY) return 0;
  const lists = [ctx.cfg.BREVO_LIST_ID_EN, ctx.cfg.BREVO_LIST_ID_AR].filter((id): id is number => !!id);
  const call = brevo(ctx, fetchImpl);
  const last = await maybeOne<{ value: string }>(ctx.db, `SELECT value::text AS value FROM newsletter_state WHERE key = 'unsubscribes_pulled_at'`);
  const since = new Date(last ? new Date(last.value).getTime() - 3_600_000 : Date.now() - 30 * 86_400_000).toISOString();
  const startedAt = new Date().toISOString();
  let optedOut = 0;
  for (const list of lists) {
    for (let offset = 0; ; offset += 500) {
      const res = await call('GET', `/v3/contacts/lists/${list}/contacts?limit=500&offset=${offset}&modifiedSince=${encodeURIComponent(since)}`);
      if (!res.ok) throw new Error(`brevo ${res.status}`);
      const body = (await res.json()) as { contacts?: Array<{ email: string; emailBlacklisted?: boolean; listUnsubscribed?: number[] }> };
      const contacts = body.contacts ?? [];
      const gone = contacts.filter((c) => c.emailBlacklisted || c.listUnsubscribed?.includes(list)).map((c) => c.email.toLowerCase());
      if (gone.length) {
        // Round 23d (item 10): the consent time (news_opt_in_at) is kept as evidence; the opt-out has its own column.
        const r = await ctx.db.query(
          `UPDATE users SET news_opt_in = false, news_opt_out_at = now() WHERE news_opt_in AND lower(email) = ANY($1::text[])`,
          [gone],
        );
        optedOut += r.rowCount ?? 0;
      }
      if (contacts.length < 500) break;
    }
  }
  await ctx.db.query(
    `INSERT INTO newsletter_state (key, value) VALUES ('unsubscribes_pulled_at', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [startedAt],
  );
  return optedOut;
}

/**
 * Account deletion: the contact Brevo holds (the synced address, which may differ from the current one) is deleted
 * there too. A failure is queued (newsletter_forget_queue) and retried by every sync run with the stored address,
 * since the account's own copy of the address is scrubbed right after (Round 23d, item 10).
 */
export async function forgetNewsletterContact(ctx: Ctx, email: string, fetchImpl: FetchLike = fetch) {
  if (!ctx.cfg.BREVO_API_KEY) return;
  try {
    const res = await brevo(ctx, fetchImpl)('DELETE', `/v3/contacts/${encodeURIComponent(email)}`);
    if (!res.ok && res.status !== 404) throw new Error(`brevo ${res.status}`);
  } catch (err) {
    ctx.log.warn({ err: (err as Error).message }, 'newsletter contact not deleted at Brevo yet; queued for retry');
    await ctx.db.query(`INSERT INTO newsletter_forget_queue (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`, [email]);
  }
}

const SYNC_MAX_ATTEMPTS = 10;
async function retryForgets(ctx: Ctx, fetchImpl: FetchLike) {
  const due = await many<{ email: string; attempts: number }>(ctx.db, `SELECT email, attempts FROM newsletter_forget_queue WHERE next_at <= now() AND attempts < $1 ORDER BY next_at LIMIT 50`, [SYNC_MAX_ATTEMPTS]);
  for (const f of due) {
    try {
      const res = await brevo(ctx, fetchImpl)('DELETE', `/v3/contacts/${encodeURIComponent(f.email)}`);
      if (!res.ok && res.status !== 404) throw new Error(`brevo ${res.status}`);
      await ctx.db.query('DELETE FROM newsletter_forget_queue WHERE email = $1', [f.email]);
    } catch (err) {
      await ctx.db.query(`UPDATE newsletter_forget_queue SET attempts = attempts + 1, next_at = now() + least(make_interval(mins => power(2, attempts + 1)::int), interval '6 hours') WHERE email = $1`, [f.email]);
      if (f.attempts + 1 >= SYNC_MAX_ATTEMPTS) ctx.log.error({ err: (err as Error).message }, 'newsletter contact could not be deleted at Brevo after repeated tries; delete it by hand (newsletter_forget_queue)');
    }
  }
}

/** Ops: everyone opted in, for importing into the newsletter tool by hand (when Brevo sync is off). */
export async function newsletterCsv(q: Queryable) {
  const rows = await many<{ email: string; display_name: string; locale: string | null; news_opt_in_at: string }>(
    q,
    `SELECT email, display_name, locale, news_opt_in_at FROM users WHERE news_opt_in AND deleted_at IS NULL AND status = 'active' ORDER BY news_opt_in_at`,
  );
  return toCsv(
    ['email', 'name', 'language', 'list', 'opted_in_at'],
    rows.map((r) => ({ email: r.email, name: r.display_name, language: r.locale === 'ar' ? 'ar' : 'en', list: r.locale === 'ar' ? 'Newsletter AR' : 'Newsletter EN', opted_in_at: new Date(r.news_opt_in_at) })),
  );
}
