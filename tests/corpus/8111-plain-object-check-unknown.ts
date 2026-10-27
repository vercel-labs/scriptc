// A plain-object check over unknown values, the way schema libraries
// accept records: the value's constructor must be absent, not a function,
// or one whose prototype has its own isPrototypeOf. Values that crossed
// JSON.parse and object literals pass; arrays, class instances and errors
// fail.

function isObject(data: unknown): data is Record<PropertyKey, unknown> {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}

function isPlainObject(o: unknown): o is Record<PropertyKey, unknown> {
  if (!isObject(o)) return false;
  const ctor: unknown = o.constructor;
  if (ctor === undefined) return true;
  if (typeof ctor !== "function") return true;
  const prot: unknown = (ctor as { prototype?: unknown }).prototype;
  if (!isObject(prot)) return false;
  if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) return false;
  return true;
}

class Point {
  x = 1;
}

const inputs: [string, unknown][] = [
  ["literal", { a: 1 }],
  ["empty", {}],
  ["parsed", JSON.parse('{"k":[1,2],"m":{"n":true}}')],
  ["parsed-nested", (JSON.parse('{"m":{"n":true}}') as { m: unknown }).m],
  ["null-proto", Object.create(null)],
  ["array", [1, 2]],
  ["instance", new Point()],
  ["error", new Error("x")],
  ["ctor-number", { constructor: 3 }],
  ["string", "s"],
  ["null", null],
];

for (const [label, value] of inputs) {
  console.log(label, isPlainObject(value));
}

const records: Record<string, number> = {};
for (const [label, value] of inputs) {
  if (!isPlainObject(value)) continue;
  records[label] = Object.keys(value).length;
}
console.log(JSON.stringify(records));

const proto: unknown = Object.getPrototypeOf({});
console.log(proto === Object.prototype, Object.prototype.hasOwnProperty.call(proto, "isPrototypeOf"));
console.log(Object.hasOwn(Object.prototype, "hasOwnProperty"), Object.hasOwn(Object.prototype, "nope"));
console.log(Object.getOwnPropertyNames(Object.prototype).length);
