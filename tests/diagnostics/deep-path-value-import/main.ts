// A value import of a file the package's exports map does not list. Under
// `moduleResolution: node` the project's tsc reads the file by path and
// passes; Node resolves the import at run time, with the map, and refuses
// the program. The build follows Node.
import { run } from "shapes-kit/dist/cli.mjs";
import * as termCodes from "term-codes";

console.log(run("draw"), JSON.stringify(termCodes.eraseLine));
