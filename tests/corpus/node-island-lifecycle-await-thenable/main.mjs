// @requires-libnode
// Awaiting an island object that has a then method (a query builder, a
// lazy request): await calls then, as for any thenable; a then that
// rejects throws at the await; an island object without a then method, and
// one whose then is not callable, are themselves.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
console.log(await lib.thenable(1));
console.log(await lib.lazy(2));
console.log(await lib.query(21));
try {
  await lib.rejecting("thenable rejected");
} catch (e) {
  console.log("caught", e.message);
}
const plain = lib.plain();
console.log((await plain) === plain, (await lib.notCallable()).then);
try {
  await lib.throwingGetter();
} catch (e) {
  console.log("caught", e.message);
}
async function inOrder() {
  Promise.resolve().then(() => console.log("job queued before the await"));
  console.log(await lib.thenable("after"));
}
await inOrder();
