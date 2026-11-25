// @requires-libnode
// Large writes from both sides immediately followed by process.exit(0) in
// island code: nothing is lost, and exit listeners can still write.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

lib.onExit();
process.on("exit", () => {
  console.log("native exit listener writes");
  process.stderr.write("native exit listener stderr\n");
});
process.stdout.write("N".repeat(20000) + "\n");
lib.big("I", 20000);
console.log("last native line");
lib.big("i", 5000);
lib.exit(0);
