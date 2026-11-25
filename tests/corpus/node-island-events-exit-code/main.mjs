// @exit: 9
// @requires-libnode
// process.exitCode is one value for native and island code: each side
// reads what the other wrote, unset and 0 are told apart on both, the last
// writer decides the exit status, and the exit listeners of both sides see
// it.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

log(`unset: native ${process.exitCode} island ${lib.get()}`);
lib.set(7);
log(`island wrote 7: native ${process.exitCode} island ${lib.get()}`);
process.exitCode = 3;
log(`native wrote 3: native ${process.exitCode} island ${lib.get()}`);
lib.set(0);
log(`island wrote 0: native ${process.exitCode} island ${lib.get()}`);
lib.set(undefined);
log(`island unset: native ${process.exitCode} island ${lib.get()}`);
process.exitCode = 0;
log(`native wrote 0: native ${process.exitCode} island ${lib.get()}`);
setTimeout(() => {
  lib.set(4);
  setTimeout(() => {
    log(`in a timer: native ${process.exitCode}`);
    process.exitCode = 9;
    log(`native wrote 9: island ${lib.get()}`);
  }, 1);
}, 1);
process.on("exit", (code) => log(`native exit ${code} ${process.exitCode}`));
lib.onExit();
