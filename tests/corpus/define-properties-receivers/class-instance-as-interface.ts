// A class instance behind an interface it implements.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }

interface Base { readonly label: string }
interface Wide extends Base { readonly n: number }
class Impl implements Base { get label(): string { return "impl"; } }
try {
  const base: Base = new Impl();
  const wide = Object.defineProperties(base as Wide, { n: { value: 4, enumerable: true } });
  console.log(wide === base, wide.label, wide.n, Object.keys(wide).join(","));
} catch (e) { console.log("failed:", msg(e)); }

export {};
