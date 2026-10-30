// Views of records whose other fields hold strings, arrays and records: every view and every record is released exactly once, whichever
// name drops the last reference (the sanitized lane checks for leaks).
type Node = { id: number; label: string; children: Node[]; meta: { tag: string }; seen: { key: string; count: number }[] };
type Head = { id: number; meta: { tag: string } };
type Tail = { children: Node[]; label: string };

function make(id: number): Node {
  return { id, label: "n" + id, children: [], meta: { tag: "t" + id }, seen: [{ key: "k", count: id }] };
}
function asHead(value: unknown): Head {
  return value as Head;
}
function asTail(value: unknown): Tail {
  return value as Tail;
}

let total = 0;
for (let round = 0; round < 200; round++) {
  const node = make(round);
  node.children.push(make(round + 1000));
  const head = asHead(node);
  const tail = asTail(node);
  head.meta = { tag: "h" + round };
  tail.label = tail.label + "!";
  tail.children.push(make(round + 2000));
  total += head.id + tail.children.length + node.seen[0]!.count;
  if (round === 199) console.log(JSON.stringify(head), node.label, node.meta.tag, tail.children.length);
}
console.log(total);

// The last reference is the view's.
let kept: Head | undefined;
for (let round = 0; round < 100; round++) kept = asHead(make(round));
if (kept) console.log(kept.id, kept.meta.tag, JSON.stringify(kept));
kept = undefined;

// The last reference is the record's.
const records: Node[] = [];
for (let round = 0; round < 100; round++) {
  const node = make(round);
  asTail(node).label = "v" + round;
  records.push(node);
}
console.log(records.map((node) => node.label).slice(0, 3).join(","), records.length);
