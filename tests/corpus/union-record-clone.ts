type Tree =
  | { kind: "leaf"; label: string; value: number; children: Tree[]; note?: string }
  | { kind: "branch"; label: string; children: Tree[]; weight: number; note?: string };
const events: string[] = [];
function label(text: string): string { events.push(text); return text; }
function copy(tree: Tree): Tree {
  return { ...tree, label: label("copy:" + tree.label), note: label("note") };
}
const leaf: Tree = { kind: "leaf", label: "original", value: 3, children: [] };
const branch: Tree = { kind: "branch", label: "parent", children: [leaf], weight: 4, note: "old" };
for (const tree of [leaf, branch]) {
  const copied = copy(tree);
  console.log(copied.kind, copied.label, copied.note, copied.children === tree.children, copied === tree);
  console.log(copied.kind === "leaf" ? copied.value : copied.weight);
  if (copied.kind === "leaf") console.log("keys", Object.keys(copied).sort().join(","));
  else console.log("keys", Object.keys(copied).sort().join(","));
}
console.log("events", events.join(","));
events.length = 0;

// Copy fields before evaluating later overrides; the clone is fresh and
// keeps the original nested reference even when an override mutates it.
function mutate(tree: Tree): string {
  tree.children = [];
  tree.label = "mutated";
  events.push("mutate");
  return "override";
}
function snapshot(tree: Tree): Tree {
  return { ...tree, note: mutate(tree) };
}
const children = branch.children;
const snapshotCopy = snapshot(branch);
console.log("snapshot", snapshotCopy.label, snapshotCopy.note, snapshotCopy.children === children, branch.children === children);

let reads = 0;
function source(flag: boolean): Tree { reads++; return flag ? leaf : branch; }
function singleEvaluation(flag: boolean): Tree { return { ...source(flag), label: label("once") }; }
console.log("source", singleEvaluation(true).kind, singleEvaluation(false).kind, reads);

function fail(): string { events.push("fail"); throw new RangeError("clone"); }
function throwing(tree: Tree): Tree { return { ...tree, label: fail(), note: label("untaken") }; }
try { throwing(branch); }
catch (error) { if (error instanceof RangeError) console.log("caught", error.name, error.message); }
console.log("recover", copy(leaf).kind, events.join(","));

// A field read proves a hidden optional array element is present. Both
// if and switch bodies can copy the checked record variant.
function guarded(input: Tree[], index: number): Tree {
  const item = input[index];
  if (item.kind === "leaf") return { ...item, label: "leaf-copy" };
  return { ...item, label: "branch-copy" };
}
function switched(input: Tree[], index: number): Tree {
  const item = input[index];
  switch (item.kind) {
    case "leaf": return { ...item, label: "switch-leaf" };
    case "branch": return { ...item, label: "switch-branch" };
  }
}
console.log("guards", guarded([leaf, branch], 0).label, guarded([leaf, branch], 1).label);
console.log("switch", switched([leaf, branch], 0).label, switched([leaf, branch], 1).label);
try { switched([], 0); }
catch (error) { if (error instanceof TypeError) console.log("missing", error.name); }

function lookup(input: Tree[], index: number): Tree | null {
  const tree = input[index];
  if (!tree) return null;
  return { ...tree, label: "lookup" };
}
console.log("lookup", lookup([leaf], 0)?.label, lookup([], 0) === null);

// A replacement record keeps its own identity when its discriminator
// selects the exact nested union arm, even if smaller layouts also fit.
type Receiver = { kind: "ref"; id: number } | { kind: "self" };
type Read =
  | { kind: "field"; obj: Receiver; field: string }
  | { kind: "slot"; obj: Receiver; slot: number };
function replaceLiteral(read: Read): Read {
  return { ...read, obj: { kind: "ref", id: 7 } };
}
function replaceExisting(read: Read, obj: { kind: "ref"; id: number }): Read {
  return { ...read, obj };
}
const receiver: { kind: "ref"; id: number } = { kind: "ref", id: 3 };
const readCases: Read[] = [
  { kind: "field", obj: receiver, field: "value" },
  { kind: "slot", obj: receiver, slot: 2 },
];
for (const read of readCases) {
  const literal = replaceLiteral(read);
  const existing = replaceExisting(read, receiver);
  console.log("receiver", literal.kind, literal.obj.kind, literal.obj.kind === "ref" ? literal.obj.id : -1);
  console.log("alias", existing.obj === receiver, existing.obj.kind, existing.kind === "field" ? existing.field : existing.slot);
}
