import { useEffect, useId, useRef, useState } from 'react';
import { Check, Ellipsis, type LucideIcon } from 'lucide-react';
import { IconButton } from './Controls';

export interface ViewportMenuAction {
  label: string;
  icon: LucideIcon;
  run: () => void;
  active?: boolean;
  disabled?: boolean;
}

export function ViewportToolsMenu({ actions }: { actions: ViewportMenuAction[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', dismiss);
    root.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    return () => window.removeEventListener('pointerdown', dismiss);
  }, [open]);
  return (
    <div
      className="viewport-tools-menu"
      ref={root}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === 'Escape') {
          event.stopPropagation();
          setOpen(false);
          root.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus();
        }
        if (event.key === 'Tab') setOpen(false);
        const buttons = Array.from(
          root.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [],
        );
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && buttons.length) {
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next].focus();
        }
      }}
    >
      <IconButton
        icon={Ellipsis}
        label="更多视口工具"
        aria-haspopup="menu"
        aria-controls={menuId}
        aria-expanded={open}
        active={open}
        onClick={() => setOpen(!open)}
      />
      {open && (
        <div id={menuId} role="menu" aria-label="视口工具" className="viewport-tools-popover">
          {actions.map(({ label, icon: Icon, run, active, disabled }) => (
            <button
              key={label}
              type="button"
              role={active === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={active}
              disabled={disabled}
              onClick={() => {
                setOpen(false);
                run();
              }}
            >
              <Icon size={15} />
              <span>{label}</span>
              {active && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
