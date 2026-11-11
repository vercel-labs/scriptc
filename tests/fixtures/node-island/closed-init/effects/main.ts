// A module-level constant whose island call writes a file. The island
// evaluates the initializer, and the build probes it to decide whether it
// can wait; the probe must not write the file for the program.
import { existsSync } from "node:fs";
import { stamp } from "stamp-kit";

const written: string = stamp("scriptc-closed-init-effects.stamp");
console.log("stamped", existsSync(written));
