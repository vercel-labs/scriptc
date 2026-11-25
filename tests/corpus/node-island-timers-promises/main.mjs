// @requires-libnode
// timers/promises on both sides: the program awaits the island's timer
// promises (a value, an immediate, an aborted one), island code awaits the
// program's, and both keep one order.
import { setImmediate as soon, setTimeout as sleep } from "node:timers/promises";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

async function main() {
  log(`island sleep: ${await lib.sleep(5, "five")}`);
  log(`island immediate: ${await lib.soon("soon")}`);
  log(await lib.awaitNative(sleep(5, "native five"), "a native sleep"));
  log(await lib.awaitNative(soon("native soon"), "a native immediate"));

  const order = [];
  await Promise.all([
    lib.sleep(100, "island 100").then((v) => order.push(v)),
    sleep(50, "native 50").then((v) => order.push(v)),
    lib.sleep(150, "island 150").then((v) => order.push(v)),
    sleep(200, "native 200").then((v) => order.push(v)),
  ]);
  log(order.join(", "));

  const pending = lib.abortable(1000);
  setTimeout(() => pending.abort(), 5);
  try {
    await pending.promise;
  } catch (e) {
    log(`${e.name} ${e.code}`);
  }
  log(`island interval: ${await lib.ticks(3, 3)}`);
  log("end");
}

main();
