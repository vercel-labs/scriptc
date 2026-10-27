import * as shapes from "./shapes.js";
import * as extra from "./extra.js";
// A namespace spread into an untyped object (zod's local
// `const z = { ..._schemas, ..._checks, iso: _iso }`).
function untyped(value) {
  return value;
}
const z = untyped({ ...shapes, ...extra, extra });
console.log(Object.keys(z).join(","));
for (const key of ["circle", "square"]) console.log(key, z[key](2).area.toFixed(2));
console.log(z.VERSION, typeof z.extra.tag, z.extra.tag("x"), new z.Box(4).size);
// A namespace with star re-exports holds the re-exported members too.
import * as all from "./all.js";
const w = untyped({ ...all });
console.log(Object.keys(w).join(","), w.circle(1).area.toFixed(2), w.own, new w.Box(2).size);
for (const key of ["circle", "own", "VERSION", "missing"]) console.log(key, typeof all[key]);
