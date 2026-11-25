// A variadic function stored in a slot the program declares is called with
// the slot's parameters, which is every argument a call through that slot
// passes. It observes how many it gets, each one, and the receiver, exactly
// as under Node: for a rest parameter alone, a named parameter before the
// rest, and a function that came out of a variable, a field or an array.
function show(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean")
    return typeof value + ":" + String(value);
  if (typeof value === "function") return "function";
  if (Array.isArray(value)) return "array:" + value.length;
  return "object";
}
function report(tag: string, self: unknown, args: unknown[]): void {
  let seen = "";
  for (let i = 0; i < args.length; i++) seen += (i > 0 ? "|" : "") + show(args[i]);
  console.log(tag, self === undefined ? "undefined" : typeof self, args.length, seen);
}
function all(tag: string): (...args: unknown[]) => void {
  return function (this: unknown, ...args: unknown[]): void {
    report(tag, this, args);
  };
}
function lead(tag: string): (first: number, ...more: unknown[]) => void {
  return function (this: unknown, first: number, ...more: unknown[]): void {
    report(tag + " first=" + first, this, more);
  };
}
function sum(tag: string): (...args: unknown[]) => unknown {
  return (...args: unknown[]): unknown => {
    report(tag, undefined, args);
    return args.length * 10;
  };
}

// A binding, a parameter and a result.
const two: (a: number, b: string) => void = all("binding");
two(1, "two");
const none: () => void = all("no parameters");
none();
const led: (a: number, b: string, c: boolean) => void = lead("lead");
led(1, "two", true);
function run(f: (a: number, b: string) => void): void {
  f(3, "four");
}
run(all("parameter"));
run(lead("lead parameter"));
function make(): (a: number) => void {
  return all("result");
}
make()(5);
const counted: (a: number, b: number) => number = sum("checked result") as (...args: unknown[]) => number;
console.log(counted(6, 7));

// A class field, a record member, an array element and a Map's value: a
// call through the holder passes the holder as the receiver.
class Box {
  act: (a: number, b: string) => void;
  constructor(act: (a: number, b: string) => void) {
    this.act = act;
  }
}
new Box(all("field")).act(8, "nine");
const record: { act: (a: number) => void; name: string } = { act: all("member"), name: "r" };
record.act(10);
const acts: ((a: number, b: string) => void)[] = [all("element"), lead("lead element")];
for (const act of acts) act(11, "twelve");
const table = new Map<string, (a: number) => void>();
table.set("k", all("map value"));
table.get("k")!(13);

// An optional slot, a default, a conditional, and a promise's value.
let optional: ((a: number, b: string) => void) | undefined;
optional = all("optional");
if (optional) optional(14, "fifteen");
const absent: ((a: number) => void) | undefined = undefined;
const chosen: (a: number) => void = absent ?? all("default");
chosen(16);
const either: (a: number) => void = acts.length > 1 ? all("yes") : all("no");
either(17);

// A slot that is variadic itself hands over everything it was given.
const numbers: (...xs: number[]) => void = all("typed rest slot");
numbers(1, 2, 3);
numbers();

// The program's own higher-order function passes what its parameter names.
function each(items: number[], f: (value: number, index: number) => void): void {
  for (let i = 0; i < items.length; i++) f(items[i]!, i);
}
each([18, 19], all("each"));
each([20], lead("lead each"));

// The same functions out of a variable, a field and an array.
const stored = all("variable");
const holder = { cb: all("held field"), lead: lead("held lead") };
const list = [all("held element")];
const fromVariable: (a: number, b: string) => void = stored;
fromVariable(21, "x");
const fromField: (a: number, b: string) => void = holder.cb;
fromField(22, "y");
const fromLead: (a: number, b: string) => void = holder.lead;
fromLead(23, "z");
const fromElement: (a: number, b: string) => void = list[0]!;
fromElement(24, "w");

// A promise's value settles as the same function.
const later: Promise<(a: number, b: string) => void> = Promise.resolve(all("promise value"));
later.then((f) => f(25, "v"));
