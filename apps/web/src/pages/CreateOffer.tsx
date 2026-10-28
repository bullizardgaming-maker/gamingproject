import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Plus, Trash as Trash2 } from '@phosphor-icons/react';
import { api } from '../api';
import { useSession } from '../session';
import { usePageMeta } from '@/lib/seo';
import { t } from '../i18n';
import { attrLabel, attributesFor, useLeagues, type AttributeDef } from '@/lib/attributes';
import { categoryLabel, isCategoryOpen, useCategoryOrder } from '@/lib/catalog';
import { CATEGORY_ICON } from '../components/CatalogUi';
import { GamePicker } from '../components/GamePicker';
import { sellableGames } from '@/lib/launch';
import { KNOWN_GAMES } from '@/lib/gameList';
import { deliveryTimeLabel, methodLabel, methodsForListing } from '@/lib/delivery';
import { unitMoney } from '@/lib/prefs';
import { OtherOfferForm, type SellerOffer } from './Sell';
import type { LinkedAccount } from '../components/LinkedAccounts';
import { DELIVERY_TIME_KEYS, MAX_VOLUME_DISCOUNTS, MAX_VOLUME_PERCENT, checkVolumeDiscounts, grossMicros, parseUnitPrice, type DeliveryTime } from '../../../api/src/domain/unitPrice';

const TYPES = ['currency', 'items', 'top-ups', 'accounts', 'boosting', 'keys', 'gift-cards', 'video-games'] as const;


/**
 * Create offer (Round 25): its own page, two steps. Step 1 picks the product type and the game; step 2
 * is that game's form. Currency has a short form of its own (server, stock, unit price, volume discounts,
 * delivery methods and time); the other types keep the full listing form.
 */
