// An import that runs names a file the package's `exports` map does not
// list. The project's tsc, under `moduleResolution: node`, reads the file
// by its path and is satisfied; Node resolves the import when the program
// starts, through the map, and refuses it. The build sides with Node.
import { blend } from "spice-rack/lib/blends.mjs";
import * as oven from "oven-dial";

console.log(blend("garam").parts, oven.gasMark(180));
