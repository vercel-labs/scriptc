// A write to a member of a built-in object is refused when the program also
// uses that member through code that does not read it from the object
// (SC1092): compiled code would keep running the built-in where Node runs
// the replacement. Every write below has such a use, and its refusal names
// the first one. A write nothing uses that way is not refused; the corpus
// programs builtin-member-writes-unread* pin those.
let calls = 0;
const numbers: number[] = [3, 1, 2];
const text: string = " a ";
const stamps = new Map<string, number>([["a", 1]]);

// The member itself, called through a value of the built-in. Each spelling
// of the write: an assignment, a literal key, a const alias, the global
// object, the prototype of a value the source spells out.
Array.prototype.push = function <T>(this: T[], ...items: T[]): number {
  calls++;
  return items.length;
};
numbers.push(4);
Array.prototype["pop"] = function <T>(this: T[]): T | undefined {
  return undefined;
};
numbers.pop();
const proto = Array.prototype;
proto.shift = function <T>(this: T[]): T | undefined {
  return undefined;
};
numbers.shift();
globalThis.Array.prototype.concat = function <T>(this: T[]): T[] {
  return [];
};
numbers.concat([1]);
Object.getPrototypeOf([]).reverse = function (): unknown[] {
  return [];
};
numbers.reverse();
// The descriptor and copy calls, and a deletion.
Object.defineProperty(Array.prototype, "unshift", { value: (): number => 0 });
numbers.unshift(0);
Object.assign(String.prototype, { trim: (): string => "" });
text.trim();
Reflect.set(Map.prototype, "get", (): number => 0);
stamps.get("a");
delete (Array.prototype as { indexOf?: unknown }).indexOf;
numbers.indexOf(1);
// A member the object inherits from another built-in: the write shadows it.
Uint8Array.prototype.fill = function (this: Uint8Array): Uint8Array {
  return this;
};
new Uint8Array(2).fill(1);
// A method the compiler lowers to a loop of its own.
Array.prototype.map = function (this: unknown[]): unknown[] {
  return [];
} as typeof Array.prototype.map;
numbers.map((n) => n + 1);
// An untyped receiver: the call reaches the built-in whatever it holds.
Array.prototype.slice = function (this: unknown[]): unknown[] {
  return [];
} as typeof Array.prototype.slice;
const untyped: any = JSON.parse("[1]");
untyped.slice(0);

// A constructor's and a namespace's members, called and read as a value.
Math.random = (): number => 0.5;
Math.random();
Reflect.defineProperty(Math, "min", { value: (): number => 0 });
const least = Math.min;
Number.isInteger = ((): boolean => true) as typeof Number.isInteger;
Number.isInteger(1.5);
// A member taken from its object by a destructuring declaration.
Math.hypot = (): number => 0;
const { hypot } = Math;
// A global, replaced through the global object.
(globalThis as Record<string, unknown>).parseInt = (): number => 7;
parseInt("1");

// Through a const alias of the constructor, in expression position, behind
// a test the build cannot decide, and by a logical assignment that assigns.
const A = Array;
A.prototype.splice = function <T>(this: T[]): T[] {
  return [];
};
numbers.splice(0, 1);
Object.defineProperties(Math, { max: { value: (): number => 0 } });
Reflect.deleteProperty(Math, "abs");
delete (Math as { floor?: unknown }).floor;
const kept = (Math.sign = (): number => 1);
if (calls > 0) Math.sqrt = (): number => 0;
Math.cos &&= (): number => 0;
console.log(Math.max(1, 2), Math.abs(-1), Math.floor(1.5), Math.sign(2), Math.sqrt(4), Math.cos(0));

// Another built-in function or member that reads the written one.
Array.prototype.join = function (this: unknown[]): string {
  return "";
};
const joined = String(numbers);
Date.prototype.toISOString = function (this: Date): string {
  return "";
};
new Date(0).toJSON();
Promise.resolve = ((): Promise<void> => new Promise<void>(() => {})) as typeof Promise.resolve;
void Promise.all([]);

// The language constructs that read a member: a string conversion, a
// numeric conversion, an iteration, a JSON serialization, an await.
Array.prototype.toString = function (this: unknown[]): string {
  return "";
};
const shown = `${numbers}`;
Date.prototype.valueOf = function (this: Date): number {
  return 42;
};
const stamp = +new Date(0);
Set.prototype[Symbol.iterator] = function <T>(this: Set<T>): SetIterator<T> {
  return this.values();
};
for (const member of new Set<number>([1])) calls += member;
Date.prototype.toJSON = function (this: Date): string {
  return "";
};
// A protocol member a built-in prototype does not have: adding it changes
// what serializing and awaiting its values does.
(Array.prototype as { toJSON?: unknown }).toJSON = (): string => "";
(Function.prototype as { then?: unknown }).then = (): void => {};
const serialized = JSON.stringify({ at: new Date(0) });
async function settle(): Promise<number> {
  return 1;
}

// A feature test the build decides, after a write that changes its answer.
delete (Array.prototype as { at?: unknown }).at;
if (!Array.prototype.at) {
  Array.prototype.at = function <T>(this: T[]): T | undefined {
    return undefined;
  };
}

console.log(calls, least, hypot, kept, joined, shown, stamp, serialized, settle);
export {};
