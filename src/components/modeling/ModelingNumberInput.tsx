import { useEffect, useState } from 'react';

export function ModelingNumberInput({
  value,
  onChange,
  min,
  max,
  step = 0.001,
  label,
  suffix,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  suffix?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);
  const commit = () => {
    const next = Number(draft);
    setEditing(false);
    if (!draft.trim() || !Number.isFinite(next)) {
      setDraft(String(value));
      return;
    }
    if (next !== value) onChange(next);
  };
  return (
    <div className="number-field">
      <input
        aria-label={label}
        type="number"
        value={editing ? draft : String(value)}
        min={min}
        max={max}
        step={step}
        onFocus={() => {
          setDraft(String(value));
          setEditing(true);
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
      {suffix && <span>{suffix}</span>}
    </div>
  );
}
