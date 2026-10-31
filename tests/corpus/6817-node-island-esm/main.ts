// @requires-libnode
// An ES module package scriptc refuses natively (it imports its parts
// with a computed specifier) runs in a Node island: named imports are live
// bindings, the default export and the namespace are the module's own, and
// a later import() answers the same module instance.
import greet, { count, bump, Counter, loadPart, shared, hit } from "esmisland";
import * as ns from "esmisland";

console.log(greet("island"), count);
bump();
bump();
console.log("live", count, ns.count);

const c = new Counter(5);
c.inc();
console.log(c.value, c instanceof Counter, c instanceof ns.Counter);
console.log(hit() === shared, shared.hits, ns.shared === shared);

async function main(): Promise<void> {
  const label = await loadPart("a");
  console.log(label);
  const again = await import("esmisland");
  console.log(again.count, again.shared === shared, again.Counter === Counter);
  again.bump();
  console.log("after", count);
}
void main();
