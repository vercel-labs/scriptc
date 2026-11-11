// The marker is imported from @scriptc/types, but the project resolves that
// specifier to a module of its own. The contract cannot be followed, so it
// is reported instead of compiling as if the annotation were absent, for a
// named import and for a namespace import alike.
import type { Immutable } from "@scriptc/types";
import type * as Package from "@scriptc/types";

const ROWS: Immutable<number[]> = [1, 2];
(ROWS as number[]).push(3);
const TAGS: Package.Immutable<string[]> = ["a"];
(TAGS as string[]).push("b");
console.log(ROWS.length, TAGS.length);
