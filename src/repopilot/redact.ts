/**
 * Redaction of credentials from anything that is logged, audited, stored as
 * evidence or returned in an error. Pattern based, so it is a safety net and
 * not a substitute for never putting secrets there in the first place.
 */

export const REDACTED = "[REDACTED]";

type Replacer = string | ((...groups: string[]) => string);

const RULES: ReadonlyArray<readonly [RegExp, Replacer]> = [
  // Anthropic / OpenAI style keys
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, REDACTED],
  // GitHub tokens (classic, fine-grained, app, OAuth)
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  // AWS access key ids
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  // Authorization header values
  [/\b(Bearer|Basic|token)(\s+)[A-Za-z0-9._~+/=-]{12,}/gi, (_match, scheme = "", space = " ") => `${scheme}${space}${REDACTED}`],
  // Credentials embedded in URLs
  [/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, (_match, scheme = "") => `${scheme}${REDACTED}@`],
  // PEM private key blocks (also when truncated)
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  // name=value, name: value and "name": "value" where the name looks sensitive
  [
    /(["']?\b[\w-]*(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization)[\w-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    (_match, prefix = "", value = "") => {
      // Counters such as inputTokens / max_tokens are not credentials.
      if (/tokens["']?\s*[:=]\s*$/i.test(prefix) && /^\d+$/.test(value)) {
        return `${prefix}${value}`;
      }

      // Keep the quotes so redacted JSON stays parseable.
      const quote = value[0];

      return quote === '"' || quote === "'" ? `${prefix}${quote}${REDACTED}${quote}` : `${prefix}${REDACTED}`;
    },
  ],
];

/** Replace anything that looks like a credential. */
export function redactSensitive(text: string): string {
  let out = text;

  for (const [pattern, replacer] of RULES) {
    out = out.replace(pattern, replacer as (substring: string, ...args: string[]) => string);
  }

  return out;
}

const SENSITIVE_KEY = /key|token|secret|password|passwd|authorization|credential|cookie/i;

/**
 * Deep-copy a JSON-like value for audit/log storage: sensitive-looking keys
 * are dropped to "[REDACTED]", strings are scrubbed and truncated, and depth
 * and size are bounded.
 */
export function sanitizeForStorage(
  value: unknown,
  { maxString = 500, maxDepth = 6 }: { maxString?: number; maxDepth?: number } = {},
  depth = 0
): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const clean = redactSensitive(value);

    return clean.length > maxString ? `${clean.slice(0, maxString)}…` : clean;
  }

  if (depth >= maxDepth) {
    return "[truncated]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeForStorage(item, { maxString, maxDepth }, depth + 1));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(value).slice(0, 50)) {
      out[key] = SENSITIVE_KEY.test(key)
        ? REDACTED
        : sanitizeForStorage(child, { maxString, maxDepth }, depth + 1);
    }

    return out;
  }

  return undefined;
}
