import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ThemeMode } from "@/lib/theme";
import { useTheme } from "./Theme";

const OPTIONS: Array<{ mode: ThemeMode; label: string; icon: LucideIcon }> = [
  { mode: "light", label: "Light", icon: Sun },
  { mode: "dark", label: "Dark", icon: Moon },
  { mode: "system", label: "System", icon: Monitor },
];

/** Header control for Light / Dark / System. A menu, not three buttons: it stays out of the way. */
export function ThemeSwitcher() {
  const { mode, resolved, setMode } = useTheme();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const Current = OPTIONS.find((option) => option.mode === mode)?.icon ?? Monitor;

  // Move focus into the menu when it opens: onto the selected option.
  useEffect(() => {
    if (open) items.current[OPTIONS.findIndex((option) => option.mode === mode)]?.focus();
  }, [open, mode]);

  useEffect(() => {
    if (!open) return undefined;

    const outside = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener("mousedown", outside);

    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  const close = (returnFocus: boolean) => {
    setOpen(false);

    if (returnFocus) trigger.current?.focus();
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = items.current.findIndex((item) => item === document.activeElement);
    const focus = (next: number) => {
      event.preventDefault();
      items.current[(next + OPTIONS.length) % OPTIONS.length]?.focus();
    };

    if (event.key === "ArrowDown") focus(index + 1);
    else if (event.key === "ArrowUp") focus(index - 1);
    else if (event.key === "Home") focus(0);
    else if (event.key === "End") focus(OPTIONS.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") setOpen(false);
  };

  return (
    <div className="menu theme-switcher" ref={wrapper}>
      <button
        ref={trigger}
        type="button"
        className="icon-btn"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Theme: ${mode === "system" ? `System (${resolved})` : mode}`}
        title="Theme"
      >
        <Current size={16} aria-hidden />
      </button>
      {open ? (
        <div id={menuId} className="menu__panel theme-menu" role="menu" aria-label="Theme" onKeyDown={onMenuKey}>
          {OPTIONS.map(({ mode: value, label, icon: Icon }, index) => (
            <button
              key={value}
              ref={(node) => {
                items.current[index] = node;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={mode === value}
              className="menu__item theme-menu__item"
              onClick={() => {
                setMode(value);
                close(true);
              }}
            >
              <Icon size={15} aria-hidden />
              <span className="grow">
                {label}
                {value === "system" ? <span className="theme-menu__hint"> · currently {resolved}</span> : null}
              </span>
              {mode === value ? <Check size={14} aria-hidden /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
