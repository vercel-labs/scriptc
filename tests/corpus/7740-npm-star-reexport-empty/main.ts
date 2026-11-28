// An esbuild-style CommonJS package whose export table star-re-exports a
// types-only JS stub (dist/types.js exports nothing). The stub must not
// widen the export object to any: the imported name keeps its declaration
// and the program prints the same list length as Node.
import { list } from "star-kit";
console.log(list.length, list[1]);
