// The project marks TypeScript modules to run in a Node island. Node runs
// TypeScript by erasing what is written as a type, so a binding that names
// only a type without `type` stays: the default import and the re-export do
// not exist in the module they name, and the local export and the default
// export name nothing. Each is SC8006 at build time instead of a
// SyntaxError or a ReferenceError when Node loads the island. The last
// module writes the same bindings as types and is accepted.
import { area } from "./default-import.ts";
import { scaled } from "./default-beside-named.ts";
import { unit } from "./reexport.ts";
import { double } from "./export-local.ts";
import { sides } from "./export-default.ts";
import { perimeter } from "./written-as-types.ts";

console.log(
  area({ w: 2, h: 3 }),
  scaled({ w: 2, h: 3 }),
  unit,
  double({ n: 4 }),
  sides({ sides: 3 }),
  perimeter({ w: 2, h: 3 }),
);
