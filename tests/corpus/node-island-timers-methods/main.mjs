// @requires-libnode
// The program drives an island's Timeout and Immediate through the object:
// hasRef, unref, ref, refresh, close and the primitive id.
// The process ends although an unref'd island interval is still armed.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

const t = lib.timeout(200, "refreshed");
log(`hasRef ${t.hasRef()}`);
log(`unref returns the timer ${t.unref() === t}`);
log(`hasRef ${t.hasRef()} island agrees ${lib.hasRef(t) === false}`);
log(`ref returns the timer ${t.ref() === t} hasRef ${t.hasRef()}`);
setTimeout(() => {
  log("refresh");
  t.refresh();
}, 60);
setTimeout(() => log("native timer"), 150);

const closed = lib.timeout(10, "NOT REACHED closed");
log(`close returns the timer ${closed.close() === closed}`);

// An island timer's primitive id is Node's: a number the island's own
// clearTimeout accepts.
const byId = lib.timeout(10, "NOT REACHED cleared by its id");
const id = Number(byId);
log(`id is a ${typeof id}, ${id === +byId}`);
lib.clearById(id);

const immediate = lib.immediate("runs");
log(`immediate hasRef ${immediate.hasRef()}`);
immediate.unref();
log(`immediate hasRef ${immediate.hasRef()}`);
immediate.ref();

const background = lib.interval(1000, "NOT REACHED background");
background.unref();
log(`background hasRef ${background.hasRef()}`);
setTimeout(() => log("end"), 400);
