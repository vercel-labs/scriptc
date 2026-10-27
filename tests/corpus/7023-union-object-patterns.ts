// Object patterns over unions of records and classes read the fields
// every arm declares, in parameters, declarations and loops.
interface Add {
  kind: "add";
  path: string;
  content: string;
  mode?: number;
}
interface Remove {
  kind: "remove";
  path: string;
  mode?: number;
}
type Change = Add | Remove;

function describe({ kind, path: file, mode = 0o644 }: Change): string {
  return `${kind}:${file}:${mode.toString(8)}`;
}
const changes: Change[] = [
  { kind: "add", path: "a.txt", content: "x" },
  { kind: "remove", path: "b.txt", mode: 0o600 },
];
for (const change of changes) console.log(describe(change));
for (const { kind, path } of changes) console.log(kind, path.length);
function applyChange(change: Change): number {
  const { path } = change;
  let { kind } = change;
  if (kind === "add") kind = "remove";
  return path.length + kind.length;
}
console.log(applyChange(changes[0]!), applyChange(changes[1]!));

// The source runs once, and the fields read in pattern order.
let reads = 0;
function next(): Change {
  reads++;
  return reads % 2 ? changes[0]! : changes[1]!;
}
const { path: p1, kind: k1 } = next();
const { kind: k2 } = next();
console.log(p1, k1, k2, reads);

class Circle {
  name: string;
  size: number;
  constructor(name: string, size: number) {
    this.name = name;
    this.size = size;
  }
}
class Square {
  name: string;
  size: number;
  corners = 4;
  constructor(name: string, size: number) {
    this.name = name;
    this.size = size;
  }
}
function label({ name, size }: Circle | Square): string {
  return `${name}/${size}`;
}
console.log(label(new Circle("c", 2)), label(new Square("s", 3)));
