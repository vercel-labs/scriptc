// Array lengths and indices at the 2^32 - 1 limit, sparse writes past the
// dense capacity, holes and boolean arrays: the length and capacity fit in
// 32 bits, and the dense states follow the value slots.

function report(label: string, run: () => unknown): void {
  try {
    console.log(label, run());
  } catch (e) {
    console.log(label, e instanceof Error ? `${e.name}: ${e.message}` : e);
  }
}

const big: string[] = [];
big.length = 4294967295;
console.log("max length", big.length);
report("length 2^32", () => {
  const a: number[] = [];
  a.length = 4294967296;
  return a.length;
});
report("length -1", () => {
  const a: number[] = [];
  a.length = -1;
  return a.length;
});

const edge: string[] = [];
edge[4294967294] = "last";
console.log("max index", edge.length, edge[4294967294]);

// Sparse writes beyond the dense capacity, then densifying appends.
const sparse: number[] = [1, 2, 3];
sparse[1000] = 4;
sparse[50] = 5;
console.log("sparse", sparse.length, sparse[1000], sparse[50], 999 in sparse, sparse.indexOf(5));
for (let i = 3; i < 60; i++) if (!(i in sparse)) sparse[i] = i;
console.log("filled", sparse.slice(0, 8).join(","), sparse[49], sparse[50], sparse.lastIndexOf(4));
sparse.length = 10;
console.log("truncated", sparse.length, sparse.join(","), 50 in sparse);

// Holes and their states across growth and splice.
const holes: (string | undefined)[] = ["a", , "c", undefined] as (string | undefined)[];
console.log("holes", holes.length, 1 in holes, 3 in holes, holes.indexOf(undefined));
holes.push("e", "f", "g", "h", "i");
holes.splice(1, 2, "B");
console.log("spliced", holes.length, JSON.stringify(holes), 1 in holes);
const copy = holes.slice(0, 3);
console.log("slice", copy.length, copy.join("|"));

// Boolean arrays keep one byte per element; their states follow them.
const flags: boolean[] = [];
for (let i = 0; i < 40; i++) flags.push(i % 3 === 0);
flags[45] = true;
console.log("bools", flags.length, flags.filter((f) => f).length, 42 in flags, flags.indexOf(true, 40));
flags.length = 5;
flags.unshift(false);
console.log("bools after", flags.join(","), flags.length);

// Many one-element arrays (the common case the 48-byte header targets).
const ones: number[][] = [];
for (let i = 0; i < 1000; i++) ones.push([i]);
let total = 0;
for (const one of ones) total += one[0]! + one.length;
console.log("ones", ones.length, total, ones[999]!.concat(ones[0]!).join(","));

// Tagged templates hand out an immortal strings array.
function tag(strings: TemplateStringsArray, ...values: number[]): string {
  return `${strings.length}:${strings.join("_")}:${values.join(",")}`;
}
console.log("tagged", tag`a${1}b${2}c`, tag`only`);

// Small arrays filled past their inline slots, of numbers and of class
// instances that can form cycles.
class Node {
  readonly id: number;
  readonly next: Node[] = [];
  constructor(id: number) {
    this.id = id;
  }
}
const grown: number[][] = [];
for (let n = 0; n < 10; n++) {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(i * n);
  grown.push(a);
}
console.log("grown", grown.map((a) => a.join("-")).join(" "));
const root = new Node(0);
for (let i = 1; i <= 9; i++) {
  const child = new Node(i);
  child.next.push(root);
  root.next.push(child);
  console.log("node", i, root.next.length, root.next.map((c) => c.id).join(""), child.next[0]!.id);
}
