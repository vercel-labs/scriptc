// URL.createObjectURL and revokeObjectURL past the typed surface: any
// value that is not a Blob or File is Node's ERR_INVALID_ARG_TYPE naming
// "obj" (a no-argument call receives undefined), surplus arguments are
// evaluated and dropped, and revoke coerces its argument (a Symbol throws
// the ToString TypeError) before an exact-id lookup.
"use strict";

for (const value of [undefined, null, 5, true, "blob:x", {}, [1], () => {}, Symbol("s"), 10n, Object.create(null)]) {
  try {
    URL.createObjectURL(value);
    console.log("accepted", typeof value);
  } catch (e) {
    console.log(e.name, e.code, e.message);
  }
}

let calls = 0;
function tick() {
  calls++;
  return "surplus";
}
const id = URL.createObjectURL(new Blob(["ok"]), tick(), tick());
console.log("surplus", calls, id.startsWith("blob:nodedata:"), id.length);

try {
  URL.createObjectURL();
} catch (e) {
  console.log("none", e.name, e.code, e.message);
}

for (const value of [123, null, true, "blob:nodedata:never-registered"]) {
  URL.revokeObjectURL(value);
}
try {
  URL.revokeObjectURL(Symbol("s"));
} catch (e) {
  console.log("symbol", e.name, e.code, e.message);
}
try {
  URL.revokeObjectURL();
} catch (e) {
  console.log("revoke-none", e.name, e.code, e.message);
}
console.log("done");
