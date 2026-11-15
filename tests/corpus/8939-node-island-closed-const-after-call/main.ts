// @requires-libnode
// Island-closed constants that read state the program's own island calls
// change. The first is declared before any call: its value is the one the
// build's probe computed. The others are declared after calls that started
// Node, so they evaluate where they are declared and see those calls.
import { registry } from "reg-kit";

const empty: number = registry.count();
console.log("empty", empty);
registry.add("x");
const one: number = registry.count();
registry.add("y");
const both: string = registry.list();
console.log(one, both, registry.count());
