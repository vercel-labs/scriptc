// JSON.stringify of an unknown (or generic) root whose value is undefined,
// a function, or a symbol returns undefined, not text. Wherever the program
// can tell the two apart (undefined/null comparisons, typeof, ??, ?., truth
// tests, returns declaring undefined, and bindings used that way) the
// native result is the actual undefined. Nested values follow Node's
// member rules: dropped from objects, null in arrays.
const u: unknown = undefined;
const f: unknown = () => 1;
const s: unknown = Symbol("x");
const ok: unknown = { a: [1, undefined] };
for (const v of [u, f, s, ok]) {
  const t = JSON.stringify(v);
  console.log(t === undefined, typeof t, t ?? "fb", t?.length, t == null, t !== undefined);
}
for (const v of [u, ok]) {
  const t = JSON.stringify(v);
  if (t) console.log("truthy", t.length);
  else console.log("falsy");
  console.log(!t, t ? "y" : "n", t || "or", t && "and");
}
console.log(JSON.stringify(u) === undefined, typeof JSON.stringify(f), JSON.stringify(s) ?? "fb2", JSON.stringify(u)?.length);
console.log(JSON.stringify(u) || "or2", JSON.stringify(ok) || "or3", !JSON.stringify(u));
function raw<T>(v: T): string | undefined {
  return JSON.stringify(v);
}
console.log(typeof raw(u), raw(ok));
function ser<T>(v: T): string {
  const text = JSON.stringify(v);
  if (text === undefined) return "undefined result";
  return `string ${text} ${text.length}`;
}
console.log(ser(u), ser({ a: 1 }), ser(1), ser("s"), ser(ok));
// Unobserved uses keep the plain string path.
const plain = JSON.stringify(ok);
console.log(plain.length, plain, `${JSON.stringify(u)}`, "x" + JSON.stringify(u));
// A module-scope binding keeps the string slot; direct uses still observe.
const top = JSON.stringify(ok);
console.log(top.length, JSON.stringify(u) === undefined);
