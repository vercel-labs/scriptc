// A tagged tree whose leaf holds a value with no static lowering (an
// interface extending Array), so the slots of the tree's type are committed
// through the canonical form. The branch arms lead back to the tree type.
interface JsonList extends Array<Json> {}
interface JsonObject {
  [key: string]: Json;
}
type Json = string | number | boolean | null | JsonList | JsonObject;

interface Base {
  note?: string;
}
interface Pair extends Base {
  kind: "pair";
  items: Tree[];
}
interface Group extends Base {
  kind: "group";
  items: Tree[];
}
interface Leaf extends Base {
  kind: "leaf";
  value: Json;
}
type Tree = Pair | Group | Leaf;

interface Slot {
  tree: Tree;
  name: string;
}

const LEAF: Leaf = { kind: "leaf", value: "x" };
const EMPTY: Slot = { tree: LEAF, name: "empty" };

function depth(tree: Tree): number {
  if (tree.kind === "leaf") return 0;
  let most = 0;
  for (const item of tree.items) most = Math.max(most, depth(item));
  return most + 1;
}

console.log(EMPTY.name, EMPTY.tree.kind, depth(EMPTY.tree));
