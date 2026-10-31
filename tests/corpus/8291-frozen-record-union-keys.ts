// Frozen records in record-only unions used as Set elements and Map keys:
// the union's release frees a frozen record when it drops the last
// reference, for unions the cycle collector traces and ones it does not.
type Leaf = { kind: "leaf"; label: string };
type Pair = { kind: "pair"; left: Node; right: Node };
type Node = Leaf | Pair;

type Name = { kind: "name"; text: string };
type Count = { kind: "count"; value: number; unit: string };
type Key = Name | Count;

function leaf(label: string): Node {
  const built: Leaf = { kind: "leaf", label };
  return Object.freeze(built);
}

function pair(left: Node, right: Node): Node {
  const built: Pair = { kind: "pair", left, right };
  return Object.freeze(built);
}

function key(i: number): Key {
  if (i % 2 === 0) {
    const name: Name = { kind: "name", text: "n" + i };
    return Object.freeze(name);
  }
  const count: Count = { kind: "count", value: i, unit: "u" + i };
  return Object.freeze(count);
}

function nodes(n: number): number {
  const seen = new Set<Node>();
  const weight = new Map<Node, number>();
  let last = leaf("start");
  for (let i = 0; i < n; i++) {
    const next = i % 3 === 0 ? leaf("l" + i) : pair(last, leaf("r" + i));
    seen.add(next);
    weight.set(next, i);
    last = next;
  }
  let total = 0;
  for (const node of seen) total += (weight.get(node) ?? 0) + (node.kind === "pair" ? 1 : 0);
  seen.clear();
  weight.clear();
  return total + (last.kind === "pair" ? 1 : 0);
}

function keys(n: number): number {
  const seen = new Set<Key>();
  const size = new Map<Key, number>();
  for (let i = 0; i < n; i++) {
    const k = key(i);
    seen.add(k);
    size.set(k, k.kind === "name" ? k.text.length : k.value);
  }
  let total = 0;
  for (const k of seen) total += size.get(k) ?? 0;
  seen.clear();
  size.clear();
  return total;
}

let sum = 0;
for (let r = 0; r < 50; r++) sum += nodes(40) + keys(40);
console.log(sum);
