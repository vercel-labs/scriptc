// A TypeScript namespace import of a CommonJS module of the program reads
// the members Node's lexer detects, as a JavaScript importer does.
import * as lib from "./lib.cjs";

console.log(lib.answer);
console.log(lib.greet("world"));
console.log(lib.config.mode, lib.config.depth);
console.log(typeof lib.greet);
