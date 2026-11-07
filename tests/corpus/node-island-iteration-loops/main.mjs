// @requires-libnode
// for...of over island iterables from JavaScript: each step runs the island
// iterator once, and break, return and a throw in the body close it (the
// island generator's finally runs, a custom iterator's return() is called).
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

for (const v of lib.count("whole", 2)) log(`native got ${v}`);

log("-- break");
for (const v of lib.count("break", 5)) {
  log(`native got ${v}`);
  if (v === 1) break;
}

log("-- endless");
let sum = 0;
for (const v of lib.forever()) {
  sum += v;
  if (v === 4) break;
}
log(`sum ${sum}`);

log("-- return");
function firstOver(limit) {
  for (const v of lib.count("return", 5)) {
    if (v > limit) return v;
  }
  return -1;
}
log(`first over 1: ${firstOver(1)}`);

log("-- throw in the body");
try {
  for (const v of lib.count("throw", 5)) {
    if (v === 1) throw new Error("native body threw");
  }
} catch (e) {
  log(`caught ${e.message}`);
}

log("-- the generator throws");
try {
  for (const v of lib.throwsAt(2)) log(`native got ${v}`);
} catch (e) {
  log(`caught ${e.name}: ${e.message}`);
}

log("-- continue and a labelled break");
outer: for (const a of lib.count("outer", 3)) {
  for (const b of lib.count("inner", 3)) {
    if (b === 0) continue;
    if (a === 1) break outer;
    log(`pair ${a} ${b}`);
    break;
  }
}

log("-- a custom iterator");
const custom = lib.custom(4);
for (const v of custom) {
  log(`native got ${v}`);
  if (v === "v1") break;
}
const calls = () => `open ${custom.calls.open} next ${custom.calls.next} return ${custom.calls.return}`;
log(calls());
for (const v of custom) log(`again ${v}`);
log(calls());

log("-- an iterator without return");
const bare = lib.noReturn(4);
for (const v of bare) {
  if (v === 1) break;
}
for (const v of bare) log(`continues at ${v}`);

log("-- collections");
for (const [k, v] of lib.map()) log(`map ${k}=${v}`);
for (const v of lib.set()) log(`set ${v}`);
for (const [k, v] of lib.entries()) log(`entry ${k} ${v.n}`);
for (const [name, n] of lib.pairs()) {
  log(`pair ${name} ${n}`);
  if (n === 2) break;
}

log("-- not iterable");
try {
  for (const v of lib.plain()) log(`never ${v}`);
} catch (e) {
  log(`${e.name}: ${e.message}`);
}
log("end");
