import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne } from '../db.js';
import { cleanAttributes } from './attributeSets.js';
import { parseCsv } from './csv.js';
import { toCsv } from './exports.js';
import { screenListing } from './moderation.js';
import { createOffer, updateOffer } from './offers.js';
import { WARRANTY_DAYS } from './warranty.js';

/**
 * Bulk listing tools: export every listing as CSV, edit it in a spreadsheet, import it back.
 * Rows with an id update that listing; rows without one create a listing. Import is always
 * previewed first (dryRun) with a per-row result, and applying reports each row the same way,
 * so one bad row never blocks the rest.
 */
export const COLUMNS = ['id', 'game', 'category', 'title', 'description', 'price', 'currency', 'delivery', 'stock', 'delivery_hours', 'status', 'attributes', 'warranty_days'] as const;
export const MAX_IMPORT_ROWS = 500;

const attrsToText = (a: Record<string, string> | null) => Object.entries(a ?? {}).map(([k, v]) => `${k}=${v}`).join('; ');
function textToAttrs(s: string) {
  const out: Record<string, string> = {};
  for (const part of s.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export async function exportListings(q: Queryable, sellerId: string) {
  const rows = await many<any>(
    q,
    `SELECT id, game, category_slug AS category, title, description, price_cents, currency, delivery_mode, stock, delivery_hours, status, attributes, warranty_days
       FROM offers WHERE seller_id = $1 AND status <> 'removed' AND reserved_for IS NULL ORDER BY created_at`,
    [sellerId],
  );
  return toCsv([...COLUMNS], rows.map((r) => ({
    ...r,
    price: (Number(r.price_cents) / 100).toFixed(2),
    delivery: r.delivery_mode === 'auto' ? 'instant' : 'manual',
    stock: r.delivery_mode === 'manual' ? r.stock : '',
    attributes: attrsToText(r.attributes),
  })));
}

export interface RowResult {
  row: number; // 1-based, header excluded (the spreadsheet row is row + 1)
  id: string | null;
  title: string;
  action: 'create' | 'update' | 'unchanged' | 'error';
  changes?: string[];
  review?: boolean;
  error?: string;
}

/** Spreadsheets get a leading ' added by our export to neutralise formulas; take it off again. */
const cell = (s: string | undefined) => {
  const v = (s ?? '').trim();
  return /^'[=+\-@]/.test(v) ? v.slice(1) : v;
};

interface Planned {
  result: RowResult;
  create?: Parameters<typeof createOffer>[2];
  update?: { id: string; version: number; patch: Parameters<typeof updateOffer>[4] };
}

async function plan(ctx: Ctx, sellerId: string, header: string[], fields: string[], row: number): Promise<Planned> {
  const get = (name: string) => {
    const i = header.indexOf(name);
    return i >= 0 ? cell(fields[i]) : '';
  };
  const has = (name: string) => header.includes(name) && get(name) !== '';
  const id = get('id') || null;
  const title = get('title');
  const result: RowResult = { row, id, title, action: 'error' };
  const fail = (error: string): Planned => ({ result: { ...result, error } });

  const price = has('price') ? Number(get('price').replace(',', '.')) : null;
  if (price != null && !(price > 0 && price <= 100_000)) return fail('Price must be between 0.01 and 100000');
  const priceCents = price != null ? Math.round(price * 100) : undefined;
  const status = has('status') ? get('status').toLowerCase() : undefined;
  if (status && !['active', 'paused'].includes(status)) return fail('Status must be active or paused');
  const stock = has('stock') ? Number(get('stock')) : undefined;
  if (stock != null && !(Number.isInteger(stock) && stock >= 0 && stock <= 1_000_000)) return fail('Stock must be a whole number');
  const hours = has('delivery_hours') ? Number(get('delivery_hours')) : undefined;
  if (hours != null && !(Number.isInteger(hours) && hours >= 1 && hours <= 168)) return fail('Delivery hours must be 1 to 168');
  const warranty = has('warranty_days') ? Number(get('warranty_days')) : undefined;
  if (warranty != null && !(WARRANTY_DAYS as readonly number[]).includes(warranty)) return fail('Warranty days must be 0, 7, 14, 30, 60 or 90');
  if (title && (title.length < 3 || title.length > 140)) return fail('Title must be 3 to 140 characters');
  const description = header.includes('description') ? get('description') : undefined;
  if (description && description.length > 5_000) return fail('Description is too long');

  if (id) {
    const cur = await maybeOne<any>(
      ctx.db,
      `SELECT f.*, c.kind FROM offers f JOIN categories c ON c.slug = f.category_slug WHERE f.id::text = $1 AND f.seller_id = $2 AND f.status <> 'removed'`,
      [id, sellerId],
    );
    if (!cur) return fail('No listing of yours with this id');
    if (cur.reserved_for) return fail('Agreed on a buyer request: its terms can’t change');
    for (const [col, now] of [['game', cur.game], ['category', cur.category_slug], ['currency', cur.currency]] as const) {
      if (has(col) && get(col).toLowerCase() !== String(now).toLowerCase()) return fail(`The ${col} of an existing listing can’t change; add a new row without an id instead`);
    }
    if (has('delivery') && (get('delivery').toLowerCase() === 'instant' ? 'auto' : 'manual') !== cur.delivery_mode) return fail('The delivery type of an existing listing can’t change');
    if (warranty && cur.kind !== 'account') return fail('Only account listings can carry a warranty');
    const patch: Record<string, unknown> = {};
    const changes: string[] = [];
    const diff = (key: string, label: string, next: unknown, now: unknown) => {
      if (next !== undefined && next !== now) {
        patch[key] = next;
        changes.push(label);
      }
    };
    diff('title', 'title', title || undefined, cur.title);
    diff('description', 'description', description, cur.description);
    diff('priceCents', 'price', priceCents, Number(cur.price_cents));
    if (cur.delivery_mode === 'manual') diff('stock', 'stock', stock, cur.stock);
    diff('deliveryHours', 'delivery time', hours, cur.delivery_hours);
    diff('status', 'status', status, cur.status === 'review' ? status : cur.status);
    diff('warrantyDays', 'warranty', warranty, cur.warranty_days);
    if (header.includes('attributes')) {
      const attrs = cleanAttributes(cur.game, cur.category_slug, textToAttrs(get('attributes')));
      if (!attrs.ok) return fail(attrs.error);
      if (JSON.stringify(attrs.value) !== JSON.stringify(cur.attributes ?? {})) {
        patch.attributes = attrs.value;
        changes.push('details');
      }
    }
    if (!changes.length) return { result: { ...result, title: cur.title, action: 'unchanged' } };
    let review = false;
    if (patch.title || patch.description != null) {
      const v = await screenListing(ctx.db, (patch.title as string) ?? cur.title, (patch.description as string) ?? cur.description);
      if (v.action === 'block') return fail('Breaks the rules on prohibited goods');
      review = v.action === 'review';
    }
    return { result: { ...result, title: cur.title, action: 'update', changes, review }, update: { id: cur.id, version: cur.version, patch: patch as any } };
  }

  // New listing.
  for (const col of ['game', 'category', 'title', 'price', 'delivery']) if (!has(col)) return fail(`${col} is required for a new listing`);
  const game = get('game');
  if (game.length > 80) return fail('Game name is too long');
  const category = get('category').toLowerCase();
  const cat = await maybeOne<{ kind: string }>(ctx.db, 'SELECT kind FROM categories WHERE slug = $1', [category]);
  if (!cat) return fail(`Unknown category "${category}"`);
  const delivery = get('delivery').toLowerCase();
  if (!['instant', 'manual'].includes(delivery)) return fail('Delivery must be instant or manual');
  if (warranty && cat.kind !== 'account') return fail('Only account listings can carry a warranty');
  const currency = has('currency') ? get('currency').toUpperCase() : undefined;
  if (currency && !ctx.cfg.SUPPORTED_CURRENCIES.split(',').includes(currency)) return fail(`Currency must be one of ${ctx.cfg.SUPPORTED_CURRENCIES}`);
  const attrs = cleanAttributes(game, category, textToAttrs(get('attributes')));
  if (!attrs.ok) return fail(attrs.error);
  const v = await screenListing(ctx.db, title, description ?? '');
  if (v.action === 'block') return fail('Breaks the rules on prohibited goods');
  return {
    result: { ...result, action: 'create', review: v.action === 'review' },
    create: {
      game, categorySlug: category, title, description, priceCents: priceCents!, currency,
      deliveryMode: delivery === 'instant' ? 'auto' : 'manual', stock, deliveryHours: hours, attributes: attrs.value, warrantyDays: warranty || undefined,
    },
  };
}

export async function importListings(ctx: Ctx, seller: { id: string; kyc_tier: number; status: string }, csv: string, opts: { dryRun: boolean }) {
  const [rawHeader, ...rows] = parseCsv(csv.replace(/^﻿/, ''));
  if (!rawHeader) return { rows: [], summary: { create: 0, update: 0, unchanged: 0, error: 0 } };
  const header = rawHeader.map((h) => h.trim().toLowerCase());
  if (rows.length > MAX_IMPORT_ROWS) {
    return { rows: [], summary: { create: 0, update: 0, unchanged: 0, error: rows.length }, error: `Import up to ${MAX_IMPORT_ROWS} rows at a time` };
  }
  const plans: Planned[] = [];
  const seen = new Set<string>();
  for (const [i, fields] of rows.entries()) {
    const p = await plan(ctx, seller.id, header, fields, i + 1);
    if (p.result.id && seen.has(p.result.id)) p.result = { ...p.result, action: 'error', error: 'This id appears twice in the file' };
    if (p.result.id) seen.add(p.result.id);
    plans.push(p);
  }
  if (!opts.dryRun) {
    for (const p of plans) {
      if (p.result.action === 'error') continue;
      try {
        if (p.create) {
          const o = await createOffer(ctx, seller, p.create);
          p.result.id = o.id;
        } else if (p.update) {
          await updateOffer(ctx, seller.id, p.update.id, p.update.version, p.update.patch);
        }
      } catch (err) {
        p.result = { ...p.result, action: 'error', error: (err as Error).message };
      }
    }
  }
  const results = plans.map((p) => p.result);
  const count = (a: RowResult['action']) => results.filter((r) => r.action === a).length;
  return { rows: results, summary: { create: count('create'), update: count('update'), unchanged: count('unchanged'), error: count('error') } };
}
