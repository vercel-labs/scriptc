// A field that is only ever written while its object is being constructed
// keeps its value for as long as the object lives, so scriptc reads it
// without taking a reference when the owner is an unchanged local. Each
// callee below drops every other reference it can reach before it uses the
// argument; fields that can be written later, and reads inside constructors
// (which may still write their own fields), must keep owning their values.

class Item {
  readonly name: string;
  readonly tags: string[];
  constructor(name: string, tags: string[]) {
    this.name = name;
    this.tags = tags;
  }
}

class Holder {
  readonly item: Item;
  readonly next: Holder | null;
  constructor(item: Item, next: Holder | null) {
    this.item = item;
    this.next = next;
  }
}

class Swappable {
  item: Item;
  constructor(item: Item) {
    this.item = item;
  }
  swap(next: Item): void {
    this.item = next;
  }
}

function describe(item: Item): string {
  return `${item.name}[${item.tags.join(",")}]`;
}

function useAfter(item: Item, drop: () => void): string {
  drop();
  // Allocate so a freed item's memory would be reused.
  const noise: Item[] = [];
  for (let i = 0; i < 64; i++) noise.push(new Item(`noise${i}`, [`t${i}`]));
  return describe(item) + ` (${noise.length})`;
}

let global: Holder | null = new Holder(new Item("g", ["a", "b"]), null);

// An unchanged local owns the holder while the callback drops the global.
function construction(): string {
  const h = global!;
  return useAfter(h.item, () => {
    global = null;
  });
}

// A chain of construction-only fields under one local root.
function chain(): string {
  let list: Holder | null = null;
  for (let i = 0; i < 4; i++) list = new Holder(new Item(`n${i}`, [`${i}`]), list);
  global = list;
  const root = global!;
  return useAfter(root.next!.next!.item, () => {
    global = null;
  });
}

// A field the program writes after construction keeps its owner.
let swapper = new Swappable(new Item("old", ["x"]));
function swapGlobal(): void {
  swapper.swap(new Item("new", ["y"]));
}
function written(): string {
  const s = swapper;
  const before = useAfter(s.item, swapGlobal);
  return `${before} -> ${describe(s.item)}`;
}

// A record field that is never written after the literal.
interface Pair {
  left: Item;
  right: Item;
}
let pairs: Pair[] = [{ left: new Item("l", ["1"]), right: new Item("r", ["2"]) }];
function record(): string {
  const p = pairs[0]!;
  return useAfter(p.right, () => {
    pairs = [];
  });
}

// A stable alias of a construction-only field outlives later calls.
function alias(): string {
  global = new Holder(new Item("alias", ["z"]), null);
  const h = global;
  const it = h.item;
  global = null;
  const noise: Holder[] = [];
  for (let i = 0; i < 32; i++) noise.push(new Holder(new Item(`m${i}`, []), null));
  return `${describe(it)} ${noise.length}`;
}

// A constructor reads its own field while a later operand replaces it.
function pair(a: Item, b: Item): string {
  return `${describe(a)}+${describe(b)}`;
}
class Rebuilt {
  current: Item;
  label: string;
  constructor(first: Item, second: Item) {
    this.current = first;
    this.label = pair(this.current, (this.current = second));
  }
}
function constructorRead(): string {
  const r = new Rebuilt(new Item("first", ["f"]), new Item("second", ["s"]));
  return `${r.label} now ${describe(r.current)}`;
}

// A module constant can be read without a reference.
const TABLE: Item[] = [new Item("t0", ["k"]), new Item("t1", ["k", "l"])];
function tableSize(items: Item[], drop: () => void): number {
  drop();
  return items.length + items[1]!.tags.length;
}
function moduleConstant(): string {
  return `${tableSize(TABLE, () => {
    global = null;
  })}`;
}

console.log(construction());
console.log(chain());
console.log(written());
console.log(record());
console.log(alias());
console.log(constructorRead());
console.log(moduleConstant());

let total = 0;
for (let round = 0; round < 2000; round++) {
  global = new Holder(new Item(`r${round}`, ["q"]), new Holder(new Item("inner", []), null));
  const h = global;
  total += useAfter(h.next!.item, () => {
    global = null;
  }).length;
}
console.log(total);
