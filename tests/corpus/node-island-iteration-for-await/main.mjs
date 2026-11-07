// @requires-libnode
// for await over island async iterables from JavaScript: an async
// generator, a sync generator of promises, a custom async iterable, one
// that rejects, and a value that is not iterable; break, return and a
// throw in the body close the iterator.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

async function firstOver(limit) {
  for await (const v of lib.count("return", 5)) {
    if (v > limit) return v;
  }
  return -1;
}

async function main() {
  for await (const v of lib.count("whole", 2)) log(`native got ${v}`);
  log("-- break");
  for await (const v of lib.count("break", 5)) {
    log(`native got ${v}`);
    if (v === 1) break;
  }
  log("-- return");
  log(`first over 1: ${await firstOver(1)}`);
  log("-- throw in the body");
  try {
    for await (const v of lib.count("throw", 5)) {
      if (v === 1) throw new Error("native body threw");
    }
  } catch (e) {
    log(`caught ${e.message}`);
  }
  log("-- a sync generator of promises");
  for await (const v of lib.sync("sync", 3)) {
    log(`native got ${v}`);
    if (v === "sync 1") break;
  }
  log("-- rejects");
  try {
    for await (const v of lib.rejects()) log(`native got ${v}`);
  } catch (e) {
    log(`caught ${e.name}: ${e.message}`);
  }
  log("-- timers between steps");
  setTimeout(() => log("native timer"), 75);
  for await (const v of lib.slow()) log(`native got ${v}`);
  log("-- a custom async iterable");
  const custom = lib.custom(4);
  for await (const v of custom) {
    log(`native got ${v}`);
    if (v === 1) break;
  }
  log(`next ${custom.calls.next} return ${custom.calls.return}`);
  log("-- not iterable");
  const plain = lib.plain();
  try {
    for await (const v of plain) log(`never ${v}`);
  } catch (e) {
    log(`${e.name}: ${e.message}`);
  }
  log("end");
}

main();
