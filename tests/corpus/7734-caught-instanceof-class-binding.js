// A catch binding tested against a class held by a binding (var/const class expression),
// as hono's SmartRouter tests UnsupportedPathError.
var UnsupportedPathError = class extends Error {};
class Strict {
  add(p) { if (p.includes("*")) throw new UnsupportedPathError(); return p; }
}
class Loose { add(p) { return "loose " + p; } }
function pick(p) {
  const routers = [new Strict(), new Loose()];
  for (const r of routers) {
    try {
      return r.add(p);
    } catch (e) {
      if (e instanceof UnsupportedPathError) continue;
      throw e;
    }
  }
}
console.log(pick("/a"), pick("/b/*"));
try { throw new Error("x"); } catch (e) { console.log(e instanceof UnsupportedPathError, e instanceof Error); }
const u = new UnsupportedPathError("m");
console.log(u instanceof UnsupportedPathError, u.message, u.name, u instanceof Error);

// A binding that holds a subclass of the class it was declared with: the
// test reads the class the binding holds at run time.
class BaseError extends Error {}
class DerivedError extends BaseError {}
class LeafError extends DerivedError {}
var Current = BaseError;
function caughtIs(value) {
  try {
    throw value;
  } catch (e) {
    return e instanceof Current;
  }
}
const samples = () => [new BaseError("b"), new DerivedError("d"), new LeafError("l"), new Error("e"), "text"];
console.log("base", samples().map(caughtIs).join(","));
Current = DerivedError;
console.log("derived", samples().map(caughtIs).join(","));
Current = LeafError;
console.log("leaf", samples().map(caughtIs).join(","));
