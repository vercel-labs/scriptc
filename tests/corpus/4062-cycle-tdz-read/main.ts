// Reading or writing a let/const binding of an import cycle before its
// declaration ran throws ReferenceError, exactly as Node reports it; the
// same reads succeed once the declaration ran.
import { limit, used, probe } from "./limits.ts";

console.log("main", limit, used, probe());
