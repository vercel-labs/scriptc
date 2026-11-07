// A module-level constant whose island call opens a file for writing,
// which creates it. The island evaluates the initializer, and the build
// probes it to decide whether it can wait; the probe must not create the
// file for the program.
import { existsSync } from "node:fs";
import { touch } from "touch-kit";

const touched: string = touch("scriptc-closed-init-effects-open.stamp");
console.log("touched", existsSync(touched));
