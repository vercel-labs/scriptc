import type { ProgramLifetime } from "@scriptc/types";

// ProgramLifetime classes whose fields hold arrays, maps, sets and instances
// of ordinary classes, plain and as `T | undefined` / `T | null`: reads,
// overwrites that release the old value, values shared with other owners,
// large arrays and instances, regex match arrays, tagged template strings
// arrays, entries, inspection, JSON and a structured clone.

class Item {
  readonly id: number;
  readonly label: string;
  constructor(id: number, label: string) {
    this.id = id;
    this.label = label;
  }
  describe(): string {
    return `${this.label}#${this.id}`;
  }
}

class Wide {
  f0 = 0;
  f1 = 1;
  f2 = 2;
  f3 = 3;
  f4 = 4;
  f5 = 5;
  f6 = 6;
  f7 = 7;
  f8 = 8;
  f9 = 9;
  g0 = "a";
  g1 = "b";
  g2 = "c";
  g3 = "d";
  g4 = "e";
  g5 = "f";
  g6 = "g";
  g7 = "h";
  h0 = 0.5;
  h1 = 1.5;
  h2 = 2.5;
  h3 = 3.5;
  h4 = 4.5;
  h5 = 5.5;
  h6 = 6.5;
  h7 = 7.5;
  i0 = [0];
  i1 = [1];
  i2 = [2];
  i3 = [3];
  i4 = [4];
  i5 = [5];
  i6 = [6];
  i7 = [7];
  j0 = 10;
  j1 = 11;
  j2 = 12;
  j3 = 13;
  j4 = 14;
  j5 = 15;
  j6 = 16;
  j7 = 17;
  k0 = 20;
  k1 = 21;
  k2 = 22;
  k3 = 23;
  k4 = 24;
  k5 = 25;
  k6 = 26;
  k7 = 27;
  l0 = 30;
  l1 = 31;
  l2 = 32;
  l3 = 33;
  l4 = 34;
  l5 = 35;
  l6 = 36;
  l7 = 37;
  m0 = 40;
  m1 = 41;
  m2 = 42;
  m3 = 43;
  m4 = 44;
  m5 = 45;
  m6 = 46;
  m7 = 47;
  n0 = 50;
  n1 = 51;
  n2 = 52;
  n3 = 53;
  n4 = 54;
  n5 = 55;
  n6 = 56;
  n7 = 57;
  total(): number {
    return this.f9 + this.n7 + this.i7[0]! + this.h7;
  }
}

class Node implements ProgramLifetime {
  readonly kids: Node[] = [];
  readonly tags = new Set<string>();
  readonly attrs = new Map<string, number>();
  item: Item;
  maybeItem: Item | undefined = undefined;
  nullItem: Item | null = null;
  maybeList: number[] | undefined = undefined;
  nullMap: Map<string, Item> | null = null;
  wide: Wide | undefined = undefined;
  match: string[] | null = null;
  strings: TemplateStringsArray | undefined = undefined;
  readonly name: string;
  constructor(name: string, item: Item) {
    this.name = name;
    this.item = item;
  }
}

function tag(strings: TemplateStringsArray, ...values: number[]): string {
  right.strings = strings;
  return strings.join(String(values.length));
}

const show = (n: Node): string =>
  [
    n.name,
    n.kids.map((k) => k.name).join("+"),
    [...n.tags].join("|"),
    [...n.attrs].map(([k, v]) => `${k}=${v}`).join("&"),
    n.item.describe(),
    n.maybeItem?.describe() ?? "-",
    n.nullItem === null ? "null" : n.nullItem.describe(),
    n.maybeList?.join(".") ?? "-",
    n.nullMap === null ? "null" : [...n.nullMap.keys()].join(","),
  ].join(" ");

// Construction and reads.
const root = new Node("root", new Item(1, "root-item"));
const left = new Node("left", new Item(2, "left-item"));
const right = new Node("right", new Item(3, "right-item"));
root.kids.push(left, right);
root.tags.add("top").add("named");
root.attrs.set("depth", 0).set("width", 2);
console.log(show(root));

// Overwrites release the old value; a value held elsewhere survives.
const shared = new Item(4, "shared");
const keep: Item[] = [shared];
root.maybeItem = shared;
root.maybeItem = new Item(5, "fresh");
root.maybeItem = undefined;
root.nullItem = shared;
root.item = new Item(6, "replaced");
console.log(show(root), keep[0]!.describe(), keep[0] === root.nullItem);

// Nullable arrays and maps, set, replaced and cleared.
root.maybeList = [1, 2, 3];
root.maybeList.push(4);
root.nullMap = new Map([["a", shared]]);
console.log(show(root));
root.maybeList = undefined;
root.nullMap = null;
console.log(show(root));

// A large array and a large instance (over 512 bytes each).
const big = new Node("big", new Item(7, "big-item"));
big.maybeList = Array.from({ length: 5000 }, (_, i) => i);
big.wide = new Wide();
let sum = 0;
for (const v of big.maybeList) sum += v;
console.log(sum, big.maybeList.length, big.wide.total(), big.wide.g7);

// Many nodes, so that their fields' targets spread over many blocks.
const nodes: Node[] = [];
for (let i = 0; i < 2000; i++) {
  const n = new Node(`n${i}`, new Item(i, `item${i}`));
  n.attrs.set("i", i);
  if (i % 3 === 0) n.maybeItem = new Item(-i, "neg");
  if (i % 5 === 0) n.tags.add(`t${i % 7}`);
  if (i > 0) nodes[i - 1]!.kids.push(n);
  nodes.push(n);
}
let check = 0;
for (const n of nodes)
  check += n.item.id + (n.maybeItem?.id ?? 0) + n.kids.length + n.tags.size;
console.log(
  check,
  nodes[1999]!.item.describe(),
  nodes[3]!.maybeItem?.describe(),
);

// A regex match array and a tagged template's strings array, held in fields.
const re = /(\w+)-(\d+)/;
left.match = re.exec("node-42 and more");
for (let i = 0; i < 3; i++) tag`a${i}b${i}c`;
console.log(
  left.match?.[1],
  left.match?.[2],
  left.match?.length,
  right.strings?.join("/"),
  right.strings?.length,
);

// Entries, inspection, JSON and structured clones of a node's fields.
for (const [key, v] of Object.entries(root)) {
  if (!["kids", "tags", "attrs", "item", "nullItem", "maybeList"].includes(key))
    continue;
  console.log(
    key,
    Array.isArray(v)
      ? `array(${v.length})`
      : v instanceof Map
        ? "map"
        : v instanceof Set
          ? "set"
          : typeof v,
  );
}
console.log(left.item, left.kids, root.tags);
console.log(
  JSON.stringify({
    item: left.item,
    attrs: [...root.attrs],
    list: big.maybeList.slice(0, 5),
  }),
);
const copy = structuredClone(big.maybeList.slice(0, 3));
console.log(copy.join(","), copy === big.maybeList);
