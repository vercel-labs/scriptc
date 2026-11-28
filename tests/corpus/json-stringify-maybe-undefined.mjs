// The JavaScript lane of the maybe-undefined JSON.stringify cases: a
// library result typed `CipherInfo | undefined`, an untyped parameter, and
// a ternary over both, which used to throw scriptc's union TypeError at run
// time although Node answers undefined.
import * as crypto from "node:crypto";

const show = (label, f) => {
  try {
    const v = f();
    console.log(label, typeof v === "string" ? v : JSON.stringify(v));
  } catch (e) {
    console.log(label, "THROW", e.name, e.code, e.message);
  }
};

show("cipher", () => crypto.getCipherInfo("aes-256-cbc"));
show("filtered", () => crypto.getCipherInfo("aes-256-cbc", { keyLength: 16 }));
show("by iv", () => crypto.getCipherInfo("aes-128-cbc", { ivLength: 16 }));
show("unknown", () => crypto.getCipherInfo("nope"));

function f(x) {
  return JSON.stringify(x);
}
console.log("untyped undefined", f(undefined));
console.log("untyped record", f({ a: 1 }));
function g(x) {
  return typeof x === "string" ? x : JSON.stringify(x);
}
console.log("untyped ternary", g(undefined));
console.log("bare", JSON.stringify(undefined));
