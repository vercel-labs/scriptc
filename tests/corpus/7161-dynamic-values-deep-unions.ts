// Dynamic values cast into recursive discriminated unions: trees built as
// untyped objects, trees that mix typed records into untyped ones, and casts
// of the same values twice.

type Node =
  | { kind: "leaf"; value: number }
  | { kind: "pair"; left: Node; right: Node }
  | { kind: "wrap"; inner: Node; tag: string }
  | { kind: "many"; items: Node[] };

function sum(n: Node): number {
  switch (n.kind) {
    case "leaf":
      return n.value;
    case "pair":
      return sum(n.left) + sum(n.right);
    case "wrap":
      return sum(n.inner) + n.tag.length;
    case "many":
      return n.items.reduce((total, item) => total + sum(item), 0);
  }
}

function height(n: Node): number {
  switch (n.kind) {
    case "leaf":
      return 1;
    case "pair":
      return 1 + Math.max(height(n.left), height(n.right));
    case "wrap":
      return 1 + height(n.inner);
    case "many":
      return 1 + n.items.reduce((max, item) => Math.max(max, height(item)), 0);
  }
}

function untyped(levels: number): any {
  let node: any = { kind: "leaf", value: 1 };
  for (let i = 0; i < levels; i++) {
    node =
      i % 3 === 0
        ? { kind: "wrap", inner: node, tag: "t" }
        : i % 3 === 1
          ? { kind: "pair", left: node, right: { kind: "leaf", value: i } }
          : { kind: "many", items: [node, { kind: "leaf", value: 2 }] };
  }
  return node;
}

for (const levels of [0, 2, 10, 90, 300]) {
  const value: unknown = untyped(levels);
  const node = value as Node;
  console.log("untyped", levels, node.kind, height(node), sum(node));
}

// Typed records inside an untyped tree.
const typedLeaf: Node = { kind: "leaf", value: 7 };
const typedPair: Node = { kind: "pair", left: typedLeaf, right: { kind: "leaf", value: 3 } };
const mixed: any = { kind: "many", items: [typedPair, untyped(20), { kind: "wrap", inner: typedLeaf, tag: "xy" }] };
const fromMixed = mixed as Node;
console.log("mixed", height(fromMixed), sum(fromMixed));

// The same untyped value cast twice gives equal trees.
const again: any = untyped(40);
const first = again as Node;
const second = again as Node;
console.log("twice", sum(first) === sum(second), height(first), height(second));

// A tree that changes between casts.
const changing: any = { kind: "pair", left: { kind: "leaf", value: 1 }, right: untyped(5) };
console.log("before", sum(changing as Node));
changing.left = { kind: "wrap", inner: { kind: "leaf", value: 10 }, tag: "abc" };
console.log("after", sum(changing as Node));
