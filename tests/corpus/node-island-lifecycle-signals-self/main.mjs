// @requires-libnode
// SIGINT and SIGTERM listeners on both sides, the signal sent by the process
// to itself from native and from island code: all listeners run in
// registration order and the process survives; after the last listener is
// removed the default action applies again (checked in e11).
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on("SIGUSR1", () => log("usr1"));
process.on("SIGUSR2", () => log("usr2"));

async function main() {
  for (const sig of ["SIGINT", "SIGTERM"]) {
    const native = (name, number) => log(`native ${name} ${typeof number}`);
    process.on(sig, native);
    lib.on(sig, "b");
    lib.once(sig, "once");
    process.kill(process.pid, sig);
    await sleep(30);
    lib.kill(sig);
    await sleep(30);
    process.removeListener(sig, native);
    lib.off(sig, "b");
    process.kill(process.pid, sig === "SIGINT" ? "SIGUSR2" : "SIGUSR1");
    await sleep(10);
  }
  log("done");
}

main();
