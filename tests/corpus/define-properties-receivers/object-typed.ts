// A receiver typed `object` and `{}`.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }

try {
  const o: object = { a: 1 };
  const same = Object.defineProperties(o, { b: { value: 2, enumerable: true } });
  console.log(same === o, Object.keys(o).join(","), JSON.stringify(o));
} catch (e) { console.log("failed:", msg(e)); }
try {
  const o: {} = { a: 1 };
  const wide = Object.defineProperties(o, { b: { value: 2, enumerable: true } }) as { a: number; b: number };
  console.log(wide.a, wide.b, JSON.stringify(wide));
} catch (e) { console.log("failed:", msg(e)); }

export {};
