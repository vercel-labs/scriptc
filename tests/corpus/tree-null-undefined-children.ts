// A tree class whose children are `C | null | undefined`. In that union
// `undefined` is NULL and `null` is the module's immortal sentinel, so the
// teardown has to skip both instead of treating the sentinel as a node (it
// has no count word to notice, and freeing it tears down a module global).
// The string-holding chain keeps the group open, so the trees keep the heap
// path and their walking teardown rather than the arena's drop, and both the
// two-child loop and the one-child loop are pinned.
class Node {
  readonly left: Node | null | undefined;
  readonly right: Node | null | undefined;
  readonly value: number;
  constructor(left: Node | null | undefined, right: Node | null | undefined, value: number) {
    this.left = left;
    this.right = right;
    this.value = value;
  }
}

class Link {
  readonly next: Link | null | undefined;
  readonly value: number;
  constructor(next: Link | null | undefined, value: number) {
    this.next = next;
    this.value = value;
  }
}

function buildNull(depth: number): Node {
  if (depth === 0) return new Node(null, null, 1);
  const left = buildNull(depth - 1);
  const right = buildNull(depth - 1);
  return new Node(left, right, 1);
}

function buildUndefined(depth: number): Node {
  if (depth === 0) return new Node(undefined, undefined, 1);
  const left = buildUndefined(depth - 1);
  const right = buildUndefined(depth - 1);
  return new Node(left, right, 1);
}

function linkNull(count: number): Link {
  if (count === 0) return new Link(null, 1);
  const tail = linkNull(count - 1);
  return new Link(tail, 1);
}

function linkUndefined(count: number): Link {
  if (count === 0) return new Link(undefined, 1);
  const tail = linkUndefined(count - 1);
  return new Link(tail, 1);
}

function nodes(node: Node | null | undefined): number {
  if (node === null || node === undefined) return 0;
  return node.value + nodes(node.left) + nodes(node.right);
}

function links(link: Link | null | undefined): number {
  if (link === null || link === undefined) return 0;
  return link.value + links(link.next);
}

interface Item {
  label: string;
  next: Item | null;
}
function chain(labels: string[], n: number): Item {
  if (n === 0) return { label: labels[0]!, next: null };
  return { label: labels[n % labels.length]!, next: chain(labels, n - 1) };
}
function length(item: Item): number {
  if (item.next === null) return item.label.length;
  return item.label.length + length(item.next);
}

const labels = ["a", "bb", "ccc"];
let total = 0;
for (let round = 0; round < 4; round++)
  total +=
    length(chain(labels, 10 + round)) +
    nodes(buildNull(4)) +
    nodes(buildUndefined(4)) +
    links(linkNull(40)) +
    links(linkUndefined(40));
console.log(total);
