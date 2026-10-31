import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { Plus, Question, Trash as Trash2 } from '@phosphor-icons/react';
import { api } from '../api';
import { useSession } from '../session';
import { usePageMeta } from '@/lib/seo';
import { t, type MessageKey } from '../i18n';
import { attrLabel, attributesFor, useLeagues, type AttributeDef } from '@/lib/attributes';
import { categoryLabel, isCategoryOpen, useCategoryOrder } from '@/lib/catalog';
import { CATEGORY_ICON } from '../components/CatalogUi';
import { GamePicker } from '../components/GamePicker';
import { sellableGames } from '@/lib/launch';
import { KNOWN_GAMES } from '@/lib/gameList';
import { methodLabel, methodsForListing } from '@/lib/delivery';
import { unitMoney } from '@/lib/prefs';
import { OtherOfferForm, type SellerOffer } from './Sell';
import { ListingPreview, type PreviewResponse } from '../components/ListingPreview';
import { MinPerOrder, limitsError } from '../components/OrderLimits';
import { PriceGuide } from '../components/PriceGuide';
import { MAX_DELIVERY_MINUTES, MAX_VOLUME_DISCOUNTS, MAX_VOLUME_PERCENT, checkTiers, deliveryMinutesFrom, normTiers, microsText, parsePrice, splitMinutes, tidyPrice, type TierType, type VolumeTier } from '@/lib/volume';
import type { LinkedAccount } from '../components/LinkedAccounts';
import { grossMicros } from '../../../api/src/domain/unitPrice';

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
          {type !== 'currency' && (
            <div className="co-picked card">
              <span className="small muted">{t('co.type')}</span><b>{categoryLabel(type)}</b>
              <span className="small muted">{t('sell.f.game')}</span><b>{game}</b>
              <button type="button" className="btn ghost sm" onClick={() => setStep(1)}>{t('co.change')}</button>
            </div>
          )}
          {type === 'currency' ? (
            <CurrencyOfferForm game={games.find((g) => g.toLowerCase() === game.trim().toLowerCase()) ?? game} rateBps={rateBps} onCreated={done} onChangeType={() => setStep(1)} />
          ) : (
            <OtherOfferForm category={type} game={game} offers={offers} linked={linked} onCreated={done} />
          )}
        </>
      )}
    </div>
  );
}

/** Round 26 (B2): edit a listing with the same form it was made with; changes are previewed, then saved. */
export function EditOffer() {
  usePageMeta({ title: t('lst.editTitle') });
  const { id = '' } = useParams();
  const { user } = useSession();
  const nav = useNavigate();
  const [rateBps, setRateBps] = useState<number | null>(null);
  const [offers, setOffers] = useState<SellerOffer[] | null>(null);
  const [linked, setLinked] = useState<LinkedAccount[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!user) return;
    Promise.all([api<{ rateBps: number }>('/seller/dashboard'), api<SellerOffer[]>('/seller/offers'), api<LinkedAccount[]>('/seller/linked-accounts').catch(() => [])])
      .then(([d, o, l]) => (setRateBps(d.rateBps), setOffers(o), setLinked(l)))
      .catch((e) => setError(e.message));
  }, [user]);
  if (!user) return <p className="muted"><Link to={`/login?next=/sell/edit/${id}`}>{t('sell.signIn')}</Link></p>;
  const offer = offers?.find((o) => o.id === id);
  const done = () => nav('/sell', { state: { saved: true } });
  return (
    <div className="stack co" style={{ maxWidth: 980 }}>
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/sell">{t('sell.title')}</Link><span>/</span><span>{t('lst.editTitle')}</span></nav>
      <h1 className="pg-h1" style={{ margin: 0 }}>{t('lst.editTitle')}</h1>
      {error ? <div className="alert" role="alert">{error}</div> : offers === null ? <p className="muted">{t('sp.loading')}</p> : !offer ? <div className="card muted">{t('lst.notFound')}</div> : (
        <>
          {offer.category_slug !== 'currency' && (
            <div className="co-picked card">
              <span className="small muted">{t('co.type')}</span><b>{categoryLabel(offer.category_slug)}</b>
              <span className="small muted">{t('sell.f.game')}</span><b>{offer.game}</b>
            </div>
          )}
          {offer.category_slug === 'currency' ? (
            <CurrencyOfferForm game={offer.game} rateBps={rateBps} onCreated={done} initial={offer} />
          ) : (
            <OtherOfferForm category={offer.category_slug} game={offer.game} offers={offers} linked={linked} onCreated={done} initial={offer} />
          )}
        </>
      )}
    </div>
  );
}

interface TierRow { minQty: string; type: TierType; value: string }

