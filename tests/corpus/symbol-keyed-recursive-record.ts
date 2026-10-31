// A recursive record keyed by unique symbols, built from literals whose
// child arrays start empty, holds the nodes later pushed into those arrays.

const kValue: unique symbol = Symbol("value");
const kChildren: unique symbol = Symbol("children");

interface TreeNode {
  [kChildren]: TreeNode[];
  [kValue]: number;
}

function node(value: number): TreeNode {
  return { [kValue]: value, [kChildren]: [] };
}

const root = node(0);
root[kChildren].push(node(1));
root[kChildren].push(node(2));
root[kChildren][0]![kChildren].push(node(3));
console.log(root[kChildren].length, root[kChildren][0]![kValue], root[kChildren][1]![kValue]);

function sum(n: TreeNode): number {
  let total = n[kValue];
  for (const child of n[kChildren]) total += sum(child);
  return total;
}
function depth(n: TreeNode): number {
  return 1 + Math.max(0, ...n[kChildren].map(depth));
}
console.log(sum(root), depth(root));

// A literal that starts with children.
const seeded: TreeNode = { [kValue]: 10, [kChildren]: [node(11)] };
seeded[kChildren].push(node(12));
console.log(seeded[kChildren].map((c) => c[kValue]).join(","), sum(seeded));
