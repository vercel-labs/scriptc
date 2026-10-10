// An optional chain binds its receiver once. A receiver projected from a
// stable owner (`owner.field?.member`) is borrowed while the chain's body
// cannot remove a reference edge, and the bound value is borrowed by the body
// whenever the chain's receiver keeps it alive. Bodies that replace or clear
// the receiver's field, or drop the last other reference, must still see the
// value the chain bound first, exactly as Node does.

class Sym {
  flags: number;
  name: string;
  constructor(name: string, flags: number) {
    this.name = name;
    this.flags = flags;
  }
}

class Table {
  members: Map<string, Sym> | undefined = undefined;
  first: Sym | undefined = undefined;
  items: (Sym | undefined)[] = [];
  next: Table | undefined = undefined;
  onRead: ((s: string) => number) | undefined = undefined;
  label(): string {
    return `table(${this.members?.size ?? 0})`;
  }
}

class Owner {
  table: Table | undefined;
  constructor(table: Table | undefined) {
    this.table = table;
  }
}

function lookup(t: Table, name: string): Sym | undefined {
  const s = t.members?.get(name);
  if (s !== undefined && s.flags !== 0) return s;
  return undefined;
}

function deep(o: Owner, name: string): number {
  return o.table?.next?.members?.get(name)?.flags ?? -1;
}

let cleared = 0;
function clearAndCount(o: Owner): number {
  o.table = undefined;
  cleared++;
  return cleared;
}

function replaceMembers(t: Table): Map<string, Sym> {
  const fresh = new Map<string, Sym>();
  fresh.set("fresh", new Sym("fresh", 9));
  t.members = fresh;
  return fresh;
}

function makeTable(n: number): Table {
  const t = new Table();
  const m = new Map<string, Sym>();
  for (let i = 0; i < n; i++) m.set(`k${i}`, new Sym(`k${i}`, i));
  t.members = m;
  t.first = new Sym("first", 1);
  t.items = [new Sym("a", 1), undefined, new Sym("c", 3)];
  return t;
}

const t = makeTable(4);
console.log(lookup(t, "k2")?.name, lookup(t, "k0")?.name, lookup(t, "zz")?.name);

// The field is cleared by the body's argument: the chain still reads the map
// it bound first, and the map stays alive for the whole call.
const o = new Owner(t);
console.log(o.table?.members?.get(`k${clearAndCount(o)}`)?.name, o.table === undefined);

// The body replaces the field the receiver was read from.
const t2 = makeTable(3);
console.log(t2.members?.get(replaceMembers(t2).has("fresh") ? "k1" : "k2")?.name, t2.members?.size);

// The only other reference disappears inside the body.
const holder = new Owner(makeTable(2));
const flags = holder.table?.first?.flags;
const read = holder.table?.items.map((s) => {
  holder.table = undefined;
  return s?.name ?? "-";
});
console.log(flags, read?.join(","), holder.table === undefined);

// Nested chains over stable owners, including missing links.
const a = makeTable(2);
const b = makeTable(5);
a.next = b;
console.log(deep(new Owner(a), "k4"), deep(new Owner(b), "k4"), deep(new Owner(undefined), "k1"));

// Chains over call results and element reads.
function current(): Table | undefined {
  return a;
}
console.log(current()?.members?.get("k1")?.name, a.items[2]?.name, a.items[1]?.name ?? "hole");

// Optional calls through a field that the callback itself clears.
function callRead(t: Table, s: string): number | undefined {
  return t.onRead?.(s);
}
const c = makeTable(1);
c.onRead = (s: string): number => {
  c.onRead = undefined;
  return s.length;
};
console.log(callRead(c, "abc"), callRead(c, "abcd"), c.label());

// Values read through a chain outlive later stores to its receiver.
const d = makeTable(3);
const kept = d.members?.get("k2");
d.members = undefined;
console.log(kept?.name, kept?.flags, lookup(d, "k2"));

// A loop that exercises the borrowed lookup heavily.
let total = 0;
for (let i = 0; i < 2000; i++) {
  const s = b.members?.get(`k${i % 7}`);
  total += s?.flags ?? 100;
}
console.log(total);
