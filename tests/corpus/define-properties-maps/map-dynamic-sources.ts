// Maps from other sources: parsed, spread, an array, Object.fromEntries, empty.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

try {
  const o: any = {};
  Object.defineProperties(o, JSON.parse('{"a":{"value":1,"enumerable":true},"b":{"value":[1,2]}}'));
  console.log(o.a, o.b.length, Object.keys(o).join(","));
} catch (e) { console.log("failed:", msg(e)); }
try {
  const o: any = {};
  const base = { a: { value: 1, enumerable: true } };
  Object.defineProperties(o, { ...base, b: { value: 2, enumerable: true } });
  console.log(o.a, o.b, Object.keys(o).join(","));
} catch (e) { console.log("failed:", msg(e)); }
try {
  const o: any = {};
  Object.defineProperties(o, [{ value: "zero", enumerable: true }, { value: "one" }] as unknown as PropertyDescriptorMap);
  console.log(o[0], o[1], Object.keys(o).join(","));
} catch (e) { console.log("failed:", msg(e)); }
try {
  const o: any = {};
  const made = Object.fromEntries(["p", "q"].map((k) => [k, { value: k, enumerable: true }]));
  Object.defineProperties(o, made);
  console.log(o.p, o.q, Object.keys(o).join(","));
} catch (e) { console.log("failed:", msg(e)); }
try {
  const o: any = {};
  console.log(Object.defineProperties(o, {}) === o, Object.keys(o).length);
} catch (e) { console.log("failed:", msg(e)); }

export {};
