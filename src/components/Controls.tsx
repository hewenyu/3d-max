import { useEffect, useId, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X, type LucideIcon } from 'lucide-react';
import type { Vec3 } from '../../shared/types';

export function IconButton({
  icon: Icon,
  label,
  active,
  className = '',
  ...props
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={`icon-button ${active ? 'active' : ''} ${className}`}
      aria-label={label}
      title={label}
    >
      <Icon size={16} strokeWidth={1.7} />
    </button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 0.1,
  label,
  suffix,
  disabled,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  suffix?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(Math.round(value * 1000) / 1000));
  const [editing, setEditing] = useState(false);
  useEffect(() => setDraft(String(Math.round(value * 1000) / 1000)), [value]);
  const commit = () => {
    const number = Number(draft);
    if (!draft.trim() || !Number.isFinite(number)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, number));
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };
  return (
    <div className="number-field">
      <input
        aria-label={label}
        disabled={disabled}
        type="number"
        min={min}
        max={max}
        step={step}
        value={editing ? draft : String(Math.round(value * 1000) / 1000)}
        onFocus={() => {
          setDraft(String(Math.round(value * 1000) / 1000));
          setEditing(true);
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          commit();
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      {suffix && <span>{suffix}</span>}
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  label,
  multiline = false,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  multiline?: boolean;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onChange(draft);
  };
  const props = {
    'aria-label': label,
    value: editing ? draft : value,
    placeholder,
    onFocus: () => {
      setDraft(value);
      setEditing(true);
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: () => {
      commit();
      setEditing(false);
    },
  };
  return multiline ? (
    <textarea {...props} rows={3} />
  ) : (
    <input
      {...props}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

export function VectorInput({
  label,
  value,
  onChange,
  onAxisChange,
  step = 0.1,
}: {
  label: string;
  value: Vec3;
  onChange: (v: Vec3) => void;
  onAxisChange?: (axis: number, value: number) => void;
  step?: number;
}) {
  return (
    <div className="vector-field">
      <span className="field-label">{label}</span>
      <div className="vector-inputs">
        {value.map((v, i) => (
          <label key={i}>
            <span className={`axis axis-${i}`}>{['X', 'Y', 'Z'][i]}</span>
            <NumberInput
              value={v}
              label={`${label} ${['X', 'Y', 'Z'][i]}`}
              step={step}
              onChange={(n) => {
                if (onAxisChange) {
                  onAxisChange(i, n);
                  return;
                }
                const next = [...value] as Vec3;
                next[i] = n;
                onChange(next);
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

export function Section({
  title,
  children,
  extra,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  extra?: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="panel-section" open={defaultOpen}>
      <summary>
        <ChevronDown size={13} />
        <span>{title}</span>
        {extra && (
          <span className="section-extra" onClick={(e) => e.stopPropagation()}>
            {extra}
          </span>
        )}
      </summary>
      <div className="section-content">{children}</div>
    </details>
  );
}

export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const id = useId();
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [onClose]);
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={`modal ${wide ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
      >
        <header>
          <h2 id={id}>{title}</h2>
          <IconButton icon={X} label="关闭" onClick={onClose} />
        </header>
        {children}
      </section>
    </div>,
    document.body,
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}
export function timecode(time: number, fps = 24) {
  const total = Math.max(0, Math.floor(time * fps + 0.001));
  return `${String(Math.floor(total / (60 * fps))).padStart(2, '0')}:${String(Math.floor(total / fps) % 60).padStart(2, '0')}:${String(total % fps).padStart(2, '0')}`;
}
