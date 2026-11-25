// The receiver a member call passes is the object itself: a function that
// writes through `this` writes the object it was called on, and `this` is
// identical to it.
const own = {
  count: 0,
  inc(): void {
    this.count++;
  },
};
own.inc();
own.inc();
console.log("own method", own.count);

// An object-literal method borrowed into another object writes that object.
const lender = {
  count: 10,
  inc(): void {
    this.count++;
  },
};
const borrower = { count: 0, inc: lender.inc };
borrower.inc();
borrower.inc();
console.log("borrowed method", borrower.count, lender.count);

// A function with a typed `this` parameter stored in a typed record.
function bump(this: { count: number }): void {
  this.count++;
}
const counter = { count: 0, inc: bump };
counter.inc();
counter.inc();
console.log("this parameter", counter.count);

interface Counter {
  count: number;
  inc(): void;
  add(by: number): number;
}
function add(this: Counter, by: number): number {
  this.count += by;
  return this.count;
}
function increment(this: Counter): void {
  this.add(1);
}
const typed: Counter = { count: 0, inc: increment, add };
typed.inc();
console.log("interface", typed.add(5), typed.count);

// Identity.
interface Node {
  name: string;
  self: () => boolean;
}
function same(this: unknown): boolean {
  return this === node;
}
const node: Node = { name: "n", self: same };
console.log("identity", node.self());

// A function whose parameter list is longer than the member's type.
interface Host {
  name: string;
  make: (prefix: string) => string;
}
function label(this: { name: string }, prefix: string, options?: { upper: boolean }): string {
  return (options?.upper ? prefix.toUpperCase() : prefix) + this.name;
}
const host: Host = { name: "#h", make: label };
console.log(host.make("abc"));

// An object-literal method called through a wider interface.
interface Narrow {
  name: string;
  make(prefix: string): string;
}
interface Wide {
  name: string;
  make(prefix: string, options: { upper: boolean }): string;
}
const narrow: Narrow = {
  name: "#n",
  make(prefix: string, options?: { upper: boolean }): string {
    return (options?.upper ? prefix.toUpperCase() : prefix) + this.name;
  },
};
const wide: Wide = narrow;
console.log(narrow.make("abc"), wide.make("abc", { upper: true }));

// A dictionary as the receiver.
function keys(this: Record<string, unknown>): string {
  return Object.keys(this).join();
}
const registry: Record<string, () => string> = { a: keys as () => string, b: keys as () => string };
console.log(registry["a"]!());
