// @requires-libnode
// An island class that extends Promise, held in untyped code: the members
// the class adds are read from the island object, and the promise is
// awaited and chained as a promise.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const r = lib.request("/a", { n: 1 });
console.log(r.label, typeof r.label, r.url, r.attempts);
console.log(typeof r.then, typeof r.catch, typeof r.finally, typeof r.withResponse, typeof r.describe, r.missing);
console.log("url" in r, "label" in r, "missing" in r, "then" in r, lib.isRequest(r), r instanceof Promise);
const key = "label";
console.log(r[key], lib.attempts(r));
console.log(JSON.stringify(await r));
try {
  await lib.failing("/b");
} catch (e) {
  console.log("caught", e.message);
}
const f = lib.failing("/c");
console.log(f.label);
console.log(await f.then(() => "resolved", (e) => `handled ${e.message}`));
