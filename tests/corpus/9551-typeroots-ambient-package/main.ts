// @requires-libnode
// An untyped npm package that the project types itself, with an ambient
// module declaration in a directory its tsconfig names in `typeRoots` and
// `include`. The namespace import of a typed CommonJS package makes the
// build decide an island and load the program again: every load reads the
// project's declarations.
import tinyLines from "tiny-lines";
import * as termCodes from "term-codes";

const rows = tinyLines.parse('{"a":1}\n{"a":2}\n');
console.log(rows.length, (rows[1] as { a: number }).a, JSON.stringify(termCodes.eraseLine));
