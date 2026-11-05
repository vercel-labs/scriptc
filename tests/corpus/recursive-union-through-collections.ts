// Unions that reach themselves through collections alone: an array of Sets
// of the union, a Map whose values hold Sets of it, and a Map whose values
// are the union. The first two hold themselves as Set elements with no
// record in between, so they stay checked-dynamic; the third is static.
// All three run as Node runs them.
type Nested = string | Set<Nested>[];
type Grouped = number | Map<string, Set<Grouped>>;
type Tree = string | Map<string, Tree>;

const nested: Nested = [new Set<Nested>(["x", [new Set<Nested>(["y"])]])];
const grouped: Grouped = new Map<string, Set<Grouped>>([["k", new Set<Grouped>([1, 2])]]);
const tree: Tree = new Map<string, Tree>([
  ["leaf", "value"],
  ["branch", new Map<string, Tree>([["inner", "deep"]])],
]);

function depth(t: Tree): number {
  if (typeof t === "string") return 0;
  let most = 0;
  for (const child of t.values()) most = Math.max(most, depth(child));
  return most + 1;
}

console.log(typeof nested === "string" ? nested : nested.length);
console.log(typeof grouped === "number" ? grouped : grouped.get("k")?.size);
console.log(depth(tree), tree instanceof Map ? [...tree.keys()].join(",") : tree);
