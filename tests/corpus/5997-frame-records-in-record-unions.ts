// Records that are arms of a union of records and also live in frame
// storage. An arm of such a union carries a hidden shape word before its
// fields, so every field address has to skip it: the reference fields a
// frame record owns are read, overwritten and released through the same
// slots as heap records of the shape. The same shapes also flow through
// the union, are compared by identity and are serialized.
interface Ident {
  kind: "ident";
  name: string;
  tags: string[];
}
interface Call {
  kind: "call";
  callee: string;
  args: Ident[];
}
type Node = Ident | Call;

const words = ["alpha", "beta", "gamma", "delta", "epsilon"];
function word(i: number): string {
  return words[i % words.length]! + i;
}

function describe(node: Node): string {
  switch (node.kind) {
    case "ident":
      return `${node.name}[${node.tags.join(",")}]`;
    case "call":
      return `${node.callee}(${node.args.map((a) => a.name).join(", ")})`;
  }
}
function weight(node: Node): number {
  return node.kind === "ident" ? node.name.length + node.tags.length : node.args.length * 10;
}

// Heap values of the union: the arms are tagged shapes.
const nodes: Node[] = [];
for (let i = 0; i < 6; i++) {
  const id: Ident = { kind: "ident", name: word(i), tags: [word(i + 1)] };
  nodes.push(i % 2 === 0 ? id : { kind: "call", callee: word(i + 2), args: [id, id] });
}
console.log(nodes.map(describe).join(" | "));

// Frame records of the arms that only flow into field reads.
let total = 0;
let log = "";
for (let i = 0; i < 10; i++) {
  const w = word(i);
  const id: Ident = { kind: "ident", name: w + "!", tags: [w, word(i + 3)] };
  total += id.name.length + id.tags.length + id.tags[1]!.length;
  const call: Call = { kind: "call", callee: w.toUpperCase(), args: [] };
  total += call.callee.length + call.args.length;
  log += id.kind[0]! + call.kind[0]! + id.name[0]!;
}
console.log(total, log);

// A reassigned frame binding: each new value is built apart and copied over
// the slot, and the replaced reference fields are released.
let cur: Ident = { kind: "ident", name: word(0), tags: [] };
for (let i = 1; i < 8; i++) {
  cur = { kind: "ident", name: cur.name.slice(0, 3) + word(i), tags: [...cur.tags, cur.name] };
  if (i % 3 === 0) cur = { kind: "ident", name: cur.tags[0] ?? "none", tags: cur.tags.slice(1) };
}
console.log(cur.name, cur.tags.length, cur.tags.join("+"));

// Field writes into a frame record's reference slots.
for (let i = 0; i < 4; i++) {
  const id: Ident = { kind: "ident", name: word(i), tags: [word(i)] };
  id.name = id.name + "/" + i;
  id.tags = [id.name, ...id.tags];
  id.tags.push(word(i + 7));
  console.log(id.name, id.tags.join(" "));
}

// Through the union: describe and weigh by union, keep identity, and
// serialize the arms and the union values.
const a: Ident = { kind: "ident", name: "x", tags: ["t1", "t2"] };
const b: Call = { kind: "call", callee: "f", args: [a] };
const asNode: Node = a;
const picked: Node = weight(b) > weight(a) ? b : a;
console.log(describe(asNode), describe(b), weight(asNode), weight(picked));
console.log(asNode === a, picked === b, b.args[0] === a, (picked as Call).args[0] === asNode);
a.tags.push("t3");
console.log(describe(asNode), describe(picked));
console.log(JSON.stringify(a), JSON.stringify(picked));
console.log(JSON.stringify(nodes.slice(0, 2)));
const mixed: Node[] = [a, b, nodes[1]!];
console.log(mixed.filter((n) => n.kind === "ident").length, mixed.indexOf(asNode), mixed.indexOf(b));
