// The project keeps declarations for a package that ships none, but in a
// directory its tsconfig lists neither under `typeRoots` nor under
// `include`. The project's tsc never reads them, and no load of the build
// does either.
import { scale } from "pantry-units";
import * as oven from "oven-dial";

console.log(scale([1, 2], 2).length, oven.gasMark(180));
