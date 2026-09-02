"use client";
// Filter state is disposable developer UI state. Remount on Fast Refresh so
// an old search/status selection cannot make a newly generated ledger appear
// empty after an edit.
// @refresh reset

import { useEffect, useMemo, useState } from "react";
import compatibilityMeta from "@/generated/node-v24-compatibility-meta.json";

type Status =
  | "supported"
  | "partial"
  | "refused"
  | "not-implemented"
  | "by-design"
  | "unreviewed"
  | "not-applicable";
type VerificationBasis =
  | "test-backed"
  | "explicit-refusal"
  | "verified-absence"
  | "declared-gap"
  | "registry-gap"
  | "architectural-policy"
  | "unreviewed"
  | "not-applicable"
  | "derived";
type Verification = { label: string; detail: string };
type Tier = { status: Status; detail: string; verification: VerificationBasis };
type NodeStability = { index: string; level: number; text: string; inherited: boolean } | null;
type Row = {
  id: string;
  chapter: string;
  kind: string;
  name: string;
  signature: string;
  label: string;
  apiSymbol: string;
  depth: number;
  scope: "api" | "documentation" | "metadata" | "configuration";
  anchor: string;
  nodeStability: NodeStability;
  static: Tier;
  dynamic: Tier;
};
type Chapter = { slug: string; title: string; entries: number; apiEntries: number };
type Snapshot = { nodeVersion: string; verificationBases: Record<VerificationBasis, Verification>; chapters: Chapter[]; rows: Row[] };
type TreeNode = { row: Row; children: TreeNode[] };
type VisibleNode = { node: TreeNode; level: number };

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

const statuses = ["supported", "partial", "not-implemented", "refused", "by-design", "unreviewed", "not-applicable"] as const;
const stabilityStyles: Record<number, string> = {
  0: "border-red-500/40 bg-red-100 text-red-900 dark:bg-red-200",
  1: "border-amber-500/50 bg-amber-100 text-amber-900 dark:bg-amber-200",
  2: "border-green-500/40 bg-green-100 text-green-900 dark:bg-green-200",
  3: "border-gray-alpha-500 bg-gray-alpha-100 text-gray-900",
};