/**
 * Currency listing form (Round 26b): three sections. 1) Details: type and game (read-only), server (searchable list),
 * stock, minimum per order and the description with delivery notes. 2) Delivery details: methods from the game's
 * preset list (at least one) and the delivery speed typed in minutes or hours (1 min – 72 h). 3) An optional
 * volume discount (up to 4 tiers, % off or a fixed unit price). The side panel shows the unit price the seller gets
 * and what buyers pay, at full precision. No max per order: the max is the stock. With `initial` it edits a listing.
 */
export function CurrencyOfferForm({ game, rateBps, onCreated, initial, onChangeType }: { game: string; rateBps: number | null; onCreated: () => void; initial?: SellerOffer; onChangeType?: () => void }) {
  useLeagues(game); // league options come from the table
  const { user } = useSession();
  const fields = attributesFor(game, 'currency').filter((d, i) => i === 0 || d.required);
  const methods = methodsForListing(game, 'currency');
  const startTiers = initial?.seller_volume_discounts?.length ? initial.seller_volume_discounts : normTiers(initial?.volume_discounts);
  const speed0 = splitMinutes(initial?.delivery_minutes);
  const [attrs, setAttrs] = useState<Record<string, string>>(initial?.attributes ?? {});
  const [stock, setStock] = useState(initial ? String(initial.available ?? '') : '');
  const [price, setPrice] = useState(initial?.seller_unit_price_micros != null ? microsText(initial.seller_unit_price_micros) : '');
  const [minQty, setMinQty] = useState(String(initial?.min_qty ?? 1));
  const [description, setDescription] = useState(initial?.description ?? '');
  const [picked, setPicked] = useState<string[]>(initial?.delivery_methods?.length ? initial.delivery_methods : methods);
  const [speed, setSpeed] = useState(speed0.value);
  const [unit, setUnit] = useState<'minutes' | 'hours'>(speed0.unit);
  const [volumeOn, setVolumeOn] = useState(startTiers.length > 0);
  const [tiers, setTiers] = useState<TierRow[]>(startTiers.map((x) => ({ minQty: String(x.minQty), type: x.type, value: x.type === 'fixed' ? microsText(x.value) : String(x.value) })));
  const [error, setError] = useState('');
  const [methodsMissing, setMethodsMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);

  const micros = parsePrice(price);
  const priceOk = micros != null && micros >= 1;
  const minutes = deliveryMinutesFrom(speed, unit);
  const tierList: VolumeTier[] = volumeOn
    ? tiers.map((x) => ({ minQty: Math.floor(Number(x.minQty)), type: x.type, value: x.type === 'fixed' ? parsePrice(x.value) ?? 0 : Math.floor(Number(x.value)) }))
    : [];
  const tierCheck = checkTiers(tierList, Math.max(1, Math.floor(Number(minQty)) || 1), priceOk ? micros : null);
  const serverDef = fields[0];

  const body = () => ({
    categorySlug: 'currency',
    game,
    deliveryMode: 'manual',
    attributes: Object.fromEntries(Object.entries(attrs).filter(([, v]) => v.trim())),
    stock: Math.floor(Number(stock)),
    unitPrice: priceOk ? tidyPrice(price) : price.trim(),
    minQty: Math.floor(Number(minQty)),
    description: description.trim(),
    volumeDiscounts: tierCheck.ok ? tierCheck.value : [],
    deliveryMethods: methods.length ? picked : undefined,
    deliveryMinutes: minutes,
  });

  const review = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const noMethod = methods.length > 0 && !picked.length;
    setMethodsMissing(noMethod);
    if (noMethod) return document.getElementById('co-method-0')?.focus();
    if (!priceOk) return setError(t('co.priceInvalid'));
    if (minutes == null) return setError(t('co.speedRange'));
    const limits = limitsError(minQty, Math.floor(Number(stock)));
    if (limits) return setError(limits);
    if (!tierCheck.ok) return setError(tierCheck.error);
    if (!description.trim()) return setError(t('lst.descriptionRequired'));
    setBusy(true);
    try {
      setPreview(await api<PreviewResponse>('/offers/preview', { body: body() }));
      window.scrollTo({ top: 0 });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const publish = async () => {
    setError('');
    setBusy(true);
    try {
      if (initial) {
        const { categorySlug: _c, game: _g, deliveryMode: _d, ...edit } = body();
        await api(`/offers/${initial.id}`, { method: 'PATCH', body: { ...edit, version: initial.version } });
      } else await api('/offers', { body: body() });
      onCreated();
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  if (preview) {
    return (
      <ListingPreview preview={preview} game={game} category="currency" stock={Math.floor(Number(stock))} sellerName={user?.display_name ?? ''} busy={busy} error={error}
        publishLabel={initial ? t('lst.saveChanges') : t('sell.f.create')} onEdit={() => (setPreview(null), setError(''))} onPublish={publish} />
    );
  }

  const setTier = (i: number, patch: Partial<TierRow>) => setTiers((ts) => ts.map((y, j) => (j === i ? { ...y, ...patch } : y)));

  return (
    <form className="pg-split co-form" onSubmit={review} aria-label={t('co.currencyForm')} noValidate={false}>
      <div className="stack co-sections">
        <section className="card stack" aria-labelledby="co-s1">
          <div className="row spread"><h2 id="co-s1" className="co-h2">{t('co.s.details')}</h2>{onChangeType && <button type="button" className="btn ghost sm" onClick={onChangeType}>{t('co.change')}</button>}</div>
          <div className="grid two">
            <label className="field">{t('co.type')}<input value={categoryLabel('currency')} readOnly aria-readonly="true" className="co-ro" /></label>
            <label className="field">{t('sell.f.game')}<input value={game} readOnly aria-readonly="true" className="co-ro" /></label>
            {fields.map((d) =>
              d === serverDef && d.type === 'select' ? (
                <GamePicker
                  key={`${game}-${d.key}`}
                  label={attrLabel(d.label)}
                  name={`attr.${d.key}`}
                  required
                  options={d.options ?? []}
                  value={attrs[d.key] ?? ''}
                  onChange={(v) => setAttrs((a) => ({ ...a, [d.key]: v }))}
                  placeholder={t('co.typeToFilter')}
                  limit={500}
                  invalidMessage={t('co.pickFromList')}
                  noneMessage={t('co.noMatch')}
                />
              ) : (
                <AttrInput key={`${game}-${d.key}`} def={d} value={attrs[d.key] ?? ''} onChange={(v) => setAttrs((a) => ({ ...a, [d.key]: v }))} />
              ),
            )}
            <label className="field">
              {t('co.stock')}
              <input name="stock" className="num" type="number" inputMode="numeric" min={1} max={2_000_000_000} step={1} required value={stock} onChange={(e) => setStock(e.target.value)} />
            </label>
            <MinPerOrder min={minQty} onMin={setMinQty} />
          </div>
          <label className="field">
            {t('lst.description')}
            <textarea name="description" required maxLength={5000} rows={5} dir="auto" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </section>

        <section className="card stack" aria-labelledby="co-s2">
          <h2 id="co-s2" className="co-h2">{t('co.s.delivery')}</h2>
          {methods.length > 0 && (
            <fieldset className="co-methods" aria-describedby={methodsMissing ? 'co-methods-err' : undefined} aria-invalid={methodsMissing || undefined}>
              <legend className="co-legend">{t('of.deliveryMethods')}</legend>
              {methods.map((m, i) => (
                <div key={m} className="co-method">
                  <label className="check-row">
                    <input id={`co-method-${i}`} type="checkbox" name="deliveryMethods" value={m} checked={picked.includes(m)}
                      onChange={(e) => (setMethodsMissing(false), setPicked((p) => (e.target.checked ? methods.filter((x) => x === m || p.includes(x)) : p.filter((x) => x !== m))))} />
                    {methodLabel(m)}
                  </label>
                  <HelpTip id={`co-tip-${m}`} label={t('co.helpAbout', { name: methodLabel(m) })} text={t(`co.help.${m}` as MessageKey)} />
                </div>
              ))}
              {methodsMissing && <p id="co-methods-err" className="co-field-err" role="alert">{t('co.required')}</p>}
            </fieldset>
          )}
          <fieldset className="co-speed">
            <legend className="co-legend">{t('co.speed')}</legend>
            <div className="co-speed-row">
              <label className="sr-only" htmlFor="co-speed-n">{t('co.speedValue')}</label>
              <input id="co-speed-n" name="deliveryValue" className="num" type="number" inputMode="numeric" min={1} max={unit === 'hours' ? 72 : MAX_DELIVERY_MINUTES} step={1} required value={speed} onChange={(e) => setSpeed(e.target.value)} />
              <label className="sr-only" htmlFor="co-speed-u">{t('co.speedUnit')}</label>
              <select id="co-speed-u" name="deliveryUnit" value={unit} onChange={(e) => setUnit(e.target.value as 'minutes' | 'hours')}>
                <option value="minutes">{t('co.minutes')}</option>
                <option value="hours">{t('co.hours')}</option>
              </select>
            </div>
          </fieldset>
        </section>

        <section className="card stack" aria-labelledby="co-s3">
          <h2 id="co-s3" className="co-h2">{t('co.s.volume')}</h2>
          <label className="check-row">
            <input type="checkbox" name="volumeOn" checked={volumeOn} onChange={(e) => (setVolumeOn(e.target.checked), e.target.checked && !tiers.length && setTiers([{ minQty: '', type: 'percent', value: '' }]))} />
            {t('co.volumeOn')}
          </label>
          {volumeOn && (
            <div className="co-tiers26">
              {tiers.map((x, i) => (
                <fieldset key={i} className="co-tier26">
                  <legend className="sr-only">{t('co.tierN', { n: i + 1 })}</legend>
                  <label className="field">
                    {t('co.tierFrom')}
                    <input className="num" type="number" inputMode="numeric" min={2} max={2_000_000_000} step={1} required aria-label={t('co.tierQtyN', { n: i + 1 })} value={x.minQty} onChange={(e) => setTier(i, { minQty: e.target.value })} />
                  </label>
                  <label className="field">
                    {t('co.tierType')}
                    <select aria-label={t('co.tierTypeN', { n: i + 1 })} value={x.type} onChange={(e) => setTier(i, { type: e.target.value as TierType, value: '' })}>
                      <option value="percent">{t('co.tierPercent')}</option>
                      <option value="fixed">{t('co.tierFixed')}</option>
                    </select>
                  </label>
                  <label className="field">
                    {x.type === 'percent' ? t('co.tierPct') : t('co.tierUnitPrice')}
                    {x.type === 'percent' ? (
                      <input className="num" type="number" inputMode="numeric" min={1} max={MAX_VOLUME_PERCENT} step={1} required aria-label={t('co.tierPctN', { n: i + 1 })} value={x.value} onChange={(e) => setTier(i, { value: e.target.value })} />
                    ) : (
                      <input className="num" inputMode="decimal" required autoComplete="off" aria-label={t('co.tierPriceN', { n: i + 1 })} value={x.value}
                        aria-invalid={x.value !== '' && parsePrice(x.value) == null ? true : undefined}
                        onChange={(e) => setTier(i, { value: e.target.value.replace(',', '.') })} onBlur={() => setTier(i, { value: tidyPrice(x.value) })} />
                    )}
                  </label>
                  <button type="button" className="btn ghost sm co-tier-x" aria-label={t('co.tierRemove', { n: i + 1 })} onClick={() => setTiers((ts) => ts.filter((_, j) => j !== i))}><Trash2 className="size-4" aria-hidden /></button>
                </fieldset>
              ))}
              {tiers.length < MAX_VOLUME_DISCOUNTS && (
                <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setTiers((ts) => [...ts, { minQty: '', type: 'percent', value: '' }])}>
                  <Plus className="size-4" aria-hidden /> {t('co.tierAdd')}
                </button>
              )}
            </div>
          )}
        </section>
      </div>

      <aside className="card pg-sticky stack co-side">
        <label className="field">
          {t('co.unitPrice')}
          <input
            name="unitPrice"
            className="num"
            inputMode="decimal"
            required
            autoComplete="off"
            value={price}
            aria-invalid={price !== '' && !priceOk ? true : undefined}
            onChange={(e) => setPrice(e.target.value.replace(',', '.'))}
            onBlur={() => setPrice((p) => tidyPrice(p))}
          />
        </label>
        <div className="pg-rows">
          <div className="pg-total"><span>{t('co.youGet')}</span><span className="pg-price num" data-testid="you-get">{priceOk ? unitMoney(micros!) : '—'}</span></div>
          <div className="pg-total"><span>{t('co.buyersPay')}</span><span className="pg-price num" data-testid="buyers-pay">{priceOk && rateBps != null ? unitMoney(grossMicros(micros!, rateBps)) : '—'}</span></div>
        </div>
        {serverDef && <PriceGuide game={game} server={attrs[serverDef.key] ?? ''} faction={attrs.faction} onUse={(m) => setPrice(microsText(m))} />}
        {error && <div className="alert" role="alert">{error}</div>}
        <button className="btn lg block" type="submit" disabled={busy}>{t('lst.preview')}</button>
      </aside>
    </form>
  );
}

/** A small (?) that explains a choice; the text shows on hover and keyboard focus and is the button's description. */
function HelpTip({ id, label, text }: { id: string; label: string; text: string }) {
  return (
    <span className="help-tip">
      <button type="button" className="help-tip-btn" aria-label={label} aria-describedby={id}>
        <Question className="size-4" aria-hidden />
      </button>
      <span role="tooltip" id={id} className="help-tip-text">{text}</span>
    </span>
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
