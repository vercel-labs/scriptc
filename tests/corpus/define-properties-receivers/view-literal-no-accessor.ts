// A view type whose value is a record in one branch and a literal of getters in the other.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }

interface Box { readonly size: number; label: string }
interface Wide extends Box { readonly extra: string }
function make(n: number): Box { return n > 0 ? { get size() { return n; }, label: "g" } : { size: 0, label: "plain" }; }
try {
  const plain = Object.defineProperties(make(0) as Wide, { extra: { get() { return "x"; }, enumerable: true } });
  const live = Object.defineProperties(make(3) as Wide, { extra: { value: "y" } });
  plain.label = "changed";
  console.log(plain.size, plain.label, plain.extra, Object.keys(plain).join(","));
  console.log(live.size, live.label, live.extra, Object.keys(live).join(","));
} catch (e) { console.log("failed:", msg(e)); }

export {};
