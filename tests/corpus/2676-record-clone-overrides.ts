// Same-shape immutable record updates lower through one per-shape clone
// helper. Pin source-before-overrides evaluation, refcounted replacement,
// scalar replacement, source immutability, and nested/cyclic ownership.
interface Child {
  label: string;
  parent?: Node;
}

interface Node {
  name: string;
  count: number;
  child: Child;
  tags: string[];
  f0: number;
  f1: number;
  f2: number;
  f3: number;
  f4: number;
  f5: number;
  f6: number;
  f7: number;
  f8: number;
  f9: number;
  f10: number;
  f11: number;
}

const order: string[] = [];

function source(value: Node): Node {
  order.push("source");
  return value;
}

function replacement(name: string): string {
  order.push(name);
  return name;
}

const original: Node = {
  name: "before",
  count: 1,
  child: { label: "kept" },
  tags: ["a", "b"],
  f0: 0,
  f1: 1,
  f2: 2,
  f3: 3,
  f4: 4,
  f5: 5,
  f6: 6,
  f7: 7,
  f8: 8,
  f9: 9,
  f10: 10,
  f11: 11,
};
original.child.parent = original;

const first = {
  ...source(original),
  name: replacement("after"),
  count: original.count + 1,
};
const second = { ...first, child: { label: replacement("new-child") } };

console.log(order.join(","));
console.log(original.name, original.count, original.child.label, original.tags.join(""));
console.log(first.name, first.count, first.child.label, first.tags.join(""));
console.log(second.name, second.count, second.child.label, second.tags.join(""));
