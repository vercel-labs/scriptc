// @exit: 3
// @requires-libnode
// A program that exits before it uses its island-closed constants: their
// generated module never evaluates, Node never starts, and the exit
// listeners and the exit status are the program's.
import { describe, Kit } from "shape-kit";

const shape = Kit.record({ id: Kit.text(), size: Kit.number({ min: 1 }) });

process.on("exit", (code) => console.log("exit listener", code, typeof shape));
console.log("start");
if (process.argv.length < 100) process.exit(3);
console.log(describe(shape));
