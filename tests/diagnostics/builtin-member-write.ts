// Replacing or deleting an existing member of a built-in object is refused
// by name: compiled code calls the built-in directly and would never run
// the replacement. Each statement below is one spelling of such a write.
let calls = 0;

// A prototype method, by assignment.
Array.prototype.push = function <T>(this: T[], ...items: T[]): number {
  calls++;
  return items.length;
};
// Static members and namespace functions.
Array.from = ((): unknown[] => []) as typeof Array.from;
JSON.parse = ((): unknown => 1) as typeof JSON.parse;
Math.random = (): number => 0.5;
Date.now = (): number => 0;
// A literal key and a well-known symbol key.
Array.prototype["pop"] = function <T>(this: T[]): T | undefined {
  return undefined;
};
Array.prototype[Symbol.iterator] = function <T>(this: T[]): ArrayIterator<T> {
  return [].values() as ArrayIterator<T>;
};
// A compound assignment and an update.
(Number as { MAX_SAFE_INTEGER: number }).MAX_SAFE_INTEGER += 1;
(Number as { MIN_SAFE_INTEGER: number }).MIN_SAFE_INTEGER--;
// The descriptor and copy calls.
Object.defineProperty(Array.prototype, "shift", { value: (): number => 0 });
Object.defineProperties(Math, { max: { value: (): number => 0 } });
Object.assign(String.prototype, { trim: (): string => "" });
Reflect.set(Set.prototype, "add", (): number => 0);
Reflect.defineProperty(Math, "min", { value: (): number => 0 });
Reflect.deleteProperty(Math, "abs");
// Deleting a member.
delete (Array.prototype as { unshift?: unknown }).unshift;
delete (Math as { floor?: unknown }).floor;
// Through a const alias of the prototype or of the constructor.
const proto = Array.prototype;
proto.slice = function <T>(this: T[]): T[] {
  return [];
};
const A = Array;
A.prototype.splice = function <T>(this: T[]): T[] {
  return [];
};
// Through the global object, and the global binding itself.
globalThis.Array.prototype.concat = function <T>(this: T[]): T[] {
  return [];
};
(globalThis as Record<string, unknown>).Math = {};
// Through the prototype of a value the source spells out.
Object.getPrototypeOf([]).reverse = function (): unknown[] {
  return [];
};
// A member the object inherits from another built-in: the write shadows it.
Uint8Array.prototype.fill = function (this: Uint8Array): Uint8Array {
  return this;
};
// In expression position, and behind a test the build cannot decide.
const kept = (Math.sign = (): number => 1);
if (calls > 0) Math.sqrt = (): number => 0;
// A logical assignment that does assign.
Math.cos &&= (): number => 0;

console.log(kept);
export {};
