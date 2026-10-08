// Map, Set and array iterators returned through methods annotated
// IterableIterator<T> or Iterator<T>, forwarded through further methods
// and functions, and stored in variables. Iteration stays lazy and live:
// entries added while a loop runs are visited, and an exhausted iterator
// stays exhausted.

interface Slot {
  n: number;
}

class Inventory {
  private readonly counts = new Map<string, number>();
  private readonly tags = new Set<string>();
  readonly slots = new Map<string, Slot>();
  readonly history: string[] = [];
  add(name: string, n: number): void {
    this.counts.set(name, n);
    this.tags.add(name.toUpperCase());
    this.history.push(name);
  }
  entries(): IterableIterator<[string, number]> {
    return this.counts.entries();
  }
  names(): IterableIterator<string> {
    return this.counts.keys();
  }
  amounts(): Iterator<number> {
    return this.counts.values();
  }
  tagList(): IterableIterator<string> {
    return this.tags.values();
  }
  recent(): IterableIterator<string> {
    return this.history.values();
  }
  positions(): IterableIterator<[number, string]> {
    return this.history.entries();
  }
  slotEntries(): IterableIterator<[string, Slot]> {
    return this.slots.entries();
  }
}

class Store {
  readonly stock = new Inventory();
  entries(): IterableIterator<[string, number]> {
    return this.stock.entries();
  }
}

function forward(store: Store): IterableIterator<[string, number]> {
  return store.entries();
}

function* steps(): Generator<number, void, undefined> {
  yield 1;
  yield 2;
}
function stepsAsIterator(): IterableIterator<number> {
  return steps();
}

const store = new Store();
store.stock.add("bolt", 3);
store.stock.add("nut", 5);

for (const [name, n] of forward(store)) console.log("entry", name, n);

let grew = false;
for (const name of store.stock.names()) {
  console.log("name", name);
  if (!grew) {
    store.stock.add("washer", 9);
    grew = true;
  }
}

const amounts = store.stock.amounts();
let step = amounts.next();
while (!step.done) {
  console.log("amount", step.value);
  step = amounts.next();
}
console.log("after", amounts.next().done);

const stored: IterableIterator<[string, number]> = store.entries();
for (const [name] of stored) {
  console.log("first only", name);
  break;
}
for (const [name] of stored) console.log("rest", name);

console.log("spread", [...store.stock.tagList()]);
console.log("from", Array.from(store.stock.names()));
console.log("positions", [...store.stock.positions()]);

let total = 0;
for (const v of store.stock.recent()) {
  total += v.length;
  if (v === "bolt") store.stock.history.push("pin");
}
console.log("total", total, store.stock.history.length);

store.stock.slots.set("a", { n: 1 });
for (const [, slot] of store.stock.slotEntries()) slot.n += 10;
console.log("slot", store.stock.slots.get("a")!.n);

const counted = stepsAsIterator();
console.log("generator", counted.next().value, [...counted]);

const empty = new Inventory();
console.log("empty", [...empty.entries()], empty.amounts().next().done);

// Leaving a loop early closes a generator (its finally block runs) but
// leaves a native iterator open, so a later loop resumes where it stopped.
function* guarded(): Generator<number, void, undefined> {
  try {
    yield 1;
    yield 2;
    yield 3;
  } finally {
    console.log("guarded closed");
  }
}
function guardedSteps(): IterableIterator<number> {
  return guarded();
}
const closing = guardedSteps();
for (const n of closing) {
  console.log("guarded", n);
  if (n === 2) break;
}
console.log("guarded after", closing.next().done);

const resumable = store.entries();
for (const [name] of resumable) {
  console.log("before throw", name);
  break;
}
try {
  for (const [name] of resumable) {
    console.log("throwing at", name);
    throw new Error("stop");
  }
} catch (e) {
  if (e instanceof Error) console.log("caught", e.message);
}
for (const [name] of resumable) console.log("resumed", name);
