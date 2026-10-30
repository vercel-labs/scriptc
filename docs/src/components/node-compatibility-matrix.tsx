"use client";
// Filter state is disposable developer UI state. Remount on Fast Refresh so
// an old search/status selection cannot make a newly generated ledger appear
// empty after an edit.
// @refresh reset

import { memo, startTransition, useCallback, useDeferredValue, useEffect, useId, useMemo, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  buildTree,
  expandableIds,
  filterTree,
  flattenTree,
  nodeCount,
  rowMatcher,
  searchTexts,
  statusCounts,
  statuses,
  type NodeStability,
  type Row,
  type Snapshot,
  type Status,
  type Verification,
} from "@/lib/compatibility-tree";

// Set by next.config.mjs from the committed artifact.
const artifactVersion = process.env.COMPATIBILITY_ARTIFACT_VERSION;
const rowCount = Number(process.env.COMPATIBILITY_ROW_COUNT);

const labels: Record<Status, string> = {
  supported: "Supported",
  partial: "Partial",
  refused: "Refused",
  "not-implemented": "Not implemented",
  "by-design": "By design",
  unreviewed: "Unreviewed",
  "not-applicable": "N/A",
};

const styles: Record<Status, string> = {
  supported: "border-green-500/40 bg-green-100 text-green-900 dark:bg-green-200",
  partial: "border-amber-500/50 bg-amber-100 text-amber-900 dark:bg-amber-200",
  refused: "border-red-500/40 bg-red-100 text-red-900 dark:bg-red-200",
  "not-implemented": "border-blue-500/40 bg-blue-100 text-blue-900 dark:bg-blue-200",
  "by-design": "border-gray-alpha-500 bg-gray-alpha-200 text-gray-1000",
  unreviewed: "border-gray-alpha-500 bg-gray-alpha-100 text-gray-900",
  "not-applicable": "border-gray-alpha-400 bg-background-200 text-gray-700",
};

const stabilityStyles: Record<number, string> = {
  0: "border-red-500/40 bg-red-100 text-red-900 dark:bg-red-200",
  1: "border-amber-500/50 bg-amber-100 text-amber-900 dark:bg-amber-200",
  2: "border-green-500/40 bg-green-100 text-green-900 dark:bg-green-200",
  3: "border-gray-alpha-500 bg-gray-alpha-100 text-gray-900",
};

/** A badge's tooltip, mounted only while the badge is hovered or has
 * keyboard focus (the :focus-visible rule the CSS-only tooltip used), and
 * named by aria-describedby while open. Hover and focus are tracked apart,
 * so moving the pointer away keeps a keyboard-focused badge's tooltip.
 * Escape dismisses it until the next hover or focus. */
function BadgeTooltip({ tooltipClass, children, badge }: { tooltipClass: string; children: ReactNode; badge: ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const open = hovered || focused;
  const id = useId();
  const enter = useCallback(() => setHovered(true), []);
  const leave = useCallback(() => setHovered(false), []);
  const focus = useCallback((event: FocusEvent<HTMLSpanElement>) => {
    if (event.currentTarget.matches(":focus-visible")) setFocused(true);
  }, []);
  const blur = useCallback(() => setFocused(false), []);
  const key = useCallback((event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "Escape") return;
    setHovered(false);
    setFocused(false);
  }, []);
  return (
    <span
      className="relative inline-flex"
      tabIndex={0}
      aria-describedby={open ? id : undefined}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={focus}
      onBlur={blur}
      onKeyDown={key}
    >
      {badge}
      {open ? (
        <span id={id} role="tooltip" className={`pointer-events-none absolute top-full z-30 mt-2 rounded-md border border-gray-alpha-500 bg-background-100 p-2 text-left text-xs font-normal leading-5 text-gray-1000 opacity-100 shadow-popover transition-opacity starting:opacity-0 ${tooltipClass}`}>
          {children}
        </span>
      ) : null}
    </span>
  );
}

