// A file that uses a type-only import as a value (the program's own type
// error) and has another import that tsc's elision drops: the error is
// reported where the value use stands, as for a file with nothing to drop.
import type { Box } from "./box";
import { Shape } from "./other";

const shape: Shape = { sides: 3 };
const box = new Box();
console.log(shape.sides, box.size);
