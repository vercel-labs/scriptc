// Class instances with reference fields that never leave their function:
// builders and per-call state objects whose methods read and write their
// fields, overwrite them, throw while they live, and are created per loop
// iteration.
class Tag {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

class Collector {
  readonly items: string[] = [];
  readonly seen = new Map<string, number>();
  last: string | undefined = undefined;
  tag: Tag | null = null;
  count = 0;

  add(item: string): void {
    this.items.push(item);
    this.seen.set(item, (this.seen.get(item) ?? 0) + 1);
    this.last = item;
    this.count++;
  }

  label(name: string): void {
    this.tag = new Tag(name);
  }

  summary(): string {
    return `${this.count}:${this.items.join(",")}:${this.last ?? "-"}:${this.tag?.name ?? "-"}`;
  }
}

function collect(words: string[]): string {
  const c = new Collector();
  for (const w of words) c.add(w);
  c.label("first");
  c.label("second");
  return c.summary() + ` dup=${c.seen.get("a") ?? 0}`;
}
console.log(collect(["a", "b", "a", "c"]));

function fill(c: Collector, n: number): void {
  for (let i = 0; i < n; i++) c.add(`w${i % 3}`);
}

function readCount(c: Collector): number {
  return c.count + c.items.length;
}

function viaHelpers(n: number): string {
  const c = new Collector();
  fill(c, n);
  return `${readCount(c)} ${c.summary()}`;
}
console.log(viaHelpers(5));

// A field value can leave; the object stays.
function firstItems(n: number): string[] {
  const c = new Collector();
  fill(c, n);
  return c.items.slice(0, 2);
}
console.log(firstItems(4).join("|"));

// One instance per iteration.
let total = 0;
for (let round = 0; round < 1000; round++) {
  const c = new Collector();
  fill(c, round % 7);
  total += c.count + (c.last?.length ?? 0);
}
console.log("total", total);

// Throwing while the instance lives releases its fields once.
class Checked {
  readonly values: string[] = [];
  owner: Tag;
  constructor(owner: string) {
    this.owner = new Tag(owner);
  }
  push(value: string): void {
    if (value === "bad") throw new Error(`bad value after ${this.values.join("+")}`);
    this.values.push(value);
  }
}

function checkAll(values: string[]): string {
  const c = new Checked("checker");
  for (const v of values) c.push(v);
  return `${c.owner.name} ${c.values.length}`;
}
for (const input of [["x", "y"], ["x", "bad", "z"], []]) {
  try {
    console.log(checkAll(input));
  } catch (e) {
    console.log("caught", (e as Error).message);
  }
}

// A constructor that throws after storing some fields.
class Partial {
  readonly first: string[];
  readonly second: string[];
  constructor(n: number) {
    this.first = [`n${n}`];
    if (n < 0) throw new RangeError(`negative ${n}`);
    this.second = [`m${n}`];
  }
  both(): string {
    return this.first.concat(this.second).join("/");
  }
}

function build(n: number): string {
  const p = new Partial(n);
  return p.both();
}
for (const n of [1, -1, 2]) {
  try {
    console.log(build(n));
  } catch (e) {
    console.log("caught", (e as Error).name, (e as Error).message);
  }
}

// Early exits from the binding's scope.
function search(words: string[], target: string): number {
  for (let i = 0; i < 3; i++) {
    const c = new Collector();
    for (const w of words) {
      c.add(w);
      if (w === target) return c.count * 10 + i;
    }
    if (c.count > 2) break;
  }
  return -1;
}
console.log(search(["p", "q", "r"], "q"), search(["p", "q", "r"], "z"));

// A cycle-capable class: its nodes can point back to each other.
class Node {
  next: Node | null = null;
  readonly id: number;
  constructor(id: number) {
    this.id = id;
  }
}

class Ring {
  readonly nodes: Node[] = [];
  head: Node | null = null;
  add(id: number): void {
    const n = new Node(id);
    if (this.head !== null) n.next = this.head;
    this.head = n;
    this.nodes.push(n);
  }
  close(): void {
    if (this.nodes.length > 0) this.nodes[0]!.next = this.head;
  }
  walk(steps: number): number {
    let sum = 0;
    let at = this.head;
    for (let i = 0; i < steps && at !== null; i++) {
      sum += at.id;
      at = at.next;
    }
    return sum;
  }
}

function ring(n: number): number {
  const r = new Ring();
  for (let i = 1; i <= n; i++) r.add(i);
  r.close();
  return r.walk(n * 2);
}
console.log(ring(4), ring(0));

// A cycle-capable class in frame storage: its own field holds heap
// instances of the same class, and those form a cycle among themselves.
class Link {
  next: Link | null = null;
  label: string;
  constructor(label: string) {
    this.label = label;
  }
}

function chain(n: number): string {
  const head = new Link("head");
  let tail = new Link("t0");
  head.next = tail;
  for (let i = 1; i < n; i++) {
    const link = new Link(`t${i}`);
    tail.next = link;
    tail = link;
  }
  tail.next = head.next;
  const labels: string[] = [head.label];
  let at: Link | null = head.next;
  for (let i = 0; i < n + 2 && at !== null; i++) {
    labels.push(at.label);
    at = at.next;
  }
  return labels.join(">");
}
console.log(chain(3));
for (let i = 0; i < 200; i++) chain(i % 5 + 1);
console.log(chain(1));

// A fresh instance used in place as a receiver or argument, never kept.
class Overloads {
  readonly names: string[];
  readonly seen = new Set<string>();
  duplicates = 0;
  constructor(names: string[]) {
    this.names = names;
  }
  check(): number {
    for (const n of this.names) {
      if (this.seen.has(n)) this.duplicates++;
      this.seen.add(n);
    }
    return this.duplicates;
  }
}

function countDuplicates(o: Overloads): number {
  return o.check() + o.names.length;
}

let duplicates = 0;
for (let i = 0; i < 100; i++) {
  duplicates += new Overloads(["f", "g", "f", `h${i % 3}`, "g"]).check();
  duplicates += countDuplicates(new Overloads(["x", "x"]));
}
console.log("duplicates", duplicates);

// Closures that capture the instance (or `this`) and are only invoked by
// the callee they are passed to.
function each(xs: number[], f: (x: number) => void): void {
  for (const x of xs) f(x);
}

class Totals {
  readonly seen: number[] = [];
  total = 0;
  add(x: number): void {
    this.total += x;
    this.seen.push(x);
  }
  addAll(xs: number[]): void {
    each(xs, (x) => this.add(x));
  }
}

const handlers: ((x: number) => void)[] = [];
function totals(xs: number[], keep: boolean): number {
  const t = new Totals();
  t.addAll(xs);
  each(xs, (x) => t.add(x * 2));
  if (keep) handlers.push((x) => t.add(x));
  return t.total + t.seen.length;
}
console.log(totals([1, 2, 3], false), totals([4], true));
for (const h of handlers) h(5);
console.log("handlers", handlers.length);

function doubled(xs: number[]): number {
  const t = new Totals();
  t.addAll(xs);
  each(xs, (x) => t.add(x * 2));
  return t.total + t.seen.length;
}
let doubledSum = 0;
for (let i = 0; i < 50; i++) doubledSum += doubled([i, i + 1]);
console.log("doubled", doubledSum);

// try/finally around the instance's use: the finally block runs and the
// fields are released on every path.
function guarded(words: string[], failAt: number): string {
  const log: string[] = [];
  try {
    const c = new Collector();
    try {
      for (let i = 0; i < words.length; i++) {
        if (i === failAt) throw new Error(`stop at ${words[i]}`);
        c.add(words[i]!);
      }
      return c.summary();
    } finally {
      log.push(`finally ${c.count}`);
    }
  } catch (e) {
    return `${(e as Error).message} ${log.join(",")}`;
  }
}
console.log(guarded(["a", "b", "c"], -1));
console.log(guarded(["a", "b", "c"], 1));

// A nullable class field whose union is a Set element and a Map key
// elsewhere: the field holds the class pointer itself, and the frame
// releases it as one.
class Badge {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}
const seenBadges = new Set<Badge | null>();
const badgeCounts = new Map<Badge | null, number>();
class BadgeHolder {
  badge: Badge | null = null;
  count = 0;
  set(name: string): void {
    this.badge = new Badge(name);
    this.count++;
  }
}
function badgeLabel(names: string[]): string {
  const h = new BadgeHolder();
  for (const n of names) h.set(n);
  seenBadges.add(h.badge);
  badgeCounts.set(h.badge, (badgeCounts.get(h.badge) ?? 0) + h.count);
  return `${h.badge?.name ?? "-"}:${h.count}`;
}
for (let i = 0; i < 100; i++) badgeLabel(["a", `b${i % 3}`]);
console.log(badgeLabel(["x", "y"]), badgeLabel([]), seenBadges.size, badgeCounts.size);
