// The compatibility matrix's data model: the ledger rows as a tree, and the
// search and filter passes over it. Kept free of React so the passes can be
// tested directly.

export type Status =
  | "supported"
  | "partial"
  | "refused"
  | "not-implemented"
  | "by-design"
  | "unreviewed"
  | "not-applicable";
export type VerificationBasis =
  | "test-backed"
  | "explicit-refusal"
  | "verified-absence"
  | "declared-gap"
  | "registry-gap"
  | "architectural-policy"
  | "unreviewed"
  | "not-applicable"
  | "derived";
export type Verification = { label: string; detail: string };
export type Tier = { status: Status; detail: string; verification: VerificationBasis };
export type NodeStability = { index: string; level: number; text: string; inherited: boolean } | null;
export type Row = {
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
};
export type Chapter = { slug: string; title: string; entries: number; apiEntries: number };
export type Snapshot = {
  nodeVersion: string;
  verificationBases: Record<VerificationBasis, Verification>;
  chapters: Chapter[];
  rows: Row[];
};
export type TreeNode = { row: Row; children: TreeNode[] };
export type VisibleNode = { node: TreeNode; level: number };

export const statuses = ["supported", "partial", "not-implemented", "refused", "by-design", "unreviewed", "not-applicable"] as const;

export function statusCounts(rows: Row[]): Record<Status, number> {
  return rows.reduce<Record<Status, number>>(
    (counts, row) => {
      if (row.scope !== "api" || row.depth === 0) return counts;
      counts[row.static.status] += 1;
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
export function buildTree(rows: Row[]): TreeNode[] {
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

/** The lowercase text a search matches against, built once per row: the
 * chapter title, kind, name, signature, API symbol and support detail. */
export function searchTexts(rows: Row[], chapterTitles: ReadonlyMap<string, string>): Map<string, string> {
  return new Map(
    rows.map((row) => [
      row.id,
      [chapterTitles.get(row.chapter), row.kind, row.name, row.signature, row.apiSymbol, row.static.detail]
        .join(" ")
        .toLocaleLowerCase(),
    ]),
  );
}

/** The rows a status filter and a lowercase search needle keep. */
export function rowMatcher(
  texts: ReadonlyMap<string, string>,
  needle: string,
  status: "all" | Status,
): (row: Row) => boolean {
  return (row) => {
    if (status !== "all" && row.static.status !== status) return false;
    return needle === "" || (texts.get(row.id) ?? "").includes(needle);
  };
}

/** The matching rows with their ancestors, and the number of matching
 * rows, in one pass. */
export function filterTree(nodes: TreeNode[], matches: (row: Row) => boolean): { nodes: TreeNode[]; matched: number } {
  let matched = 0;
  const visit = (items: TreeNode[]): TreeNode[] => {
    const filtered: TreeNode[] = [];
    for (const node of items) {
      const children = visit(node.children);
      const own = matches(node.row);
      if (own) matched += 1;
      if (own || children.length > 0) filtered.push({ row: node.row, children });
    }
    return filtered;
  };
  return { nodes: visit(nodes), matched };
}

export function flattenTree(nodes: TreeNode[], expanded: ReadonlySet<string>, forceExpanded: boolean): VisibleNode[] {
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

export function nodeCount(nodes: TreeNode[]): number {
  return nodes.reduce((count, node) => count + 1 + nodeCount(node.children), 0);
}

export function expandableIds(nodes: TreeNode[]): Set<string> {
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
