// Callbacks that reach a walker through a signature adapter (the walker's
// callback takes more parameters and returns a verdict), some reading
// `this` and some not. A plain call leaves `this` undefined; an arrow keeps
// its enclosing `this`.
class Tree {
  readonly kind: number;
  readonly kids: Tree[] = [];
  constructor(kind: number) {
    this.kind = kind;
  }
}

function walk(root: Tree, visit: (node: Tree, depth: number) => void | "skip" | "stop"): number {
  const stack: [Tree, number][] = [[root, 0]];
  let visited = 0;
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    visited++;
    const verdict = visit(node, depth);
    if (verdict === "stop") break;
    if (verdict === "skip") continue;
    for (let i = node.kids.length - 1; i >= 0; i--) stack.push([node.kids[i]!, depth + 1]);
  }
  return visited;
}

const root = new Tree(0);
for (let i = 1; i <= 4; i++) {
  const kid = new Tree(i);
  for (let j = 0; j < 3; j++) kid.kids.push(new Tree(i * 10 + j));
  root.kids.push(kid);
}

const out: string[] = [];

// An arrow that ignores the receiver and one that captures its class's.
class Counter {
  count = 0;
  label = "counter";
  run(): string {
    walk(root, (node) => {
      if (node.kind % 2 === 0) this.count++;
    });
    const labels: string[] = [];
    walk(root, (node) => {
      if (node.kind === 2) return "skip";
      labels.push(`${this.label}:${node.kind}`);
      return undefined;
    });
    return `${this.count} ${labels.length}`;
  }
}
out.push(new Counter().run());

// Function expressions that read `this`: a plain call binds undefined.
const receivers: string[] = [];
walk(root, function (this: unknown, node: Tree) {
  if (node.kind < 2) receivers.push(this === undefined ? "undefined" : typeof this);
});
out.push(receivers.join(","));

// An unbound method: its `this` is undefined when the walker calls it.
const holder = {
  name: "holder",
  visit(this: { name: string } | undefined, node: Tree): void {
    if (node.kind === 1) out.push(this === undefined ? "unbound" : this.name);
  },
};
walk(root, holder.visit);
// A bound method keeps its receiver.
walk(root, holder.visit.bind(holder));

// Receiver-free bodies with optional chains, record presence and array loops.
type Info = { name?: string; tags: string[] };
const infos = new Map<number, Info>([
  [1, { name: "one", tags: ["a", "b"] }],
  [3, { tags: [] }],
]);
const described: string[] = [];
walk(root, (node) => {
  const info = infos.get(node.kind);
  let tags = 0;
  for (const tag of info?.tags ?? []) tags += tag.length;
  if (info !== undefined) described.push(`${info.name?.toUpperCase() ?? "anonymous"}/${"name" in info}/${tags}`);
  return node.kind === 3 ? "stop" : undefined;
});
out.push(described.join(" "));

// Walkers with one callback each, which their calls enter directly: one
// reads `this`, the other ignores it.
function eachKid(node: Tree, visit: (kid: Tree, index: number) => boolean | void): number {
  let calls = 0;
  for (let i = 0; i < node.kids.length; i++) {
    calls++;
    if (visit(node.kids[i]!, i) === false) break;
  }
  return calls;
}
const kidReceivers: string[] = [];
eachKid(root, function (this: unknown, kid: Tree) {
  kidReceivers.push(`${kid.kind}:${this === undefined ? "undefined" : typeof this}`);
});
out.push(kidReceivers.join(","));
function sumKinds(node: Tree, add: (kind: number, depth: number) => number | void): number {
  let total = 0;
  for (const kid of node.kids) total += add(kid.kind, 1) ?? 0;
  return total;
}
let added = 0;
out.push(String(sumKinds(root.kids[2]!, (kind) => (added += kind))), String(added));

console.log(out.join("\n"));
