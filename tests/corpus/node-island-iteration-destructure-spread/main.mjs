// @requires-libnode
// Destructuring and spread from island iterables: a pattern takes as many
// values as it has elements and then closes the iterator; a rest element
// and a spread take them all.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

const [a, b] = lib.count("two", 5);
log(`a=${a} b=${b}`);

const [first] = lib.forever();
log(`first=${first}`);

const [head, ...rest] = lib.count("rest", 3);
log(`head=${head} rest=${rest.join(",")}`);

const [p, q, r, s] = lib.count("short", 2);
log(`${p} ${q} ${r} ${s}`);

const [, second] = lib.set();
log(`second=${second}`);

log("-- spread");
const all = [...lib.count("spread", 3)];
log(`all=${all.join(",")} length ${all.length}`);
log(`set=${[...lib.set()].join("")}`);
log(`sum=${lib.sum(...lib.count("args", 4))}`);
log(`max=${Math.max(...lib.count("max", 3))}`);

log("-- consumers");
log(`from=${Array.from(lib.count("from", 3)).join(",")}`);
log(`set size ${new Set(lib.count("toSet", 3)).size}`);
const m = new Map(lib.set().entries());
log(`map size ${m.size}`);
log("end");
