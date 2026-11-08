// The ambient module re-exports a file of a package that is not installed:
// the project's tsc reports the member as missing, and so does the build.
import { run } from "ghost-kit/cli";
import * as termCodes from "term-codes";

console.log(run("draw"), JSON.stringify(termCodes.eraseLine));
