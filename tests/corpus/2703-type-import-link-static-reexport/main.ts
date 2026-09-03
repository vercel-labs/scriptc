// @exit: 1
// The same runtime-export check follows an aliased type-only re-export. The
// failure belongs to this re-export request, before the importing entry runs.
import { value, RenamedShape } from "./middle.ts";

console.log("never runs", value);
