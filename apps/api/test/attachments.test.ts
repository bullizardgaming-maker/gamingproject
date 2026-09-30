import { createServer, type Server } from 'node:net';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectEvidence } from '../src/domain/chargebacks.js';
import { ClamdScanner, EicarOnlyScanner } from '../src/providers/files.js';
import { sha256 } from '../src/lib/crypto.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let h: Harness;
beforeAll(async () => {
  h = await setup({ STORAGE_DIR: mkdtempSync(path.join(tmpdir(), 'bz-uploads-')) });
});
afterAll(async () => h.close());

async function orderRoom() {
  const seller = await makeUser(h, { tier: 2 });
  const buyer = await makeUser(h, { tier: 1 });
  const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 3 });
  const order = await buyAndPay(h, buyer, offer.id);
  const roomId = (await buyer.api.get(`/v1/orders/${order.id}`)).body.room_id as string;
  return { seller, buyer, order, roomId };
}

/** A real JPEG with EXIF metadata (including GPS) embedded. */
async function jpegWithGps() {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: '#3366cc' } })
    .jpeg()
    .withExif({ IFD0: { Make: 'SnoopCam', ImageDescription: 'home' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' } })
    .toBuffer();
}

const upload = (api: any, roomId: string, bytes: Buffer, type = 'image/jpeg', name = 'proof.jpg') =>
  api.post(`/v1/chat/rooms/${roomId}/attachments`, bytes, { 'content-type': type, 'x-filename': name });

describe('image evidence in chat', () => {
  it('scans, strips metadata, stores encrypted, and chains the hash into the chat log', async () => {
    const { buyer, seller, roomId } = await orderRoom();
    const original = await jpegWithGps();
    expect((await sharp(original).metadata()).exif).toBeTruthy();

    const res = await upload(buyer.api, roomId, original);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ mime: 'image/jpeg', width: 64, height: 48 });

    // Seller (other participant) can view it; it no longer carries EXIF/GPS.
    const got = await seller.api.get(`/v1/chat/attachments/${res.body.id}`);
    expect(got.headers['content-type']).toBe('image/jpeg');
    expect(got.headers['content-security-policy']).toContain('sandbox');
    const raw = await h.app.inject({ method: 'GET', url: `/v1/chat/attachments/${res.body.id}`, headers: { authorization: `Bearer ${seller.token}` } });
    expect(sha256(raw.rawPayload)).toBe(res.body.sha256);
    expect((await sharp(raw.rawPayload).metadata()).exif).toBeUndefined();

    // The chat message carries the hash and the chain still verifies.
    const msgs = (await buyer.api.get(`/v1/chat/rooms/${roomId}/messages`)).body;
    const m = msgs.find((x: any) => x.kind === 'attachment');
    expect(m.body).toContain(res.body.sha256);
    expect((await buyer.api.get(`/v1/chat/rooms/${roomId}/verify`)).body.valid).toBe(true);

    // Outsiders can't see it; staff views are audited.
    const stranger = await makeUser(h, { tier: 1 });
    expect((await stranger.api.get(`/v1/chat/attachments/${res.body.id}`)).status).toBe(403);
    const admin = await makeUser(h, { tier: 2, role: 'admin' });
    expect((await admin.api.get(`/v1/chat/attachments/${res.body.id}`)).status).toBe(200);
    expect((await admin.api.get('/v1/admin/audit?targetType=chat_attachment')).body[0].action).toBe('attachment.viewed');
  });

  it('rejects non-images, spoofed types and oversize files', async () => {
    const { buyer, roomId } = await orderRoom();
    expect((await upload(buyer.api, roomId, Buffer.from('<svg onload=alert(1)>'), 'image/png', 'x.png')).body.error.code).toBe('unsupported_file');
    expect((await upload(buyer.api, roomId, Buffer.from('%PDF-1.7 fake'), 'image/jpeg')).body.error.code).toBe('unsupported_file');
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(8 * 1024 * 1024)]);
    expect((await upload(buyer.api, roomId, big)).status).toBe(413);
    // Valid header but garbage body.
    expect((await upload(buyer.api, roomId, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).body.error.code).toBe('invalid_image');
  });

  it('blocks malware, flags the uploader, and fails closed when the scanner is down', async () => {
    const { buyer, roomId } = await orderRoom();
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).png().toBuffer();
    const infected = Buffer.concat([png, Buffer.from(EicarOnlyScanner.EICAR)]);
    const res = await upload(buyer.api, roomId, infected, 'image/png', 'evil.png');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('malware_detected');
    const flag = await h.ctx.db.query(`SELECT reasons FROM risk_flags WHERE user_id = $1`, [buyer.id]);
    expect(flag.rows[0].reasons[0].code).toBe('malware_upload');

    const original = h.ctx.scanner;
    (h.ctx as any).scanner = { name: 'down', scan: async () => { throw new Error('ECONNREFUSED'); } };
    expect((await upload(buyer.api, roomId, png, 'image/png')).status).toBe(503);
    (h.ctx as any).scanner = original;
  });

  it('lists evidence images with hashes in the chargeback packet', async () => {
    const { buyer, order, roomId } = await orderRoom();
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#0f0' } }).png().toBuffer();
    const up = await upload(buyer.api, roomId, png, 'image/png', 'receipt.png');
    const admin = await makeUser(h, { tier: 2, role: 'admin' });
    const cb = await admin.api.post('/v1/admin/chargebacks', { orderId: order.id, network: 'visa', reasonCode: '13.3', amountCents: 10_00 });
    const ev = await collectEvidence(h.ctx.db, cb.body.id);
    expect(ev.chat.attachments).toEqual([expect.objectContaining({ original_name: 'receipt.png', sha256: up.body.sha256, uploaded_by: 'buyer' })]);
  });
});

describe('ClamAV client', () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    // Minimal clamd: reads the INSTREAM framing and answers like the real daemon.
    server = createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (!buf.subarray(0, 10).equals(Buffer.from('zINSTREAM\0'))) return;
        let o = 10;
        const parts: Buffer[] = [];
        while (buf.length >= o + 4) {
          const len = buf.readUInt32BE(o);
          if (len === 0) {
            const data = Buffer.concat(parts);
            sock.end(data.includes('EICAR') ? 'stream: Eicar-Signature FOUND\0' : 'stream: OK\0');
            return;
          }
          if (buf.length < o + 4 + len) return;
          parts.push(buf.subarray(o + 4, o + 4 + len));
          o += 4 + len;
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as any).port;
  });
  afterAll(() => server.close());

  it('streams files in chunks and parses clean/infected replies', async () => {
    const scanner = new ClamdScanner('127.0.0.1', port);
    expect(await scanner.scan(Buffer.alloc(200_000, 1))).toEqual({ clean: true });
    expect(await scanner.scan(Buffer.concat([Buffer.alloc(100_000), Buffer.from('EICAR')]))).toEqual({ clean: false, signature: 'Eicar-Signature' });
    await expect(new ClamdScanner('127.0.0.1', 1).scan(Buffer.from('x'))).rejects.toThrow();
  });
});
