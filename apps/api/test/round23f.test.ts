import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as attachments from '../src/domain/attachments.js';
import { drainStorageDeletions } from '../src/domain/privacy.js';
import { createLogger } from '../src/observability.js';
import type { FileStorage } from '../src/providers/files.js';
import { buildApp } from '../src/server.js';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';

/** Round 23f part A (`claude/round-23f-fixes.md`): one test per item, each failing on 0f824b2. */
let h: Harness;
beforeAll(async () => {
  h = await setup({ VIDEO_METADATA_STRIP: 'ffmpeg', STORAGE_DIR: mkdtempSync(path.join(tmpdir(), 'bz-23f-')) });
});
afterAll(async () => {
  await h.close();
});

function capture() {
  const lines: any[] = [];
  const dest = new Writable({
    write(c, _e, cb) {
      for (const l of c.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(l));
      cb();
    },
  });
  return { lines, logger: createLogger({ ...h.ctx.cfg, LOG_LEVEL: 'info' } as any, dest as any) };
}

const storageWith = (over: Partial<FileStorage>): FileStorage => Object.assign(Object.create(h.ctx.storage), over);

/** A seller's proof video (several 1 KiB chunks), and a buyer who may view it. */
async function storedVideo() {
  const seller = await makeUser(h, { tier: 2 });
  const buyer = await makeUser(h);
  const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 5 });
  const order = await buyAndPay(h, buyer, offer.id);
  const room = (await buyer.api.get(`/v1/orders/${order.id}`)).body.room_id as string;
  const dir = mkdtempSync(path.join(tmpdir(), 'bz-23f-mp4-'));
  const f = path.join(dir, 'v.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=64x64:d=1', f]);
  const saved = attachments.downloadLimits.chunkBytes;
  attachments.downloadLimits.chunkBytes = 1024;
  try {
    const res = await seller.api.post(`/v1/chat/rooms/${room}/attachments`, readFileSync(f), { 'content-type': 'video/mp4', 'x-filename': 'p.mp4' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const key = (await h.ctx.db.query('SELECT storage_key FROM chat_attachments WHERE id = $1', [res.body.id])).rows[0].storage_key as string;
    return { id: res.body.id as string, buyer, key, bytes: await h.ctx.storage.get(key) };
  } finally {
    attachments.downloadLimits.chunkBytes = saved;
  }
}
const slots = async (userId: string) => Number((await h.ctx.db.query(`SELECT count(*)::int AS n FROM download_slots WHERE user_id = $1 AND finished_at IS NULL`, [userId])).rows[0].n);

describe('Round 23f part A', () => {
  it('1. request logs carry method, redacted url and status code', async () => {
    const { lines, logger } = capture();
    const app = await buildApp(h.ctx, { logger });
    try {
      await app.inject({ method: 'GET', url: '/v1/legal/terms?code=secret-oauth-code' });
    } finally {
      await app.close();
    }
    const incoming = lines.find((l) => l.msg === 'incoming request');
    expect(incoming.req).toMatchObject({ method: 'GET', url: '/v1/legal/terms?[redacted]' });
    expect(JSON.stringify(lines)).not.toContain('secret-oauth-code');
    expect(lines.find((l) => l.msg === 'request completed').res).toEqual({ statusCode: 200 });
  });

  it('2. a client that goes away mid-download destroys the storage read', async () => {
    const v = await storedVideo();
    const source = new PassThrough();
    source.write(v.bytes.subarray(0, 2048));
    const ctx = { ...h.ctx, storage: storageWith({ getStream: async () => source }) } as typeof h.ctx;
    const view = await attachments.openAttachment(ctx, v.id, { id: v.buyer.id, role: 'user' });
    view.stream.destroy(); // the response is torn down (client aborted)
    await new Promise((r) => setTimeout(r, 20));
    expect(source.destroyed).toBe(true);
    expect(await slots(v.buyer.id)).toBe(0);
  });

  it('3. the Terms version is served uncached (browser and Cloudflare); the web asks again on terms_stale', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/legal/terms' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['cdn-cache-control']).toBe('no-store');
    expect(res.headers['cloudflare-cdn-cache-control']).toBe('no-store');
    const web = (p: string) => readFileSync(new URL(`../../web/src/${p}`, import.meta.url), 'utf8');
    for (const page of ['pages/OfferPage.tsx', 'pages/Cart.tsx']) {
      expect(web(page)).toMatch(/e\.code === 'terms_stale'\) \{[\s\S]*?terms\.onStale\(\)/);
      expect(web(page)).toMatch(/<TermsChanged /);
    }
  });

  it('4. a storage read that never starts or stalls is dropped and frees its slot; the per-user limit is counted in the database (all nodes)', async () => {
    const v = await storedVideo();
    const saved = { ...attachments.downloadLimits };
    attachments.downloadLimits.firstByteMs = 100;
    attachments.downloadLimits.idleMs = 100;
    try {
      const silent = { ...h.ctx, storage: storageWith({ getStream: async () => new Readable({ read() {} }) }) } as typeof h.ctx;
      await expect(attachments.openAttachment(silent, v.id, { id: v.buyer.id, role: 'user' })).rejects.toMatchObject({ status: 504, code: 'storage_timeout' });
      await new Promise((r) => setTimeout(r, 20));
      expect(await slots(v.buyer.id)).toBe(0);
      // Stalls after the first chunk: the stream ends with an error and the slot is freed.
      const stall = new PassThrough();
      stall.write(v.bytes.subarray(0, 1024));
      const stalling = { ...h.ctx, storage: storageWith({ getStream: async () => stall }) } as typeof h.ctx;
      const view = await attachments.openAttachment(stalling, v.id, { id: v.buyer.id, role: 'user' });
      view.stream.resume();
      const err = await new Promise<Error>((resolve) => view.stream.once('error', resolve));
      expect((err as any).code).toBe('storage_timeout');
      await new Promise((r) => setTimeout(r, 20));
      expect(await slots(v.buyer.id)).toBe(0);
      // Another node's open streams count too (rows in download_slots).
      await h.ctx.db.query(`INSERT INTO download_slots (user_id) SELECT $1 FROM generate_series(1, $2)`, [v.buyer.id, attachments.downloadLimits.perUser]);
      await expect(attachments.openAttachment(h.ctx, v.id, { id: v.buyer.id, role: 'user' })).rejects.toMatchObject({ status: 429, code: 'downloads_busy' });
    } finally {
      Object.assign(attachments.downloadLimits, saved);
      await h.ctx.db.query(`DELETE FROM download_slots WHERE user_id = $1`, [v.buyer.id]);
    }
  });

  it('5. a queued storage deletion is skipped while a row still references the key', async () => {
    const v = await storedVideo();
    await h.ctx.db.query(`INSERT INTO storage_deletions (storage_key) VALUES ($1)`, [v.key]);
    await drainStorageDeletions(h.ctx, [v.key]);
    await expect(h.ctx.storage.get(v.key)).resolves.toBeTruthy();
    expect((await h.ctx.db.query('SELECT 1 FROM storage_deletions WHERE storage_key = $1', [v.key])).rowCount).toBe(0);
  });

  it('6. a 404 is logged with the path only, never the query string', async () => {
    const { lines, logger } = capture();
    const app = await buildApp(h.ctx, { logger });
    let res;
    try {
      res = await app.inject({ method: 'GET', url: '/v1/no-such-route?token=leaked-reset-token' });
    } finally {
      await app.close();
    }
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    expect(JSON.stringify(lines)).not.toContain('leaked-reset-token');
    expect(lines.find((l) => l.msg === 'route not found')).toMatchObject({ method: 'GET', path: '/v1/no-such-route' });
  });
});
