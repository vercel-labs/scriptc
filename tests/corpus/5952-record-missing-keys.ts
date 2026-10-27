// A keyed read of a Record or index signature that misses answers
// undefined, as in Node, at module top level and inside functions, without
// noUncheckedIndexedAccess. Static types stay what TypeScript says.
export {};

const kp = String(Date.now());
const r: Record<string, number> = { [kp]: 1, a: 2 };
console.log(r["k"], r["a"], r[kp] === 1);
console.log("done");

function inside(): void {
  const local: Record<string, number> = { [kp]: 1 };
  console.log(local["k"], local[kp]);
}
inside();

// Bindings, reassignment, arithmetic, templates and conversions.
const v = r["missing"];
console.log(v, typeof v, v === undefined);
let w = r["nope"];
console.log(w);
w = 5;
console.log(w + 1);
console.log(r["x"] + 1, r["a"] + 1, `${r["x"]}`, String(r["x"]), r["x"] > 1, r["a"] > 1);
console.log(Math.max(r["a"], r["nope"]), isNaN(r["nope"]), r["nope"] == null);

// Parameters, returns, record fields and array elements.
function take(n: number): string {
  return String(n);
}
console.log(take(r["q"]), take(r["a"]));
function give(k: string): number {
  return r[k];
}
console.log(give("a"), give("zz"));
const o = { v: r["zz"] };
console.log(JSON.stringify(o), o.v);
const arr: number[] = [r["zz"], r["a"]];
console.log(arr.length, arr[0], arr[1]);

// Dot reads through the index signature and destructuring.
console.log(r.zz, r.a, r.zz === undefined);
const { a, missing } = r;
console.log(a, missing);

// Strings, booleans, arrays and unions as index values.
const s: Record<string, string> = { a: "x" };
console.log(s["b"], s["a"].toUpperCase(), s["b"]?.length);
try {
  console.log(s["b"].length);
} catch (error) {
  console.log((error as Error).message);
}
const b: Record<string, boolean> = { t: true };
console.log(b["f"], b["t"], !b["f"], b["f"] ? "y" : "n");
const nested: Record<string, number[]> = { a: [1] };
console.log(nested["b"], nested["a"].length, nested["b"]?.length);
const mixed: Record<string, number | string> = { n: 1, s: "x" };
const m2 = mixed["q"];
console.log(mixed["q"], typeof mixed["q"], mixed["n"], m2 === undefined);

// Interfaces with declared fields and an index signature.
interface Bag {
  name: string;
  [key: string]: string;
}
const bag: Bag = { name: "n" };
console.log(bag.name, bag["other"], bag.other);

// Methods returning a keyed read, and loops over present and missing keys.
class Holder {
  table: Record<string, number> = { x: 1 };
  get(k: string): number {
    return this.table[k];
  }
}
const h = new Holder();
console.log(h.get("x"), h.get("y"), h.table["z"]);
const counts: Record<string, number> = {};
for (const word of ["a", "b", "a"]) counts[word] = (counts[word] ?? 0) + 1;
console.log(JSON.stringify(counts), counts["c"]);
let total = 0;
for (const k of ["a", "zz"]) {
  console.log(k, r[k], r[k] !== undefined);
  total += r[k];
}
console.log(total);
if (r["zz"] === undefined) console.log("missing zz");

// Nested tables: a missing outer entry is undefined, and a member access
// on it throws Node's TypeError after the key evaluates.
const tables: Record<string, Record<string, number>> = { m: { one: 1 } };
console.log(tables["m"]["one"], tables.m.one, tables["m"]["two"]);
tables["m"]["three"] = 3;
tables.m.four = 4;
console.log(JSON.stringify(tables));
const objs: Record<string, { b: number }> = { a: { b: 1 } };
objs["a"].b = 5;
console.log(objs["a"].b, objs.a.b);
const dynamicKey = `z${kp.length > 0 ? "z" : ""}`;
for (const attempt of [
  () => objs["zz"].b,
  () => tables["zz"]["q"],
  () => tables[dynamicKey]["q"],
  () => {
    tables["zz"]["q"] = 1;
  },
  () => {
    objs[dynamicKey].b = 2;
  },
]) {
  try {
    attempt();
  } catch (error) {
    console.log(error instanceof TypeError, (error as Error).message);
  }
}

// Calling a function stored under a missing key throws Node's TypeError.
const handlers: Record<string, (n: number) => number> = { double: (n) => n * 2 };
const handlerName = "double";
console.log(handlers["double"](4), handlers[handlerName](5));
try {
  console.log(handlers["triple"](4));
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}
