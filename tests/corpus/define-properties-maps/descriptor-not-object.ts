// A descriptor that is not an object: the TypeError names it, and nothing is defined.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const bad: any[] = [1, "text", true, null, undefined];
for (const value of bad) {
  const o: any = JSON.parse("{}");
  try {
    Object.defineProperties(o, { ok: { value: 1, enumerable: true }, bad: value });
    console.log("no throw");
  } catch (e) { console.log(msg(e), Object.keys(o).length); }
}

export {};
