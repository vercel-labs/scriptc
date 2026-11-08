// @requires-libnode
// The program ends with awaits pending across the boundary in both
// directions and each side holding the other's values: exit 0, no finally
// block runs, exit listeners run.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

(async () => {
  try {
    await lib.never();
  } finally {
    log("NOT REACHED native finally");
  }
})();
lib.awaitNever(new Promise(() => {}), log);
lib.hold(() => log("NOT REACHED held callback"));
lib.hold({ native: true, back: lib });
lib.hold(new Promise(() => {}));
const kept = [lib.never(), lib, lib.holds];
process.on("exit", (code) => log(`exit ${code} kept ${kept.length} held ${lib.holds.length}`));
log("main end");
