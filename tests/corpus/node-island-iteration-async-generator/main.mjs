// @requires-libnode
// Native for await over an island async generator: to completion, an early
// break (the generator's finally runs) and a throw from the loop body.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

async function main() {
  for await (const v of lib.gen(3)) log(`native got ${v}`);
  log("-- break");
  for await (const v of lib.gen(5)) {
    log(`native got ${v}`);
    if (v === 1) break;
  }
  log("-- throw");
  try {
    for await (const v of lib.gen(5)) {
      if (v === 1) throw new Error("native loop body threw");
    }
  } catch (e) {
    log(`caught ${e.message}`);
  }
  log("end");
}

main();
