// for-of over an array of subclass instances passes each element to
// base-class parameters, compares it, and keeps explicit undefined
// elements observable in the loop body.

class Node2 {
  kind: number;
  constructor(kind: number) {
    this.kind = kind;
  }
}

class Leaf extends Node2 {
  note: string | undefined = undefined;
}

function kindOf(n: Node2): number {
  return n.kind;
}

function isNode(n: Node2 | undefined): boolean {
  return n !== undefined;
}

const leaves: Leaf[] = [new Leaf(1), new Leaf(2), new Leaf(4)];
let total = 0;
for (const leaf of leaves) total += kindOf(leaf);
console.log(total);
for (const leaf of leaves) console.log(isNode(leaf), leaf instanceof Node2);

const withGaps: (Leaf | undefined)[] = [new Leaf(5), undefined, new Leaf(6)];
for (const leaf of withGaps) console.log(isNode(leaf), leaf === undefined ? -1 : kindOf(leaf));

const sparse: Leaf[] = [new Leaf(7)];
sparse[2] = new Leaf(8);
for (const leaf of sparse) console.log(leaf === undefined, leaf?.kind);
