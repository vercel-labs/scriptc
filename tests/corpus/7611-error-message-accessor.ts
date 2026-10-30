// An accessor defined over an Error subclass instance's own `message`
// (zod 4's lazy error message): typed reads and writes, String(), and
// reads through an untyped alias all go through the accessor, and a later
// data definition replaces it.
class E extends Error {}
const e = new E("orig");
let store = "lazy";
let reads = 0;
Object.defineProperty(e, "message", {
  get() {
    reads++;
    return store;
  },
  set(value: string) {
    store = `set:${value}`;
  },
  enumerable: true,
  configurable: true,
});
console.log(e.message, String(e), reads);
e.message = "typed";
console.log(e.message, store);
const loose: any = e;
console.log(loose.message);
loose.message = "loose";
console.log(e.message, Object.keys(e).join());
const desc = Object.getOwnPropertyDescriptor(e, "message")!;
console.log(typeof desc.get, typeof desc.set, desc.enumerable);
Object.defineProperty(e, "message", { value: "data", writable: true, configurable: true });
console.log(e.message, String(e), reads);
e.message = "after";
console.log(e.message, store);

class Named extends Error {}
const n = new Named("m");
const loosen: any = n;
Object.defineProperty(loosen, "name", { get() { return "Custom"; }, configurable: true });
console.log(n.name, String(n));

class Plain extends Error {}
const p = new Plain("kept");
p.message = "changed";
console.log(p.message, String(p));
