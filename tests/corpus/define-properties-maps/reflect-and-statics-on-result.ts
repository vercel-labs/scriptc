// What the widened object answers afterwards: entries, names, for-in, JSON, descriptors, spread.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

interface Base { readonly label: string }
interface Wide extends Base { readonly n: number; hidden: number }
try {
  const base: Base = { get label() { return "L"; } };
  const wide = Object.defineProperties(base as Wide, { n: { value: 4, enumerable: true }, hidden: { value: 5, writable: true } });
  wide.hidden = 6;
  const entries = Object.entries(wide).map(([k, v]) => k + "=" + String(v)).join(",");
  const names = Object.getOwnPropertyNames(wide).join(",");
  const seen: string[] = [];
  for (const k in wide) seen.push(k);
  console.log(entries, names, seen.join(","), JSON.stringify(wide), wide.hidden, Object.hasOwn(wide, "hidden"), desc(wide, "n"), desc(wide, "label"));
  const copy = { ...wide };
  console.log(Object.keys(copy).join(","), copy.label, copy.n);
} catch (e) { console.log("failed:", msg(e)); }

export {};