export function CreateOffer() {
  usePageMeta({ title: t('co.title') });
  const { user } = useSession();
  const nav = useNavigate();
  useCategoryOrder(); // closed launch-phase types drop out once the open ones are known
  const [step, setStep] = useState<1 | 2>(1);
  const [type, setType] = useState('');
  const [game, setGame] = useState('');
  const [rateBps, setRateBps] = useState<number | null>(null);
  const [offers, setOffers] = useState<SellerOffer[]>([]);
  const [linked, setLinked] = useState<LinkedAccount[]>([]);

  const load = useCallback(async () => {
    const [d, o, l] = await Promise.all([api<{ rateBps: number }>('/seller/dashboard'), api<SellerOffer[]>('/seller/offers'), api<LinkedAccount[]>('/seller/linked-accounts').catch(() => [])]);
    setRateBps(d.rateBps);
    setOffers(o);
    setLinked(l);
  }, []);
  useEffect(() => {
    if (user) load().catch(() => {});
  }, [user, load]);

  if (!user) return <p className="muted"><Link to="/login?next=/sell/new">{t('sell.signIn')}</Link></p>;
  // Not set up to sell yet: the hub walks through it.
  if (user.kyc_tier < 1 || !user.rules_passed_at) return <Navigate to="/sell" replace />;

  const games = sellableGames(KNOWN_GAMES);
  const gameOk = games.some((g) => g.toLowerCase() === game.trim().toLowerCase());
  const canGo = !!type && gameOk;
  const done = () => nav('/sell', { state: { created: true } });

  return (
    <div className="stack co" style={{ maxWidth: 980 }}>
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/sell">{t('sell.title')}</Link><span>/</span><span>{t('co.title')}</span></nav>
      <h1 className="pg-h1" style={{ margin: 0 }}>{t('co.title')}</h1>
      <ol className="pg-stepper" aria-label={t('co.steps')}>
        {[t('co.step1'), t('co.step2')].map((l, i) => (
          <li key={l} className={i + 1 < step ? 'done' : i + 1 === step ? 'now' : ''} aria-current={i + 1 === step ? 'step' : undefined}>
            <i aria-hidden>{i + 1 < step ? '✓' : i + 1}</i>{l}
          </li>
        ))}
      </ol>

      {step === 1 ? (
        <form className="card stack co-step1" onSubmit={(e) => (e.preventDefault(), canGo && setStep(2))}>
          <fieldset className="co-types">
            <legend className="co-legend">{t('co.type')}</legend>
            <div className="co-type-grid">
              {TYPES.filter(isCategoryOpen).map((c) => {
                const Icon = CATEGORY_ICON[c]!;
                return (
                  <label key={c} className="co-type" data-on={type === c || undefined}>
                    <input type="radio" name="type" value={c} checked={type === c} onChange={() => setType(c)} className="co-radio" />
                    <Icon className="size-6" aria-hidden />
                    <span>{categoryLabel(c)}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <GamePicker label={t('sell.f.game')} name="game" required options={games} value={game} onChange={setGame} className="co-game" />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn lg" type="submit" disabled={!canGo}>{t('co.continue')}</button>
          </div>
        </form>
      ) : (
        <>
          <div className="co-picked card">
            <span className="small muted">{t('co.type')}</span><b>{categoryLabel(type)}</b>
            <span className="small muted">{t('sell.f.game')}</span><b>{game}</b>
            <button type="button" className="btn ghost sm" onClick={() => setStep(1)}>{t('co.change')}</button>
          </div>
          {type === 'currency' ? (
            <CurrencyOfferForm game={games.find((g) => g.toLowerCase() === game.trim().toLowerCase()) ?? game} rateBps={rateBps} onCreated={done} />
          ) : (
            <OtherOfferForm category={type} game={game} offers={offers} linked={linked} onCreated={done} />
          )}
        </>
      )}
    </div>
  );
}

interface Tier { minQty: string; percentOff: string }

/**
 * Currency listing form: only server/region (and any other field the game requires), stock, unit price with up
 * to 6 decimals, volume discounts (up to 4), delivery methods from the game's list and a delivery time.
 */
function CurrencyOfferForm({ game, rateBps, onCreated }: { game: string; rateBps: number | null; onCreated: () => void }) {
  useLeagues(game); // league options come from the table
  const fields = attributesFor(game, 'currency').filter((d, i) => i === 0 || d.required);
  const methods = methodsForListing(game, 'currency');
  const [attrs, setAttrs] = useState<Record<string, string>>({});
  const [stock, setStock] = useState('');
  const [price, setPrice] = useState('');
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [picked, setPicked] = useState<string[]>(methods);
  const [time, setTime] = useState<DeliveryTime | ''>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const micros = parseUnitPrice(price);
  const priceOk = micros != null && micros >= 1;
  const tierList = tiers.map((x) => ({ minQty: Math.floor(Number(x.minQty)), percentOff: Math.floor(Number(x.percentOff)) }));
  const tierCheck = checkVolumeDiscounts(tierList.filter((x) => x.minQty || x.percentOff), 1);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!priceOk) return setError(t('co.priceInvalid'));
    if (!tierCheck.ok) return setError(tierCheck.error);
    if (methods.length && !picked.length) return setError(t('co.pickMethod'));
    setBusy(true);
    try {
      await api('/offers', {
        body: {
          categorySlug: 'currency',
          game,
          title: [game, ...fields.map((d) => attrs[d.key]).filter(Boolean)].join(' · ').slice(0, 140),
          deliveryMode: 'manual',
          attributes: Object.fromEntries(Object.entries(attrs).filter(([, v]) => v.trim())),
          stock: Math.floor(Number(stock)),
          unitPrice: price.trim(),
          volumeDiscounts: tierCheck.value,
          deliveryMethods: methods.length ? picked : undefined,
          deliveryTime: time,
        },
      });
      onCreated();
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="pg-split co-form" onSubmit={submit} aria-label={t('co.currencyForm')}>
      <div className="card stack">
        <div className="grid two">
          {fields.map((d) => <AttrInput key={`${game}-${d.key}`} def={d} value={attrs[d.key] ?? ''} onChange={(v) => setAttrs((a) => ({ ...a, [d.key]: v }))} />)}
          <label className="field">
            {t('co.stock')}
            <input name="stock" className="num" type="number" inputMode="numeric" min={1} max={2_000_000_000} step={1} required value={stock} onChange={(e) => setStock(e.target.value)} />
          </label>
          <label className="field">
            {t('co.unitPrice')}
            <input
              name="unitPrice"
              className="num"
              inputMode="decimal"
              required
              autoComplete="off"
              value={price}
              pattern="\d{1,9}(\.\d{1,6})?"
              aria-invalid={price !== '' && !priceOk ? true : undefined}
              onChange={(e) => setPrice(e.target.value.replace(',', '.'))}
              onBlur={() => priceOk && setPrice((micros! / 1_000_000).toFixed(6))}
            />
          </label>
          <label className="field">
            {t('co.deliveryTime')}
            <select name="deliveryTime" required value={time} onChange={(e) => setTime(e.target.value as DeliveryTime)}>
              <option value="">{t('sell.f.choose')}</option>
              {DELIVERY_TIME_KEYS.map((k) => <option key={k} value={k}>{deliveryTimeLabel(k)}</option>)}
            </select>
          </label>
        </div>

        {methods.length > 0 && (
          <fieldset className="co-methods">
            <legend className="co-legend">{t('of.deliveryMethods')}</legend>
            {methods.map((m) => (
              <label key={m} className="check-row" style={{ color: 'var(--ink)' }}>
                <input type="checkbox" name="deliveryMethods" value={m} checked={picked.includes(m)} onChange={(e) => setPicked((p) => (e.target.checked ? methods.filter((x) => x === m || p.includes(x)) : p.filter((x) => x !== m)))} style={{ width: 'auto' }} /> {methodLabel(m)}
              </label>
            ))}
          </fieldset>
        )}

        <fieldset className="co-tiers">
          <legend className="co-legend">{t('co.volume')}</legend>
          {tiers.length > 0 && (
            <div className="co-tier-head small muted" aria-hidden><span>{t('co.tierQty')}</span><span>{t('co.tierPct')}</span><span /></div>
          )}
          {tiers.map((x, i) => (
            <div key={i} className="co-tier">
              <input className="num" type="number" inputMode="numeric" min={2} max={2_000_000_000} step={1} required aria-label={t('co.tierQtyN', { n: i + 1 })} value={x.minQty} onChange={(e) => setTiers((ts) => ts.map((y, j) => (j === i ? { ...y, minQty: e.target.value } : y)))} />
              <span className="co-pct">
                <input className="num" type="number" inputMode="numeric" min={1} max={MAX_VOLUME_PERCENT} step={1} required aria-label={t('co.tierPctN', { n: i + 1 })} value={x.percentOff} onChange={(e) => setTiers((ts) => ts.map((y, j) => (j === i ? { ...y, percentOff: e.target.value } : y)))} />
                <span aria-hidden>%</span>
              </span>
              <button type="button" className="btn ghost sm" aria-label={t('co.tierRemove', { n: i + 1 })} onClick={() => setTiers((ts) => ts.filter((_, j) => j !== i))}><Trash2 className="size-4" aria-hidden /></button>
            </div>
          ))}
          {tiers.length < MAX_VOLUME_DISCOUNTS && (
            <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setTiers((ts) => [...ts, { minQty: '', percentOff: '' }])}>
              <Plus className="size-4" aria-hidden /> {t('co.tierAdd')}
            </button>
          )}
        </fieldset>
      </div>

      <aside className="card pg-sticky stack co-side">
        <div className="pg-rows">
          <div className="pg-total"><span>{t('co.youGet')}</span><span className="pg-price num">{priceOk ? unitMoney(micros!) : '—'}</span></div>
          <div className="pg-total"><span>{t('co.buyersPay')}</span><span className="pg-price num">{priceOk && rateBps != null ? unitMoney(grossMicros(micros!, rateBps)) : '—'}</span></div>
        </div>
        {error && <div className="alert" role="alert">{error}</div>}
        <button className="btn lg block" type="submit" disabled={busy}>{t('sell.f.create')}</button>
      </aside>
    </form>
  );
}

function AttrInput({ def: d, value, onChange }: { def: AttributeDef; value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      {attrLabel(d.label)}
      {d.type === 'select' ? (
        <select name={`attr.${d.key}`} required value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t('sell.f.choose')}</option>
          {d.options!.map((o) => <option key={o}>{o}</option>)}
        </select>
      ) : (
        <input name={`attr.${d.key}`} required maxLength={60} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}
