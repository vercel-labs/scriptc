// @requires-libnode
// Writes to an island Promise subclass held in untyped code: each one lands
// on the island object, so the island code and the class's own methods see it.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const r = lib.request("/a", "done");
r.attempts = 5;
console.log(r.attempts, lib.read(r, "attempts"), r.describe());
const key = "url";
r[key] = "/b";
console.log(r.url, lib.read(r, "url"), r.label);
r.note = "added";
console.log(r.note, lib.read(r, "note"), lib.has(r, "note"), "note" in r);
r.retry();
console.log(r.attempts, lib.read(r, "attempts"));
console.log(await r);
