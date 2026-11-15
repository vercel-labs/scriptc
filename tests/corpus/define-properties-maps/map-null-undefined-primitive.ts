// A map that is null, undefined or a primitive.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const maps: any[] = [null, undefined, 1, "ab", true, "", 10n];
for (const map of maps) {
  const o: any = JSON.parse("{}");
  try {
    const same = Object.defineProperties(o, map);
    console.log(String(map), "no throw", same === o, Object.keys(o).length);
  } catch (e) { console.log(String(map), msg(e)); }
}

export {};
