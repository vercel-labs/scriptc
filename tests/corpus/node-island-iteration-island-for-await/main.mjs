// @requires-libnode
// Island for await over a native async generator: to completion, an early
// break, a throw from the loop body, manual next/return calls; and a native
// sync generator under an island for-of.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

async function* nativeGen(n) {
  try {
    for (let i = 0; i < n; i++) {
      log(`native yields ${i}`);
      const sent = yield i;
      if (sent !== undefined) log(`native received ${sent}`);
      await null;
    }
    return "native done";
  } finally {
    log("native generator finally");
  }
}
function* nativeSync() {
  try {
    yield 1;
    yield 2;
    yield 3;
  } finally {
    log("native sync generator finally");
  }
}

async function main() {
  log(await lib.consume(nativeGen(3), -1));
  log("-- break");
  log(await lib.consume(nativeGen(5), 1));
  log("-- throw");
  log(await lib.consumeThrow(nativeGen(5), 2));
  log("-- manual");
  log(await lib.manual(nativeGen(5)));
  log("-- sync");
  log(lib.consumeSync(nativeSync()));
  log("end");
}

main();
