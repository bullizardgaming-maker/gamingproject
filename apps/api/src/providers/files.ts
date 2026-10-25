import { connect } from 'node:net';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pipeline as pipelineCb } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Keyring } from '../lib/crypto.js';

// ---------------------------------------------------------------------------
// Storage for uploaded evidence
// ---------------------------------------------------------------------------
export interface FileStorage {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Round 23b, large files (videos): store a file from disk, streamed (never held in memory whole). */
  putFile(key: string, filePath: string, contentType: string, size: number): Promise<void>;
  /** Round 23b: read a stored file as a stream (decrypted if the store encrypts). */
  getStream(key: string): Promise<Readable>;
  /** Idempotent: deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
  /**
   * Re-encrypt a stored file with the current data key, if this store encrypts with the
   * application keyring. Returns the key version the file ends up under, or null when the
   * store encrypts by itself (S3 server-side encryption) and there is nothing to do.
   */
  rekey(key: string): Promise<string | null>;
  /** Key version new files are written with (null if the store encrypts by itself). */
  readonly keyVersion: string | null;
  /**
   * Object stores only (Round 23a): a short-lived URL the browser PUTs a large file to directly, so it never passes
   * through Cloudflare and the API (100 MB request limit). The API then reads it back, scans it and accepts it.
   */
  presignPut?(key: string, contentType: string, bytes: number, expiresSeconds: number): Promise<{ url: string; headers: Record<string, string> }>;
}

/** Local disk, encrypted with the data keyring (development / single-server). */
export class LocalEncryptedStorage implements FileStorage {
  constructor(
    private readonly dir: string,
    private readonly keyring: Keyring,
  ) {}
  private file(key: string) {
    if (!/^[a-z0-9/_-]+$/i.test(key)) throw new Error('invalid storage key');
    return path.join(this.dir, key);
  }
  async put(key: string, bytes: Buffer) {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, this.keyring.encryptBytes(bytes, `file:${key}`), { mode: 0o600 });
  }
  async get(key: string) {
    return this.keyring.decryptBytes(await readFile(this.file(key)), `file:${key}`);
  }
  async putFile(key: string, src: string) {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    const { header, tagOffset, cipher } = this.keyring.encryptStream(`file:${key}`);
    const part = `${f}.part`;
    await writeFile(part, header, { mode: 0o600 });
    await pipeline(createReadStream(src), cipher, createWriteStream(part, { flags: 'r+', start: header.length }));
    const fh = await open(part, 'r+');
    try {
      await fh.write(cipher.getAuthTag(), 0, 16, tagOffset);
    } finally {
      await fh.close();
    }
    await rename(part, f);
  }
  async getStream(key: string): Promise<Readable> {
    const f = this.file(key);
    const fh = await open(f, 'r');
    let header: Buffer;
    try {
      const first = Buffer.alloc(1);
      await fh.read(first, 0, 1, 0);
      header = Buffer.alloc(Keyring.bytesHeaderLength(first[0]!));
      await fh.read(header, 0, header.length, 0);
    } finally {
      await fh.close();
    }
    // The tag is checked at the end: a tampered file errors the stream after its last chunk.
    return pipelineCb(createReadStream(f, { start: header.length }), this.keyring.decryptStream(header, `file:${key}`), () => {});
  }
  async delete(key: string) {
    await rm(this.file(key), { force: true });
  }
  get keyVersion() {
    return this.keyring.currentVersion;
  }
  async rekey(key: string) {
    const f = this.file(key);
    const blob = await readFile(f);
    if (Keyring.versionOfBytes(blob) === this.keyring.currentVersion) return this.keyring.currentVersion;
    const fresh = this.keyring.encryptBytes(this.keyring.decryptBytes(blob, `file:${key}`), `file:${key}`);
    // Write beside and rename, so a crash never leaves a half-written file.
    await writeFile(`${f}.rekey`, fresh, { mode: 0o600 });
    await rename(`${f}.rekey`, f);
    return this.keyring.currentVersion;
  }
}

