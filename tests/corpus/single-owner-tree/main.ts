// `class C implements SingleOwner` (@scriptc/experimental): a marker whose
// instances scriptc gives one owner each, so they carry no reference count
// and are freed, with everything below them, when their owner lets go.
// Both trees are built, summed with a const alias of each link read (a
// borrow) and dropped in a loop; the second types its links with
// `undefined` rather than `null`, which is the same absent value. Under
// Node.js the marker is a type and is erased, so the output is the same.
// Every tree lives in a local of one function: a field of another class, an
// array element or a module binding would be a second owner.
import type { SingleOwner } from "@scriptc/experimental";

class TreeNode implements SingleOwner {
  readonly left: TreeNode | null;
  readonly right: TreeNode | null;
  readonly weight: number;
  constructor(left: TreeNode | null, right: TreeNode | null, weight: number) {
    this.left = left;
    this.right = right;
    this.weight = weight;
  }
}

class Twig implements SingleOwner {
  readonly left: Twig | undefined;
  readonly right: Twig | undefined;
  readonly weight: number;
  constructor(left: Twig | undefined, right: Twig | undefined, weight: number) {
    this.left = left;
    this.right = right;
    this.weight = weight;
  }
}

function build(depth: number, weight: number): TreeNode | null {
  if (depth === 0) return null;
  return new TreeNode(build(depth - 1, weight), build(depth - 1, weight + 1), weight);
}

function buildTwig(depth: number): Twig | undefined {
  if (depth === 0) return undefined;
  return new Twig(buildTwig(depth - 1), buildTwig(depth - 1), depth);
}

function total(node: TreeNode | null): number {
  if (node === null) return 0;
  const left = node.left;
  const right = node.right;
  return node.weight + total(left) + total(right);
}

function totalTwig(twig: Twig | undefined): number {
  if (twig === undefined) return 0;
  const left = twig.left;
  return twig.weight + totalTwig(left) + totalTwig(twig.right);
}

function leftOf(twig: Twig): number {
  const left = twig.left;
  return totalTwig(left);
}

function count(node: TreeNode | null): number {
  if (node === null) return 0;
  const left = node.left;
  return 1 + count(left) + count(node.right);
}

function main(): void {
  let sum = 0;
  for (let i = 0; i < 6; i++) {
    const tree = build(10, 1);
    sum += total(tree);
    if (i === 0) console.log("nodes", count(tree));
  }
  console.log("tree sum", sum);

  const twig = buildTwig(9);
  console.log("twig sum", totalTwig(twig));
  if (twig !== undefined) console.log("twig left", leftOf(twig));
}

main();
