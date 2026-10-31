import { useEffect, useState } from 'react';
import { GamePicker } from './GamePicker';
import { t } from '../i18n';

/**
 * Round 26c: a list-mode dropdown for a choice with keys and labels (delivery speed unit, discount type, a game field):
 * focus shows the whole list, typing filters it ("Type to filter"), only a listed option is accepted.
 */
export function ListPicker({ options, value, onChange, label, name, required, hideLabel, ariaLabel }: {
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onChange: (v: string) => void;
  label: string;
  name?: string;
  required?: boolean;
  hideLabel?: boolean;
  ariaLabel?: string;
}) {
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? '';
  const [text, setText] = useState(labelOf(value));
  const labels = options.map((o) => o.label).join('|');
  useEffect(() => setText(labelOf(value)), [value, labels]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <GamePicker
      listMode
      options={options.map((o) => o.label)}
      value={text}
      onChange={(v) => {
        setText(v);
        const hit = options.find((o) => o.label.toLowerCase() === v.trim().toLowerCase());
        if (hit) onChange(hit.value);
        else if (!v.trim()) onChange('');
      }}
      label={label}
      name={name}
      required={required}
      hideLabel={hideLabel}
      ariaLabel={ariaLabel}
      placeholder={t('co.typeToFilter')}
      limit={500}
      invalidMessage={t('co.pickFromList2')}
      noneMessage={t('co.noMatch2')}
    />
  );
}