function StatusBadge({ status, detail, verification }: { status: Status; detail?: string; verification?: Verification }) {
  const tooltip = verification ? `${detail ?? ""}${detail ? "\n\n" : ""}Verification: ${verification.label}. ${verification.detail}` : detail;
  return (
    <span className="group relative inline-flex" tabIndex={tooltip ? 0 : undefined}>
      <span
        className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${styles[status]}`}
        title={tooltip}
      >
        {labels[status]}
      </span>
      {tooltip ? (
        <span role="tooltip" className="pointer-events-none invisible absolute left-0 top-full z-30 mt-2 w-64 rounded-md border border-gray-alpha-500 bg-background-100 p-2 text-left text-xs font-normal leading-5 text-gray-1000 opacity-0 shadow-popover transition-opacity group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100">
          {detail ? <span className="block">{detail}</span> : null}
          {verification ? <span className={detail ? "mt-2 block border-t border-gray-alpha-400 pt-2" : "block"}><strong>Verification:</strong> {verification.label}. {verification.detail}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

function StabilityBadge({ stability }: { stability: NodeStability }) {
  if (stability === null) return <span className="text-xs text-gray-700" title="Node.js does not publish a stability index for this entry.">—</span>;
  const detail = `Node.js Stability ${stability.index}: ${stability.text}${stability.inherited ? " (inherited from the nearest parent section)" : ""}`;
  return (
    <span className="group relative inline-flex" tabIndex={0}>
      <span className={`inline-flex min-w-7 justify-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${stabilityStyles[stability.level] ?? stabilityStyles[3]}`} title={detail}>
        {stability.index}
      </span>
      <span role="tooltip" className="pointer-events-none invisible absolute left-1/2 top-full z-30 mt-2 w-72 -translate-x-1/2 rounded-md border border-gray-alpha-500 bg-background-100 p-2 text-left text-xs font-normal leading-5 text-gray-1000 opacity-0 shadow-popover transition-opacity group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100">
        {detail}
      </span>
    </span>
  );
}

function statusCounts(rows: Row[], tier: "static" | "dynamic") {
  return rows.reduce<Record<Status, number>>(
    (counts, row) => {
      if (row.scope !== "api" || row.depth === 0) return counts;
      counts[row[tier].status] += 1;
      return counts;
    },
    {
      supported: 0,
      partial: 0,
      refused: 0,
      "not-implemented": 0,
      "by-design": 0,
      unreviewed: 0,
      "not-applicable": 0,
    },
  );
}

/** Node's all.json is preorder with an explicit heading depth. */
function buildTree(rows: Row[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const stack: TreeNode[] = [];
  for (const row of rows) {
    const node: TreeNode = { row, children: [] };
    while (stack.length > row.depth) stack.pop();
    const parent = stack[row.depth - 1];
    if (row.depth === 0 || parent === undefined) roots.push(node);
    else parent.children.push(node);
    stack[row.depth] = node;
    stack.length = row.depth + 1;
  }
  return roots;
}

function filterTree(nodes: TreeNode[], matches: (row: Row) => boolean): TreeNode[] {
  const filtered: TreeNode[] = [];
  for (const node of nodes) {
    const children = filterTree(node.children, matches);
    if (matches(node.row) || children.length > 0) filtered.push({ row: node.row, children });
  }
  return filtered;
}

function flattenTree(nodes: TreeNode[], expanded: Set<string>, forceExpanded: boolean): VisibleNode[] {
  const visible: VisibleNode[] = [];
  const visit = (items: TreeNode[], level: number) => {
    for (const node of items) {
      visible.push({ node, level });
      if (node.children.length > 0 && (forceExpanded || expanded.has(node.row.id))) {
        visit(node.children, level + 1);
      }
    }
  };
  visit(nodes, 1);
  return visible;
}

function nodeCount(nodes: TreeNode[]): number {
  return nodes.reduce((count, node) => count + 1 + nodeCount(node.children), 0);
}

function expandableIds(nodes: TreeNode[]): Set<string> {
  const ids = new Set<string>();
  const visit = (items: TreeNode[]) => {
    for (const node of items) {
      if (node.children.length > 0) ids.add(node.row.id);
      visit(node.children);
    }
  };
  visit(nodes);
  return ids;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 3 5 5-5 5" />
    </svg>
  );
}

export function NodeCompatibilityMatrix() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");
  const [staticFilter, setStaticFilter] = useState<"all" | Status>("all");
  const [dynamicFilter, setDynamicFilter] = useState<"all" | Status>("all");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const rows = snapshot?.rows ?? [];
  const chapters = snapshot?.chapters ?? [];
  const verificationBases = snapshot?.verificationBases;
  const apiRowCount = useMemo(() => rows.filter((row) => row.scope === "api").length, [rows]);
  const chapterTitles = useMemo(() => new Map(chapters.map((item) => [item.slug, item.title])), [chapters]);
  const base = `https://nodejs.org/docs/v${snapshot?.nodeVersion ?? "24.15.0"}/api/`;
  const staticCounts = useMemo(() => statusCounts(rows, "static"), [rows]);
  const dynamicCounts = useMemo(() => statusCounts(rows, "dynamic"), [rows]);
  const visibleStatuses = useMemo(() => statuses.filter((status) => staticCounts[status] > 0 || dynamicCounts[status] > 0), [dynamicCounts, staticCounts]);
  const tree = useMemo(() => buildTree(rows), [rows]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/compatibility/data?v=${compatibilityMeta.artifactVersion}`, { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`compatibility data: ${response.status}`);
        return response.json() as Promise<Snapshot>;
      })
      .then((data) => {
        if (!Array.isArray(data.rows) || data.rows.length !== compatibilityMeta.rowCount) {
          throw new Error(`compatibility data is stale or malformed (expected ${compatibilityMeta.rowCount} rows)`);
        }
        setSnapshot(data);
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") setLoadError(true);
      });
    return () => controller.abort();
  }, []);

  const needle = query.trim().toLocaleLowerCase();
  const hasResultFilter = needle !== "" || staticFilter !== "all" || dynamicFilter !== "all";
  const rowMatches = (row: Row) => {
    if (staticFilter !== "all" && row.static.status !== staticFilter) return false;
    if (dynamicFilter !== "all" && row.dynamic.status !== dynamicFilter) return false;
    if (!needle) return true;
    return [chapterTitles.get(row.chapter), row.kind, row.name, row.signature, row.apiSymbol, row.static.detail, row.dynamic.detail]
      .join(" ")
      .toLocaleLowerCase()
      .includes(needle);
  };

  const resultTree = useMemo(
    () => hasResultFilter ? filterTree(tree, rowMatches) : tree,
    // rowMatches closes over these filter values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dynamicFilter, hasResultFilter, needle, staticFilter, tree],
  );
  const visible = useMemo(
    () => flattenTree(resultTree, expanded, hasResultFilter),
    [expanded, hasResultFilter, resultTree],
  );
  const matchedCount = useMemo(
    () => hasResultFilter ? tree.reduce((count, node) => {
      const visit = (item: TreeNode): number => (rowMatches(item.row) ? 1 : 0) + item.children.reduce((sum, child) => sum + visit(child), 0);
      return count + visit(node);
    }, 0) : nodeCount(tree),
    // rowMatches closes over these filter values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dynamicFilter, hasResultFilter, needle, staticFilter, tree],
  );

  const changeQuery = (value: string) => setQuery(value);
  const resetFilters = () => {
    setQuery("");
    setStaticFilter("all");
    setDynamicFilter("all");
    setExpanded(new Set());
  };
  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  useEffect(() => {
    if (!snapshot) return;
    if (staticFilter !== "all" && staticCounts[staticFilter] === 0) setStaticFilter("all");
    if (dynamicFilter !== "all" && dynamicCounts[dynamicFilter] === 0) setDynamicFilter("all");
  }, [dynamicCounts, dynamicFilter, snapshot, staticCounts, staticFilter]);

  if (loadError) {
    return <div className="flex h-full items-center justify-center p-6"><div className="rounded-xl border border-red-500/40 bg-red-100 p-4 text-sm text-red-900">The compatibility dataset could not be loaded.</div></div>;
  }
  if (!snapshot) {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-gray-900">Loading {compatibilityMeta.rowCount.toLocaleString()} Node.js API rows…</div>;
  }

  return (
    <section aria-labelledby="compatibility-title" className="flex h-full min-h-0 flex-col bg-background-100">
      <div className="shrink-0 border-b border-gray-alpha-400 bg-background-200 px-3 py-3 md:px-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <div className="min-w-fit">
            <h1 id="compatibility-title" className="text-lg font-semibold leading-6 text-gray-1000">Node.js 24 Compatibility</h1>
            <p className="text-xs text-gray-800">Static native and dynamic island · Node {snapshot.nodeVersion}</p>
          </div>
          <div className="grid min-w-0 flex-1 gap-2 md:grid-cols-[minmax(240px,1fr)_auto_auto]">
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
        <label className="flex items-center gap-2 text-xs text-gray-900">
          <span>Dynamic</span>
          <select value={dynamicFilter} onChange={(event) => setDynamicFilter(event.target.value as "all" | Status)} className="h-9 rounded-md border border-gray-alpha-500 bg-background-100 px-2 text-xs text-gray-1000">
            <option value="all">All</option>
            {statuses.filter((status) => dynamicCounts[status] > 0).map((status) => <option key={status} value={status}>{labels[status]} ({dynamicCounts[status]})</option>)}
          </select>
        </label>
          </div>
          <div className="flex shrink-0 items-center gap-3 text-xs text-gray-900">
            <span aria-live="polite">{visible.length.toLocaleString()} visible · {matchedCount.toLocaleString()} {hasResultFilter ? "matching" : "API"} rows</span>
            {!hasResultFilter ? (
              <span className="flex gap-1">
                <button type="button" onClick={() => setExpanded(expandableIds(tree))} className="rounded px-1.5 py-1 text-gray-900 hover:bg-gray-alpha-100 hover:text-gray-1000">Expand all</button>
                <button type="button" onClick={() => setExpanded(new Set())} className="rounded px-1.5 py-1 text-gray-900 hover:bg-gray-alpha-100 hover:text-gray-1000">Collapse all</button>
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
            <tr><th className="w-[40%]">Node.js API hierarchy</th><th className="w-[10%] text-center">Node stability</th><th className="w-[25%]">Static native</th><th className="w-[25%]">Dynamic island</th></tr>
          </thead>
          <tbody>
            {visible.map(({ node, level }) => {
              const row = node.row;
              const hasChildren = node.children.length > 0;
              const open = hasResultFilter || expanded.has(row.id);
              const href = `${base}${row.chapter}.html${row.anchor ? `#${row.anchor}` : ""}`;
              const isRoot = level === 1;
              const displayName = isRoot ? chapterTitles.get(row.chapter) ?? row.label : row.label;
              return (
                <tr key={row.id} aria-level={level} aria-expanded={hasChildren ? open : undefined} className={`align-top hover:bg-gray-alpha-100/60 ${isRoot ? "bg-background-200/60" : ""}`}>
                  <td>
                    <div className="flex items-start gap-1.5" style={{ paddingLeft: `${(level - 1) * 18}px` }}>
                      {hasChildren ? (
                        <button type="button" onClick={() => toggle(row.id)} disabled={hasResultFilter} aria-label={`${open ? "Collapse" : "Expand"} ${displayName}`} className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-800 hover:bg-gray-alpha-200 hover:text-gray-1000 disabled:cursor-default disabled:hover:bg-transparent">
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
                  <td><StatusBadge status={row.static.status} detail={row.static.detail} verification={verificationBases?.[row.static.verification]} /></td>
                  <td><StatusBadge status={row.dynamic.status} detail={row.dynamic.detail} verification={verificationBases?.[row.dynamic.verification]} /></td>
                </tr>
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
