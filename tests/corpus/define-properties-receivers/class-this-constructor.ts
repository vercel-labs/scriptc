// A constructor's `this`, for members the class only declares.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }

class Holder {
  declare readonly id: string;
  declare readonly upper: string;
  constructor(id: string) {
    Object.defineProperties(this, {
      id: { value: id, enumerable: true },
      upper: { get: () => id.toUpperCase() },
    });
  }
}
try {
  const h = new Holder("abc");
  console.log(h.id, h.upper, Object.keys(h).join(","), JSON.stringify(h));
} catch (e) { console.log("failed:", msg(e)); }

export {};