/** S3 or any S3-compatible store (R2, MinIO). Server-side encryption on; the bucket must be private. */
export class S3Storage implements FileStorage {
  private s3: S3Client;
  constructor(
    private readonly bucket: string,
    region: string,
    endpoint?: string,
  ) {
    this.s3 = new S3Client({ region, ...(endpoint ? { endpoint, forcePathStyle: true } : {}) });
  }
  async put(key: string, bytes: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType, ServerSideEncryption: 'AES256' }));
  }
  async get(key: string) {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
  async putFile(key: string, src: string, contentType: string, size: number) {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: createReadStream(src), ContentLength: size, ContentType: contentType, ServerSideEncryption: 'AES256' }),
    );
  }
  async getStream(key: string): Promise<Readable> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body as Readable; // Node: an IncomingMessage
  }
  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async presignPut(key: string, contentType: string, bytes: number, expiresSeconds: number) {
    // Content type and length are signed: the upload must be exactly what was announced.
    const url = await getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: bytes }), {
      expiresIn: expiresSeconds,
    });
    return { url, headers: { 'Content-Type': contentType } };
  }
  readonly keyVersion = null;
  async rekey() {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Malware scanning
// ---------------------------------------------------------------------------
export interface MalwareScanner {
  readonly name: string;
  scan(bytes: Buffer): Promise<{ clean: boolean; signature?: string }>;
  /** Round 23b: scan a stream of `size` bytes without holding it in memory. */
  scanStream(stream: Readable, size: number): Promise<{ clean: boolean; signature?: string }>;
}

/** clamd scan timeout: 15 s plus 1 s per 5 MB, at most 120 s (a 95 MB video gets 34 s). */
export function clamdTimeoutMs(size: number) {
  return Math.min(120_000, 15_000 + Math.ceil(size / (5 * 1024 * 1024)) * 1_000);
}

/**
 * ClamAV daemon over TCP using the INSTREAM command:
 *   "zINSTREAM\0", then chunks of [uint32 BE length][bytes], then a zero-length chunk.
 * Reply: "stream: OK\0" or "stream: <Signature> FOUND\0".
 */
export class ClamdScanner implements MalwareScanner {
  readonly name = 'clamd';
  constructor(
    private readonly host: string,
    private readonly port: number,
    /** Fixed timeout (tests); by default it scales with the size (clamdTimeoutMs). */
    private readonly timeoutMs?: number,
  ) {}

  scan(bytes: Buffer): Promise<{ clean: boolean; signature?: string }> {
    return this.scanStream(Readable.from([bytes]), bytes.length);
  }

  /**
   * Streams to clamd in 64 KB chunks with backpressure. Fails closed: a timeout, a dropped connection or any reply
   * other than OK/FOUND (e.g. "INSTREAM size limit exceeded") rejects, and the caller refuses the upload.
   */
  scanStream(stream: Readable, size: number): Promise<{ clean: boolean; signature?: string }> {
    return new Promise((resolve, reject) => {
      const sock = connect({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];
      let failed: Error | null = null;
      const fail = (e: Error) => {
        failed ??= e;
        stream.destroy();
        sock.destroy();
      };
      const timer = setTimeout(() => fail(new Error('clamd timeout')), this.timeoutMs ?? clamdTimeoutMs(size));
      const write = (b: Buffer) => (sock.write(b) ? Promise.resolve() : new Promise<void>((r) => sock.once('drain', () => r())));
      sock.on('connect', async () => {
        try {
          await write(Buffer.from('zINSTREAM\0'));
          for await (const chunk of stream) {
            const buf = chunk as Buffer;
            for (let i = 0; i < buf.length; i += 64 * 1024) {
              const part = buf.subarray(i, i + 64 * 1024);
              const len = Buffer.alloc(4);
              len.writeUInt32BE(part.length);
              await write(len);
              await write(part);
            }
          }
          await write(Buffer.alloc(4)); // end of stream
        } catch (e) {
          fail(e as Error);
        }
      });
      sock.on('data', (d: Buffer) => chunks.push(Buffer.from(d)));
      sock.on('error', (e) => fail(e));
      sock.on('close', () => {
        clearTimeout(timer);
        if (failed) return reject(failed);
        const reply = Buffer.concat(chunks).toString().replace(/\0/g, '').trim();
        if (/: OK$/.test(reply)) return resolve({ clean: true });
        const found = /: (.+) FOUND$/.exec(reply);
        if (found) return resolve({ clean: false, signature: found[1] });
        reject(new Error(`unexpected clamd reply: ${reply.slice(0, 100)}`));
      });
    });
  }
}

/** Development scanner: flags the standard EICAR anti-virus test string anywhere in the file. */
export class EicarOnlyScanner implements MalwareScanner {
  readonly name = 'eicar-dev';
  static readonly EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
  async scan(bytes: Buffer) {
    return bytes.includes(EicarOnlyScanner.EICAR) ? { clean: false, signature: 'Eicar-Test-Signature' } : { clean: true };
  }
  /** Chunk by chunk, keeping the last few bytes so a match across a chunk boundary is found. */
  async scanStream(stream: Readable) {
    const keep = EicarOnlyScanner.EICAR.length - 1;
    let tail = Buffer.alloc(0);
    for await (const chunk of stream) {
      const window = Buffer.concat([tail, chunk as Buffer]);
      if (window.includes(EicarOnlyScanner.EICAR)) {
        stream.destroy();
        return { clean: false, signature: 'Eicar-Test-Signature' };
      }
      tail = window.subarray(Math.max(0, window.length - keep));
    }
    return { clean: true };
  }
}
