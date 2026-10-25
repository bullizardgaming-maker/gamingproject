import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, one } from '../db.js';
import { toCsv } from './exports.js';

/**
 * Round 23a: newsletter consent. Unticked by default at sign-up and in Account settings; the choice and its time
 * are stored on the user (news_opt_in, news_opt_in_at). With BREVO_API_KEY the worker copies each change to Brevo
 * (contacts in "Newsletter EN" or "Newsletter AR" by the user's language; campaigns are sent from Brevo with the
 * sender NEWSLETTER_SENDER). Without it, Ops downloads the subscriber list as CSV.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function setNewsOptIn(q: Queryable, userId: string, optIn: boolean) {
  await q.query(`UPDATE users SET news_opt_in = $2, news_opt_in_at = now() WHERE id = $1 AND news_opt_in IS DISTINCT FROM $2`, [userId, optIn]);
  return one<{ news_opt_in: boolean; news_opt_in_at: string | null }>(q, `SELECT news_opt_in, news_opt_in_at FROM users WHERE id = $1`, [userId]);
}

const listFor = (ctx: Ctx, locale: string | null) => (locale === 'ar' ? ctx.cfg.BREVO_LIST_ID_AR : ctx.cfg.BREVO_LIST_ID_EN);

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
 * Worker: push consent changes made since the last sync to Brevo. Opted in → the contact is created/updated in the
 * list for their language (and taken off the other list); opted out → taken off both lists. A failed call is
 * retried on the next run (news_synced_at stays behind news_opt_in_at). Returns the number synced.
 */
export async function syncNewsletter(ctx: Ctx, fetchImpl: FetchLike = fetch, limit = 100): Promise<number> {
  if (!ctx.cfg.BREVO_API_KEY) return 0;
  const lists = [ctx.cfg.BREVO_LIST_ID_EN, ctx.cfg.BREVO_LIST_ID_AR].filter((id): id is number => !!id);
  if (!lists.length) {
    ctx.log.warn({}, 'BREVO_API_KEY is set but BREVO_LIST_ID_EN / BREVO_LIST_ID_AR are not: newsletter sync skipped');
    return 0;
  }
  const call = brevo(ctx, fetchImpl);
  const due = await many<{ id: string; email: string; locale: string | null; news_opt_in: boolean; news_opt_in_at: string }>(
    ctx.db,
    `SELECT id, email, locale, news_opt_in, news_opt_in_at::text AS news_opt_in_at FROM users
      WHERE news_opt_in_at IS NOT NULL AND (news_synced_at IS NULL OR news_synced_at < news_opt_in_at) AND deleted_at IS NULL
      ORDER BY news_opt_in_at LIMIT $1`,
    [limit],
  );
  let synced = 0;
  for (const u of due) {
    try {
      let res: Response;
      if (u.news_opt_in) {
        const list = listFor(ctx, u.locale) ?? lists[0]!;
        res = await call('POST', '/v3/contacts', {
          email: u.email,
          listIds: [list],
          unlinkListIds: lists.filter((l) => l !== list),
          updateEnabled: true,
          attributes: { LANGUAGE: u.locale === 'ar' ? 'ar' : 'en' },
        });
      } else {
        res = await call('PUT', `/v3/contacts/${encodeURIComponent(u.email)}`, { unlinkListIds: lists });
        if (res.status === 404) res = new Response(null, { status: 204 }); // never reached Brevo: nothing to remove
      }
      if (!res.ok) throw new Error(`brevo ${res.status}: ${(await res.text()).slice(0, 200)}`);
      // Only if the choice did not change again while we were calling.
      // (Compared as text: a JS Date would drop the microseconds.)
      await ctx.db.query(`UPDATE users SET news_synced_at = now() WHERE id = $1 AND news_opt_in_at = $2::timestamptz`, [u.id, u.news_opt_in_at]);
      synced++;
    } catch (err) {
      ctx.log.warn({ err: (err as Error).message, userId: u.id }, 'newsletter sync failed; retried next run');
    }
  }
  return synced;
}

/** Account deletion: a contact that reached Brevo is deleted there too (best effort, logged on failure). */
export async function forgetNewsletterContact(ctx: Ctx, email: string, fetchImpl: FetchLike = fetch) {
  if (!ctx.cfg.BREVO_API_KEY) return;
  try {
    const res = await brevo(ctx, fetchImpl)('DELETE', `/v3/contacts/${encodeURIComponent(email)}`);
    if (!res.ok && res.status !== 404) throw new Error(`brevo ${res.status}`);
  } catch (err) {
    ctx.log.error({ err: (err as Error).message }, 'newsletter contact not deleted at Brevo; delete it by hand');
  }
}

/** Ops: everyone opted in, for importing into the newsletter tool by hand (when Brevo sync is off). */
export async function newsletterCsv(q: Queryable) {
  const rows = await many<{ email: string; display_name: string; locale: string | null; news_opt_in_at: string }>(
    q,
    `SELECT email, display_name, locale, news_opt_in_at FROM users WHERE news_opt_in AND deleted_at IS NULL AND status <> 'banned' ORDER BY news_opt_in_at`,
  );
  return toCsv(
    ['email', 'name', 'language', 'list', 'opted_in_at'],
    rows.map((r) => ({ email: r.email, name: r.display_name, language: r.locale === 'ar' ? 'ar' : 'en', list: r.locale === 'ar' ? 'Newsletter AR' : 'Newsletter EN', opted_in_at: new Date(r.news_opt_in_at) })),
  );
}
