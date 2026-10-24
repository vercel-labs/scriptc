// A package that probes for optional files through createRequire with
// computed specifiers. A specifier that names no file throws Node's error,
// so the package takes its absent branch as in Node.
import { probeAddon, requireErrors } from "optional-probe";

console.log(probeAddon("clipboard"));
for (const line of requireErrors()) console.log(line);
