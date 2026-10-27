import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown } from "lucide-react";
import { Button } from "./Button";

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Comparator for ascending order; makes the column sortable. */
  sort?: (a: T, b: T) => number;
  align?: "right";
  width?: string;
}

interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  /** Row activation (click / Enter). Put a real link in a cell as well for accessibility. */
  onRowClick?: (row: T) => void;
  initialSort?: { key: string; direction: "asc" | "desc" };
  pageSize?: number;
  /** Shown when there are no rows. */
  empty?: ReactNode;
  caption: string;
}

export function DataTable<T>({ rows, columns, rowKey, onRowClick, initialSort, pageSize = 15, empty, caption }: DataTableProps<T>) {
  const [sort, setSort] = useState(initialSort ?? null);
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    const column = sort ? columns.find((c) => c.key === sort.key) : undefined;

    if (!sort || !column?.sort) return rows;

    const compare = column.sort;
    const copy = [...rows].sort(compare);

    return sort.direction === "asc" ? copy : copy.reverse();
  }, [rows, columns, sort]);

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(page, pages - 1);
  const visible = sorted.slice(current * pageSize, (current + 1) * pageSize);

  if (rows.length === 0) return <>{empty ?? null}</>;

  const toggle = (key: string) => {
    setPage(0);
    setSort((s) => (s?.key === key ? { key, direction: s.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" }));
  };

  return (
    <>
      <div className="table-wrap">
        <table className={`table${onRowClick ? " table--clickable" : ""}`}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((column) => {
                const active = sort?.key === column.key;
                const Icon = !active ? ChevronsUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;

                return (
                  <th key={column.key} scope="col" style={{ width: column.width, textAlign: column.align }} aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}>
                    {column.sort ? (
                      <button type="button" className="th-sort" onClick={() => toggle(column.key)}>
                        {column.header}
                        <Icon size={12} aria-hidden />
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick
                    ? (event) => {
                        if (event.key === "Enter" && event.target === event.currentTarget) onRowClick(row);
                      }
                    : undefined
                }
                tabIndex={onRowClick ? 0 : undefined}
              >
                {columns.map((column) => (
                  <td key={column.key} className={column.align === "right" ? "num" : undefined}>
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 ? (
        <div className="pagination">
          <span>
            {current * pageSize + 1}–{Math.min((current + 1) * pageSize, sorted.length)} of {sorted.length}
          </span>
          <div className="row">
            <Button size="sm" variant="ghost" onClick={() => setPage(current - 1)} disabled={current === 0} aria-label="Previous page" icon={<ChevronLeft size={14} aria-hidden />} />
            <span>Page {current + 1} / {pages}</span>
            <Button size="sm" variant="ghost" onClick={() => setPage(current + 1)} disabled={current >= pages - 1} aria-label="Next page" icon={<ChevronRight size={14} aria-hidden />} />
          </div>
        </div>
      ) : null}
    </>
  );
}
