import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

export interface TabItem {
  to: string;
  label: ReactNode;
  end?: boolean;
}

/** Route-backed tabs: each tab is a real URL (deep-linkable, back button works). */
export function NavTabs({ items, label }: { items: TabItem[]; label: string }) {
  return (
    <nav className="tabs" aria-label={label}>
      {items.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.end ?? false} className={({ isActive }) => `tab${isActive ? " active" : ""}`}>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** State-backed tabs for panels inside a page. */
export function Tabs<T extends string>({ value, onChange, items, label }: { value: T; onChange: (value: T) => void; items: Array<{ value: T; label: ReactNode }>; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button key={item.value} type="button" role="tab" className="tab" aria-selected={value === item.value} onClick={() => onChange(item.value)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}
