// An Error instance: the properties its view shares with the native error.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const err = new Error("boom");
try {
  const same = Object.defineProperties(err, { message: { value: "changed" }, cause: { value: "why" } });
  console.log(same === err, err.message, String(err.cause));
} catch (e) { console.log("error:", msg(e)); }

export {};
