import { useState } from "react";

/**
 * Poll only while something is in flight. Pass `pollMs` to the data hook and
 * call `sync(isBusy)` with the loaded data's state (undefined until loaded).
 */
export function useAutoPoll(ms: number): { pollMs: number | false; sync: (busy: boolean | undefined) => void } {
  const [pollMs, setPollMs] = useState<number | false>(ms);

  const sync = (busy: boolean | undefined) => {
    if (busy === undefined) return;

    const next = busy ? ms : false;

    // Adjusting state during render is the supported way to derive it from fetched data.
    if (next !== pollMs) setPollMs(next);
  };

  return { pollMs, sync };
}
