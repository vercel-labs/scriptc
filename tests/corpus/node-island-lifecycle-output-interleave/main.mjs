// @requires-libnode
// console.log and process.stdout.write from both sides,
// strictly alternating, on stdout and stderr: bytes appear in call order.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

for (let i = 0; i < 300; i++) {
  console.log(`n-log ${i}`);
  lib.log(`i-log ${i}`);
  process.stdout.write(`n-write ${i}\n`);
  lib.write(`i-write ${i}\n`);
  console.error(`n-err ${i}`);
  lib.err(`i-err ${i}`);
  process.stderr.write(`n-errw ${i}\n`);
  lib.errWrite(`i-errw ${i}\n`);
  console.info(`n-info ${i}`);
  lib.info(`i-info ${i}`);
  console.warn(`n-warn ${i}`);
  lib.warn(`i-warn ${i}`);
}
// Partial lines joined across the sides.
process.stdout.write("a");
lib.write("b");
process.stdout.write("c");
lib.write("d\n");
