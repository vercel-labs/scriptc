// JavaScript: the errors.
function msg(e) { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o, k) { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const attempts = [
  ["mixed", () => Object.defineProperties({}, { a: { value: 1 }, b: { get() { return 1; }, value: 2 } })],
  ["not object", () => Object.defineProperties({}, { a: 1 })],
  ["null map", () => Object.defineProperties({}, null)],
  ["undefined map", () => Object.defineProperties({}, undefined)],
  ["null target", () => Object.defineProperties(null, {})],
  ["string map", () => Object.defineProperties({}, "ab")],
  ["number map", () => Object.keys(Object.defineProperties({}, 5)).length],
  ["getter", () => Object.defineProperties({}, { a: { get: 1 } })],
  ["frozen", () => Object.defineProperties(Object.freeze({ a: 1 }), { b: { value: 1 } })],
  ["frozen change", () => Object.defineProperties(Object.freeze({ a: 1 }), { a: { value: 2 } })],
];
for (const [label, attempt] of attempts) {
  // Node's text for these two names the offending value; the kind of error is what is pinned here.
  const kindOnly = label === "mixed" || label === "getter";
  try { console.log(label, "->", String(attempt())); } catch (e) { console.log(label, "->", kindOnly ? String(e instanceof TypeError) : msg(e)); }
}
const target = {};
try { Object.defineProperties(target, { first: { value: 1, enumerable: true }, second: 2 }); } catch (e) { console.log(msg(e), Object.keys(target).length); }
