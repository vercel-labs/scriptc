// An object literal of getters returned at its interface, asserted to a wider one and widened in place.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }

interface Base { readonly label: string; readonly depth: number }
interface Wide extends Base { readonly items: string[]; run(name: string): string }
let level = 2;
function make(): Base {
  return { get label() { return "context"; }, get depth() { return level; } };
}
function widen(id: string): Wide {
  return Object.defineProperties(make() as Wide, {
    items: { get() { return ["a", "b"]; } },
    run: { value: (name: string) => id + "/" + name },
  });
}
try {
  const wide = widen("call_1");
  level = 3;
  console.log(wide.label, wide.depth, wide.items.join(","), wide.run("x"));
  console.log(Object.keys(wide).join(","), "items" in wide, typeof wide.run);
} catch (e) { console.log("failed:", msg(e)); }

export {};
