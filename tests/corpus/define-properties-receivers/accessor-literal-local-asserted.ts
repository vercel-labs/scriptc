// An object literal of getters bound to its interface, asserted wider at the call.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }

interface Base { readonly label: string }
interface Wide extends Base { readonly n: number; twice(): number }
try {
  const base: Base = { get label() { return "L"; } };
  const wide = Object.defineProperties(base as Wide, {
    n: { value: 4, enumerable: true },
    twice: { value(this: Wide) { return this.n * 2; } },
  });
  console.log(wide === base, wide.label, wide.n, wide.twice(), Object.keys(wide).join(","));
} catch (e) { console.log("failed:", msg(e)); }

export {};
