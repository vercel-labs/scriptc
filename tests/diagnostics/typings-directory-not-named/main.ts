// The project's declarations for an untyped package sit in a directory its
// tsconfig names neither in `typeRoots` nor in `include`: the project's tsc
// does not read them, and neither does any load of the build.
import tinyLines from "tiny-lines";
import * as termCodes from "term-codes";

const rows = tinyLines.parse('{"a":1}\n{"a":2}\n');
console.log(rows.length, JSON.stringify(termCodes.eraseLine));
