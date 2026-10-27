// Young cycles of classes and records, dropped at once or kept from every
// kind of outside holder: globals, older objects, arrays, maps, closures,
// weak-map values, error objects, generator and async frames. Constructors
// that throw after linking `this` into a cycle leave a partly built object
// reachable from its peer. Churn between the steps runs collections (with
// the young-in nursery, nursery collections; with SCR_YOUNG_NURSERY_SIZE=1,
// one per allocation). Whatever is still reachable keeps its contents; the
// sanitized lane's RC audit fails if anything leaks or is freed early.

class Pair {
  peer: Pair | null = null;
  label: string;
  n: number;
  constructor(label: string, n: number) {
    this.label = label;
    this.n = n;
  }
}

interface Cell {
  value: number;
  next: Cell | null;
  owner: Pair | null;
}

class Fragile {
  other: Fragile | null = null;
  stage = 0;
  name: string;
  constructor(name: string, peer: Fragile | null, fail: boolean) {
    this.name = name;
    this.other = peer;
    if (peer) peer.other = this;
    this.stage = 1;
    if (fail) throw new Error(`${name} failed at stage ${this.stage}`);
    this.stage = 2;
  }
}

class Holder extends Error {
  held: Pair | null = null;
}

function pair(label: string, n: number): Pair {
  const a = new Pair(`${label}.a`, n);
  const b = new Pair(`${label}.b`, n + 1);
  a.peer = b;
  b.peer = a;
  return a;
}

function ring(size: number, base: number): Cell {
  const first: Cell = { value: base, next: null, owner: null };
  let last = first;
  for (let i = 1; i < size; i++) {
    const cell: Cell = { value: base + i, next: null, owner: null };
    last.next = cell;
    last = cell;
  }
  last.next = first;
  return first;
}

function ringSum(start: Cell): number {
  let total = start.value;
  for (let c = start.next; c !== null && c !== start; c = c.next) total += c.value;
  return total;
}

function churn(rounds: number): number {
  let acc = 0;
  for (let i = 0; i < rounds; i++) {
    acc = (acc + pair("t", i).peer!.n) % 1000003;
    acc = (acc + ringSum(ring(5, i))) % 1000003;
  }
  return acc;
}

function show(p: Pair | null): string {
  return p === null ? "null" : `${p.label}:${p.n}<->${p.peer?.label ?? "none"}`;
}

// Dropped at once, in bulk.
console.log("churn", churn(20000));

// Kept from a global, an older object, an array, a map and a closure.
const kept = pair("global", 1);
const old = new Pair("old", 0);
console.log("churn", churn(5000));
old.peer = pair("from-old", 2);
const list: Pair[] = [];
const byName = new Map<string, Pair>();
for (let i = 0; i < 50; i++) {
  list.push(pair(`list${i}`, i));
  byName.set(`map${i}`, pair(`map${i}`, i));
}
const captured = pair("closure", 3);
const read = (): string => show(captured.peer);
const cells: Cell[] = [];
for (let i = 0; i < 20; i++) {
  const c = ring(4, i * 10);
  c.owner = pair(`cell${i}`, i);
  cells.push(c);
}
console.log("churn", churn(30000));
console.log(show(kept), show(kept.peer));
console.log(show(old.peer), show(old.peer!.peer));
console.log(show(list[17]!), show(byName.get("map33")!.peer));
console.log(read());
console.log(ringSum(cells[7]!), show(cells[7]!.owner), ringSum(cells[19]!.next!));

// A weak map whose value refers back to its young key keeps the key while
// the key is held; dropping the key leaves the pair to the collector.
const weak = new WeakMap<Pair, Pair>();
const key = pair("key", 7);
weak.set(key, key.peer!);
for (let i = 0; i < 200; i++) {
  const k = pair(`weak${i}`, i);
  weak.set(k, k.peer!);
}
console.log("churn", churn(20000));
console.log(weak.has(key), show(weak.get(key) ?? null));

// Error objects (runtime-rooted classes) holding young cycles.
const errors: Holder[] = [];
for (let i = 0; i < 10; i++) {
  const e = new Holder(`holder ${i}`);
  e.held = pair(`err${i}`, i);
  errors.push(e);
}
console.log("churn", churn(10000));
console.log(errors[4]!.message, show(errors[4]!.held));

// Constructors that throw after linking into a cycle.
const survivors: Fragile[] = [];
for (let i = 0; i < 100; i++) {
  const peer = new Fragile(`peer${i}`, null, false);
  try {
    new Fragile(`victim${i}`, peer, i % 3 === 0);
  } catch (e) {
    if (i < 6) console.log((e as Error).message);
  }
  if (i % 10 === 0) survivors.push(peer);
}
console.log("churn", churn(10000));
for (const s of survivors.slice(0, 4))
  console.log(s.name, s.stage, s.other?.name, s.other?.stage, s.other?.other === s);

// Generator frames hold young objects across collections.
function* pairs(count: number): Generator<Pair> {
  for (let i = 0; i < count; i++) {
    const p = pair(`gen${i}`, i);
    churn(500);
    yield p;
  }
}
let genTotal = 0;
for (const p of pairs(30)) genTotal += p.peer!.n;
console.log("generator", genTotal);

// Async frames hold young objects across awaits.
async function hold(n: number): Promise<string> {
  const a = pair(`async${n}`, n);
  const cell = ring(3, n);
  cell.owner = a;
  await null;
  churn(3000);
  await new Promise<void>((resolve) => setTimeout(resolve, 1));
  churn(3000);
  return `${show(a)} ${show(cell.owner)} ${ringSum(cell)}`;
}
async function main(): Promise<void> {
  const pending: Promise<string>[] = [hold(1), hold(2), hold(3)];
  for (const p of pending) console.log(await p);
  console.log("churn", churn(10000));
  console.log(show(kept), show(list[49]!), read());
}
void main();
