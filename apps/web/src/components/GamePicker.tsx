import { useId, useMemo, useRef, useState } from 'react';
import { CaretDown } from '@phosphor-icons/react';
import { t } from '../i18n';

/**
 * Type a game name, then choose it from the list. Free text is not accepted: the field is only
 * valid when it matches one of `options` (case-insensitive), and then takes that spelling.
 */
export function GamePicker({ options, value, onChange, label, name, placeholder, required, className, limit = 8, invalidMessage, noneMessage, listMode = false, hideLabel = false, ariaLabel }: {
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
  label: string;
  name?: string;
  placeholder?: string;
  required?: boolean;
  className?: string;
  /** How many matches to list (Round 26b server picker: all of them, in a scrolling list). */
  limit?: number;
  invalidMessage?: string;
  noneMessage?: string;
  /**
   * Round 26c "list mode": a dropdown you can type into. Focus shows every option (even when one is chosen); typing
   * filters ("Type to filter"); only a listed option is accepted.
   */
  listMode?: boolean;
  hideLabel?: boolean;
  ariaLabel?: string;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [typing, setTyping] = useState(false);
  const typed = value.trim().toLowerCase();
  const q = listMode && !typing ? '' : typed;
  const matches = useMemo(() => {
    const starts = options.filter((o) => o.toLowerCase().startsWith(q));
    const contains = options.filter((o) => !o.toLowerCase().startsWith(q) && o.toLowerCase().includes(q));
    return [...starts, ...contains].slice(0, limit);
  }, [options, q, limit]);
  const exact = options.find((o) => o.toLowerCase() === typed);
  const pick = (o: string) => {
    onChange(o);
    setOpen(false);
    setTyping(false);
    input.current?.setCustomValidity('');
  };
  const check = (v: string) => input.current?.setCustomValidity(!v.trim() || options.some((o) => o.toLowerCase() === v.trim().toLowerCase()) ? '' : invalidMessage ?? t('picker.choose'));

  return (
    <label className={`field gp ${className ?? ''}`}>
      {hideLabel ? <span className="sr-only">{label}</span> : label}
      <span className={listMode ? 'gp-wrap gp-listmode' : 'gp-wrap'}>
        <input
          ref={input}
          name={name}
          value={value}
          required={required}
          placeholder={placeholder ?? t('picker.placeholder')}
          autoComplete="off"
          role="combobox"
          aria-expanded={open && matches.length > 0}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[active] ? `${id}-${active}` : undefined}
          aria-label={ariaLabel}
          onFocus={() => (setOpen(true), setTyping(false), setActive(Math.max(0, matches.findIndex((o) => o.toLowerCase() === typed))))}
          onClick={() => setOpen(true)}
          onBlur={() => {
            setTimeout(() => setOpen(false), 120);
            if (exact && exact !== value) onChange(exact);
            check(value);
          }}
          onChange={(e) => {
            onChange(e.target.value);
            setTyping(true);
            setActive(0);
            setOpen(true);
            check(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setOpen(true), setActive((a) => Math.min(a + 1, matches.length - 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
            else if (e.key === 'Enter' && open && matches[active] && (listMode || !exact)) (e.preventDefault(), pick(matches[active]!));
            else if (e.key === 'Escape') setOpen(false);
          }}
        />
        {listMode && <CaretDown className="gp-caret size-4" aria-hidden />}
        {open && matches.length > 0 && (listMode || !(exact && matches.length === 1)) && (
          <ul className="gp-list" role="listbox" id={`${id}-list`}>
            {matches.map((o, i) => (
              <li key={o} id={`${id}-${i}`} role="option" aria-selected={i === active} data-chosen={o.toLowerCase() === typed || undefined} onMouseDown={(e) => (e.preventDefault(), pick(o))} onMouseEnter={() => setActive(i)}>
                {o}
              </li>
            ))}
          </ul>
        )}
        {open && q && matches.length === 0 && <span className="gp-none small muted" role="status">{noneMessage ?? t('picker.none')}</span>}
      </span>
    </label>
  );
}
