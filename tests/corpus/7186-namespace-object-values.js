// Math, JSON and Reflect read as values are objects with Node's own
// properties: typeof, String, `in`, aliasing and member calls through
// the value behave as in Node, and every spelling is the same object.
function describe(value) {
  return [typeof value, String(value), Object.prototype.toString.call(value)].join(" ");
}
console.log(describe(Math), "|", describe(JSON), "|", describe(Reflect));

const m = Math;
console.log(m.abs(-2), m.max(1, 5, 3), m.PI.toFixed(5), "trunc" in m, m === Math);
console.log(m === globalThis.Math, JSON === globalThis.JSON);
const { Math: fromGlobal } = globalThis;
console.log(fromGlobal === Math, fromGlobal.sqrt(81));

const known = new Set([Math, JSON, Reflect]);
console.log(known.has(Math), known.has(globalThis.JSON), known.size);

const parse = JSON.parse;
console.log(parse("[1,2]").length, JSON.stringify({ a: [1] }));

console.log(typeof Math === "object" && typeof Reflect === "object");
console.log(Math.max.length, Math.min.length, Math.hypot.length, Math.abs.length);

const r = Reflect;
const ownKeys = r.ownKeys;
console.log(ownKeys === Reflect.ownKeys, r.ownKeys === Reflect.ownKeys, typeof ownKeys);
console.log(r.ownKeys({ a: 1, b: 2 }).length, ownKeys({ c: 3 })[0], ownKeys.name, ownKeys.length);
