// @exit: 2
// @requires-libnode
// The same with the native side calling process.exit(2) from inside a
// native callback an island timer runs.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

lib.later(() => {
  process.stdout.write("N".repeat(20000) + "\n");
  lib.big("I", 20000);
  console.log("last line before exit");
  process.exit(2);
});
