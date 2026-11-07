// A function declaration and an arrow function.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

function greet(name: string): string { return "hi " + name; }
try {
  const same = Object.defineProperties(greet, { tag: { value: "t", enumerable: true }, name: { value: "renamed" } });
  console.log(same === greet, greet("x"), desc(greet, "tag"), greet.name, Object.keys(greet).join(","));
} catch (e) { console.log("failed:", msg(e)); }
const arrow = (n: number) => n + 1;
try {
  const tagged = Object.defineProperties(arrow, { calls: { value: 0, writable: true } });
  console.log(tagged === arrow, tagged(1), desc(arrow, "calls"));
} catch (e) { console.log("failed:", msg(e)); }

export {};
