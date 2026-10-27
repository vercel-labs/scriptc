// Exports whose names start with "__": named imports of a const, a function,
// a class and a live let, a name with three underscores, aliased re-exports,
// names reached through `export *`, namespace member reads and keys, and
// CommonJS exports read through require.
import { __x, ___y, __count, __bump, __Point, plain } from "./dep.ts";
import { __alias, renamed, __starred, __twice } from "./facade.ts";
import * as facade from "./facade.ts";
import * as depNs from "./dep.ts";
import { createRequire } from "node:module";

console.log(__x, ___y, plain);
console.log(__count, __bump(), __bump(), __count);
console.log(new __Point(2, 3).sum());
console.log(__alias, renamed, __starred, __twice(21));
console.log(facade.__x, facade.__starred, facade.__twice(2));
console.log(Object.keys(depNs).join(","));

const require = createRequire(import.meta.url);
const table = require("./table.cjs");
console.log(table.__a, table.__hello("dunder"), table.b);
