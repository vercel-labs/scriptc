// @requires-libnode
// A chain of island-closed constants across two modules: the generated
// module of this file's constant imports the one of shapes.ts, so `table`
// holds the very `row` the other module exports.
import { describe, Kit } from "shape-kit";
import { id, row } from "./shapes.ts";

const table = Kit.list(row);
export const pair = Kit.record({ first: id, second: table });

console.log(describe(pair));
console.log(table.item === row, id.serial, row.serial, table.serial, pair.serial);
