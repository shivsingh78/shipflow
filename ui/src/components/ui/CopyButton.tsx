import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** Copies text to the clipboard and confirms; falls back silently if blocked. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context / denied): nothing to do.
    }
  };

  return (
    <button type="button" className="icon-btn" onClick={() => void copy()} aria-label={done ? "Copied" : label} title={done ? "Copied" : label}>
      {done ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
    </button>
  );
}

/** Monospace value with a copy button (commit SHAs, digests, URLs). */
export function CopyValue({ value, display }: { value: string; display?: string }) {
  return (
    <span className="copy-value">
      <code title={value}>{display ?? value}</code>
      <CopyButton text={value} label={`Copy ${value}`} />
    </span>
  );
}
