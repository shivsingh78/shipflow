import type { ReleaseLogRow } from "@/api/types";

export interface LogFilter {
  query: string;
  /** Empty = all levels. */
  levels: string[];
  /** "" = all stages. */
  stage: string;
}

export function filterLogs(rows: ReleaseLogRow[], { query, levels, stage }: LogFilter): ReleaseLogRow[] {
  const needle = query.trim().toLowerCase();

  return rows.filter(
    (row) =>
      (levels.length === 0 || levels.includes(row.level)) &&
      (stage === "" || row.stage === stage) &&
      (needle === "" || row.message.toLowerCase().includes(needle))
  );
}

/** Plain text for copy / download: "[time] [STAGE] [LEVEL] message". */
export function logsToText(rows: ReleaseLogRow[]): string {
  return rows.map((row) => `[${row.created_at}] [${row.stage}] [${row.level}] ${row.message}`).join("\n");
}

/** Split text around case-insensitive matches of `query` (for highlighting). */
export function splitMatches(text: string, query: string): Array<{ text: string; match: boolean }> {
  const needle = query.trim();

  if (!needle) return [{ text, match: false }];

  const parts: Array<{ text: string; match: boolean }> = [];
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  let from = 0;

  for (;;) {
    const at = lower.indexOf(target, from);

    if (at === -1) break;
    if (at > from) parts.push({ text: text.slice(from, at), match: false });

    parts.push({ text: text.slice(at, at + target.length), match: true });
    from = at + target.length;
  }

  if (from < text.length) parts.push({ text: text.slice(from), match: false });

  return parts;
}
