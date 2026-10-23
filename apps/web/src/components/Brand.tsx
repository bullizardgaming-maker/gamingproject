import type React from 'react';
import { t, useLocale } from '../i18n';
/**
 * Bullizard brand marks, drawn in currentColor so they follow the theme.
 * Mark (coin-eye) is the main logo and app icon; the wordmark is outlined Alexandria 800 with the
 * horned, fanged B. Never set the name in a font. Source files: public/brand/*.svg.
 */
type P = { className?: string; title?: string; style?: React.CSSProperties };

export function BrandMark({ className, title, style }: P) {
  return (
    <svg viewBox="0 0 72 64" className={className} style={style} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} fill="currentColor">
      <path d="M4 8C14 31 58 31 68 8C56 22 16 22 4 8Z" />
      <circle cx="36" cy="41" r="16" fill="none" stroke="currentColor" strokeWidth="6" />
      <path d="M36 30.5C39.2 35.5 39.2 46.5 36 51.5C32.8 46.5 32.8 35.5 36 30.5Z" />
    </svg>
  );
}

export function BrandWordmark({ className, title, style }: P) {
  return (
    <svg viewBox="-45 -925 4682 945" className={className} style={style} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} fill="currentColor">
      <g transform="scale(1 -1)"><path transform="translate(0 0)" d="M403 701Q486 701 546.0 679.0Q606 657 639.0 617.5Q672 578 672 524Q672 471 640.0 430.0Q608 389 553 373Q618 359 656.0 311.0Q694 263 694 196Q694 136 660.0 92.0Q626 48 564.5 24.0Q503 0 418 0H59V701ZM392 426Q422 426 440.5 442.5Q459 459 459 487Q459 515 440.5 530.0Q422 545 392 545H266V426ZM392 156Q431 155 455.0 173.0Q479 191 479 222Q479 250 455.0 267.0Q431 284 392 283H266V168L249 74L302 156Z"/><path d="M-25 905C60 625 692 625 777 905C680 715 72 715 -25 905Z"/><path transform="translate(720 0)" d="M248 256Q248 216 268.0 192.5Q288 169 321 169Q360 170 382.5 199.0Q405 228 405 275H451Q451 185 425.0 122.0Q399 59 351.5 25.0Q304 -9 238 -9Q181 -9 137.5 17.0Q94 43 70.0 89.5Q46 136 46 199V544H248ZM405 544H607V0H405Z"/><path transform="translate(1388 0)" d="M66 742H268V0H66Z"/><path transform="translate(1723 0)" d="M66 742H268V0H66Z"/><path transform="translate(2058 0)" d="M61 544H263V0H61ZM163 803Q209 803 238.0 773.5Q267 744 267 699Q267 653 238.0 624.0Q209 595 163 595Q118 595 88.5 624.0Q59 653 59 699Q59 744 88.5 773.5Q118 803 163 803Z"/><path transform="translate(2382 0)" d="M39 544 527 543V424L283 151H537V0H29V119L273 392H39Z"/><path transform="translate(2944 0)" d="M271 228Q241 228 225.5 215.5Q210 203 210 177Q210 152 226.0 137.5Q242 123 271 123Q292 123 310.0 130.0Q328 137 342.0 149.5Q356 162 363 179L388 107Q368 52 321.0 21.5Q274 -9 204 -9Q146 -9 105.0 12.5Q64 34 42.0 72.5Q20 111 20 162Q20 241 74.0 283.5Q128 326 230 327H381V228ZM363 329Q363 363 339.0 382.0Q315 401 269 401Q236 401 193.0 391.0Q150 381 105 362L55 496Q100 514 144.0 527.0Q188 540 231.5 546.0Q275 552 317 552Q432 552 496.5 500.0Q561 448 561 353V0H363Z"/><path transform="translate(3551 0)" d="M434 370Q382 377 343.5 365.0Q305 353 284.0 326.5Q263 300 263 260L217 269Q217 356 243.5 420.0Q270 484 319.0 518.0Q368 552 434 552ZM61 544H263V0H61Z"/><path transform="translate(3995 0)" d="M266 551Q333 551 381.0 517.0Q429 483 456.0 421.0Q483 359 483 274Q483 188 457.0 125.0Q431 62 383.5 27.5Q336 -7 271 -7Q195 -7 138.5 27.5Q82 62 50.5 126.0Q19 190 19 275Q19 359 49.5 420.5Q80 482 136.0 516.5Q192 551 266 551ZM322 391Q292 391 269.5 376.0Q247 361 235.0 333.5Q223 306 223 270Q223 233 235.0 206.0Q247 179 269.5 163.5Q292 148 322 148Q352 148 374.0 163.5Q396 179 408.0 206.0Q420 233 420 270Q420 306 408.0 333.5Q396 361 374.0 376.0Q352 391 322 391ZM420 742H622V0H420Z"/></g>
    </svg>
  );
}

/** Mark + name lockup: mark 1.25x the wordmark height, 0.4em gap. `size` is the wordmark height in px. */
export function BrandLockup({ className, size = 20 }: { className?: string; size?: number }) {
  // Arabic uses the Arabic lockup from the brand canvas: the mark with بوليزارد in Alexandria 800.
  const ar = useLocale() === 'ar';
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(size * 0.4), lineHeight: 1 }}>
      <BrandMark style={{ height: size * 1.25, width: 'auto', flex: 'none' }} />
      {ar ? (
        <span lang="ar" aria-hidden className="wordmark-ar" style={{ fontSize: Math.round(size * 1.3) }}>بوليزارد</span>
      ) : (
        <BrandWordmark style={{ height: size, width: 'auto', flex: 'none' }} />
      )}
    </span>
  );
}

/** The brand name set inline in running text, drawn as the logo (wordmark, or بوليزارد in Arabic). */
export function BrandName({ className }: { className?: string }) {
  const ar = useLocale() === 'ar';
  return ar ? (
    <span lang="ar" className={`wordmark-ar brand-inline ${className ?? ''}`}>بوليزارد</span>
  ) : (
    <BrandWordmark title="Bullizard" className={`brand-inline ${className ?? ''}`} style={{ height: '1.3em', width: 'auto', verticalAlign: '-0.22em' }} />
  );
}

/** "Bullizard Buyer Protection" with the name as the logo. */
export function BuyerProtection({ text = true }: { text?: boolean }) {
  return (
    <div className="bp">
      <b className="bp-title"><BrandName /> {t('protect.title')}</b>
      {text && <span className="small muted">{t('protect.text')}</span>}
    </div>
  );
}