export const StatusBadge = memo(function StatusBadge({ status, detail, verification }: { status: Status; detail?: string; verification?: Verification }) {
  const tooltip = verification ? `${detail ?? ""}${detail ? "\n\n" : ""}Verification: ${verification.label}. ${verification.detail}` : detail;
  const badge = (
    <span
      className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${styles[status]}`}
      title={tooltip}
    >
      {labels[status]}
    </span>
  );
  if (!tooltip) return <span className="relative inline-flex">{badge}</span>;
  return (
    <BadgeTooltip tooltipClass="left-0 w-64" badge={badge}>
      {detail ? <span className="block">{detail}</span> : null}
      {verification ? <span className={detail ? "mt-2 block border-t border-gray-alpha-400 pt-2" : "block"}><strong>Verification:</strong> {verification.label}. {verification.detail}</span> : null}
    </BadgeTooltip>
  );
});

export const StabilityBadge = memo(function StabilityBadge({ stability }: { stability: NodeStability }) {
  if (stability === null) return <span className="text-xs text-gray-700" title="Node.js does not publish a stability index for this entry.">—</span>;
  const detail = `Node.js Stability ${stability.index}: ${stability.text}${stability.inherited ? " (inherited from the nearest parent section)" : ""}`;
  return (
    <BadgeTooltip
      tooltipClass="left-1/2 w-72 -translate-x-1/2"
      badge={
        <span className={`inline-flex min-w-7 justify-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${stabilityStyles[stability.level] ?? stabilityStyles[3]}`} title={detail}>
          {stability.index}
        </span>
      }
    >
      {detail}
    </BadgeTooltip>
  );
});

function Chevron({ open }: { open: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 3 5 5-5 5" />
    </svg>
  );
}

type MatrixRowProps = {
  row: Row;
  level: number;
  hasChildren: boolean;
  open: boolean;
  filtering: boolean;
  displayName: string;
  href: string;
  verification: Verification | undefined;
  onToggle: (id: string) => void;
};

/** One table row. Memoized on its own values, so a filter or expansion
 * change re-renders only the rows whose values changed. */
const MatrixRow = memo(function MatrixRow({ row, level, hasChildren, open, filtering, displayName, href, verification, onToggle }: MatrixRowProps) {
  const isRoot = level === 1;
  return (
    <tr aria-level={level} aria-expanded={hasChildren ? open : undefined} className={`align-top hover:bg-gray-alpha-100/60 ${isRoot ? "bg-background-200/60" : ""}`}>
      <td>
        <div className="flex items-start gap-1.5" style={{ paddingLeft: `${(level - 1) * 18}px` }}>
          {hasChildren ? (
            <button type="button" onClick={() => onToggle(row.id)} disabled={filtering} aria-label={`${open ? "Collapse" : "Expand"} ${displayName}`} className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-800 hover:bg-gray-alpha-200 hover:text-gray-1000 disabled:cursor-default disabled:hover:bg-transparent">
              <Chevron open={open} />
            </button>
          ) : <span className="h-5 w-5 shrink-0" />}
          <div className="min-w-0">
            <a href={href} target="_blank" rel="noopener noreferrer" className={`${isRoot ? "font-sans text-sm font-medium" : "font-mono text-xs"} text-gray-1000 underline decoration-gray-alpha-500 underline-offset-2 hover:decoration-gray-1000`}>
              {displayName}
            </a>
            <div className="mt-1 text-[11px] text-gray-800">
              {row.kind}{row.apiSymbol && row.apiSymbol !== row.signature && !isRoot ? ` · ${row.apiSymbol}` : ""}
            </div>
          </div>
        </div>
      </td>
      <td className="text-center"><StabilityBadge stability={row.nodeStability} /></td>
      <td><StatusBadge status={row.static.status} detail={row.static.detail} verification={verification} /></td>
    </tr>
  );
});

export function NodeCompatibilityMatrix() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");
  const [staticFilter, setStaticFilter] = useState<"all" | Status>("all");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const rows = useMemo(() => snapshot?.rows ?? [], [snapshot]);
  const chapters = useMemo(() => snapshot?.chapters ?? [], [snapshot]);
  const verificationBases = snapshot?.verificationBases;
  const apiRowCount = useMemo(() => rows.filter((row) => row.scope === "api").length, [rows]);
  const chapterTitles = useMemo(() => new Map(chapters.map((item) => [item.slug, item.title])), [chapters]);
  const base = `https://nodejs.org/docs/v${snapshot?.nodeVersion ?? "24.22.0"}/api/`;
  const staticCounts = useMemo(() => statusCounts(rows), [rows]);
  const visibleStatuses = useMemo(() => statuses.filter((status) => staticCounts[status] > 0), [staticCounts]);
  const tree = useMemo(() => buildTree(rows), [rows]);
  const texts = useMemo(() => searchTexts(rows, chapterTitles), [rows, chapterTitles]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/compatibility/data?v=${artifactVersion}`, { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`compatibility data: ${response.status}`);
        return response.json() as Promise<Snapshot>;
      })
      .then((data) => {
        if (!Array.isArray(data.rows) || data.rows.length !== rowCount) {
          throw new Error(`compatibility data is stale or malformed (expected ${rowCount} rows)`);
        }
        setSnapshot(data);
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") setLoadError(true);
      });
    return () => controller.abort();
  }, []);

  // The search field and the status select update at once; the table
  // follows the deferred values, so input stays responsive while the rows
  // re-render.
  const deferredQuery = useDeferredValue(query);
  const deferredStatic = useDeferredValue(staticFilter);
  const needle = deferredQuery.trim().toLocaleLowerCase();
  const hasResultFilter = needle !== "" || deferredStatic !== "all";

  const result = useMemo(
    () => hasResultFilter ? filterTree(tree, rowMatcher(texts, needle, deferredStatic)) : { nodes: tree, matched: nodeCount(tree) },
    [hasResultFilter, needle, deferredStatic, texts, tree],
  );
  const visible = useMemo(
    () => flattenTree(result.nodes, expanded, hasResultFilter),
    [expanded, hasResultFilter, result],
  );
  const matchedCount = result.matched;

  const changeQuery = (value: string) => setQuery(value);
  const resetFilters = () => {
    setQuery("");
    setStaticFilter("all");
    setExpanded(new Set());
  };
  const toggle = useCallback((id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }), []);

  useEffect(() => {
    if (!snapshot) return;
    if (staticFilter !== "all" && staticCounts[staticFilter] === 0) setStaticFilter("all");
  }, [snapshot, staticCounts, staticFilter]);

  if (loadError) {
    return <div className="flex h-full items-center justify-center p-6"><div className="rounded-xl border border-red-500/40 bg-red-100 p-4 text-sm text-red-900">The compatibility dataset could not be loaded.</div></div>;
  }
  if (!snapshot) {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-gray-900">Loading {rowCount.toLocaleString()} Node.js API rows…</div>;
  }

  return (
    <section aria-labelledby="compatibility-title" className="flex h-full min-h-0 flex-col bg-background-100">
      <div className="shrink-0 border-b border-gray-alpha-400 bg-background-200 px-3 py-3 md:px-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <div className="min-w-fit">
            <h1 id="compatibility-title" className="text-lg font-semibold leading-6 text-gray-1000">Node.js 24 Compatibility</h1>
            <p className="text-xs text-gray-800">Native compilation · Node {snapshot.nodeVersion}</p>
          </div>
          <div className="grid min-w-0 flex-1 gap-2 md:grid-cols-[minmax(240px,1fr)_auto]">
        <label className="relative block">
          <span className="sr-only">Search the Node.js API inventory</span>
          <svg aria-hidden="true" viewBox="0 0 16 16" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-800" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" />
          </svg>
          <input type="search" value={query} onChange={(event) => changeQuery(event.target.value)} placeholder={`Search ${apiRowCount.toLocaleString()} APIs and signatures…`} className="h-9 w-full rounded-md border border-gray-alpha-500 bg-background-100 pl-9 pr-3 text-sm text-gray-1000 placeholder:text-gray-700" />
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-900">
          <span>Static</span>
          <select value={staticFilter} onChange={(event) => setStaticFilter(event.target.value as "all" | Status)} className="h-9 rounded-md border border-gray-alpha-500 bg-background-100 px-2 text-xs text-gray-1000">
            <option value="all">All</option>
            {statuses.filter((status) => staticCounts[status] > 0).map((status) => <option key={status} value={status}>{labels[status]} ({staticCounts[status]})</option>)}
          </select>
        </label>

          </div>
          <div className="flex shrink-0 items-center gap-3 text-xs text-gray-900">
            <span aria-live="polite">{visible.length.toLocaleString()} visible · {matchedCount.toLocaleString()} {hasResultFilter ? "matching" : "API"} rows</span>
            {!hasResultFilter ? (
              <span className="flex gap-1">
                <button type="button" onClick={() => startTransition(() => setExpanded(expandableIds(tree)))} className="rounded px-1.5 py-1 text-gray-900 hover:bg-gray-alpha-100 hover:text-gray-1000">Expand all</button>
                <button type="button" onClick={() => startTransition(() => setExpanded(new Set()))} className="rounded px-1.5 py-1 text-gray-900 hover:bg-gray-alpha-100 hover:text-gray-1000">Collapse all</button>
              </span>
            ) : null}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-900">
          {visibleStatuses.map((status) => <StatusBadge key={status} status={status} />)}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto overscroll-contain bg-background-100">
        <table role="treegrid" aria-label="Node.js 24 compatibility hierarchy" className="compatibility-table min-w-[900px]">
          <thead className="sticky top-0 z-10 bg-background-200/95 backdrop-blur-sm">
            <tr><th className="w-[55%]">Node.js API hierarchy</th><th className="w-[15%] text-center">Node stability</th><th className="w-[30%]">Native support</th></tr>
          </thead>
          <tbody>
            {visible.map(({ node, level }) => {
              const row = node.row;
              return (
                <MatrixRow
                  key={row.id}
                  row={row}
                  level={level}
                  hasChildren={node.children.length > 0}
                  open={hasResultFilter || expanded.has(row.id)}
                  filtering={hasResultFilter}
                  displayName={level === 1 ? chapterTitles.get(row.chapter) ?? row.label : row.label}
                  href={`${base}${row.chapter}.html${row.anchor ? `#${row.anchor}` : ""}`}
                  verification={verificationBases?.[row.static.verification]}
                  onToggle={toggle}
                />
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-900">
            <div>No API rows match these filters.</div>
            <button type="button" onClick={resetFilters} className="mt-3 rounded-md border border-gray-alpha-500 px-3 py-1.5 font-medium text-gray-1000">Reset filters</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
