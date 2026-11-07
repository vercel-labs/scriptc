// An fs.Stats held at a structural type is the Stats itself, held by
// reference: it answers member reads and calls and lists no properties of
// its own. A type whose values the program writes through, lists the
// properties of, or hands to code that accepts any value stays a record,
// and a Stats cannot be built into one.
import { statSync } from "node:fs";

interface Written {
  size: number;
}
const written: Written = statSync(".");
written.size = 1;

interface Listed {
  isDirectory(): boolean;
}
const listed: Listed = statSync(".");
console.log(Object.keys(listed).length);

interface Loose {
  isFile(): boolean;
}
function show(value: unknown): void {
  console.log(typeof value);
}
const loose: Loose = statSync(".");
show(loose);
export {};
