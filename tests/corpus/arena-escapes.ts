// Values built in a group that leave it: handed to callbacks that keep
// them, stored by a method into a module list, kept from a getter, pushed
// into a caller's list, or captured by a returned closure. None of those
// groups takes an arena; the one whose values stay in the frame does.
class Node {
  kids: Node[] = [];
  label: string;
  constructor(label: string) {
    this.label = label;
  }
  get first(): Node {
    return this.kids[0]!;
  }
  register(): void {
    registry.push(this);
  }
}
const registry: Node[] = [];
const saved: Node[] = [];
const held = new Map<number, Node>();
function build(depth: number, label: string): Node {
  const n = new Node(label);
  for (let i = 0; depth > 0 && i < 3; i++) n.kids.push(build(depth - 1, `${label}.${i}`));
  return n;
}
function each(depth: number, cb: (n: Node) => void): number {
  const t = build(depth, "e");
  cb(t);
  return t.kids.length;
}
function visit(n: Node, cb: (x: Node) => void): void {
  cb(n);
  for (const k of n.kids) visit(k, cb);
}
function forward(depth: number, cb: (x: Node) => void): number {
  const t = build(depth, "f");
  visit(t, cb);
  return t.kids.length;
}
function buildInto(sink: Node[], depth: number): number {
  const n = build(depth, "s");
  sink.push(n.kids[0]!);
  return n.kids.length;
}
function closureOf(depth: number): () => string {
  const n = build(depth, "c");
  return () => n.kids[1]!.label;
}
let total = 0;
for (let r = 0; r < 8; r++) {
  total += each(2, (n) => saved.push(n.kids[1]!));
  total += forward(2, (x) => {
    if (x.label.endsWith(".2")) saved.push(x);
  });
  const t = build(2, `t${r}`);
  t.kids.forEach((k) => {
    if (k.label.endsWith(".0")) saved.push(k);
  });
  const u = build(2, `u${r}`);
  for (const k of u.kids) if (k.label.endsWith(".1")) saved.push(k);
  const v = build(2, `v${r}`);
  held.set(r, v.first);
  const a = build(2, `a${r}`);
  if (r % 3 === 0) a.kids[0]!.register();
  total += buildInto(saved, 2);
  const w = build(2, `w${r}`);
  total += w.kids.length + w.first.kids.length;
}
console.log(total, saved.length, saved.map((n) => n.label + "/" + n.kids.length).slice(0, 10).join(","));
const f = closureOf(2);
console.log(f(), registry.map((n) => n.label + n.kids.length).join(","));
console.log([...held.values()].map((n) => n.label + n.kids[0]!.label).join(","));
