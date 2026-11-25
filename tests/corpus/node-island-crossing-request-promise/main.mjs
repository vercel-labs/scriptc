// @requires-libnode
// A request promise from an island (a Promise subclass with its own
// methods and a `then` that starts the request): the program calls its
// methods, reads and writes its members, and awaits it. Nothing starts the
// request until something waits for it.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (...a) => console.log(...a);

const held = lib.create({ id: 1 });
log("held", held.pending, typeof held.asResponse, typeof held.then, lib.isRequest(held), `[${lib.log()}]`);
const response = await held.asResponse();
log("asResponse", response.status, response.body, held.pending, `[${lib.log()}]`);
const both = await lib.create({ id: 2 }).withResponse();
log("withResponse", both.data.id, both.response.status, `[${lib.log()}]`);
log("awaited", (await lib.create({ id: 3 })).id, `[${lib.log()}]`);
log("awaited again", (await held).id, `[${lib.log()}]`);

const r = lib.create("x");
log("retry", r.retry() === r, r.retries, lib.retries(r));
r.retries = 5;
r.note = "from the program";
log("written", r.retries, lib.retries(r), r.note, "note" in r, "missing" in r);
const name = "withResponse";
log("computed", (await r[name]()).data);

try {
  await lib.failing("request failed").asResponse();
} catch (e) {
  log("asResponse rejected", e.message);
}
try {
  await lib.failing("await failed");
} catch (e) {
  log("await rejected", e.message);
}
log("then", await lib.create(20).then((v) => v + 1), "catch", await lib.failing("caught").catch((e) => e.message));
try {
  lib.create(1).missing();
} catch (e) {
  log("missing method", e instanceof TypeError);
}
const unstarted = lib.create("never awaited", 1);
await new Promise((resolve) => setTimeout(resolve, 10));
log("unstarted", unstarted.pending, `[${lib.log()}]`);
