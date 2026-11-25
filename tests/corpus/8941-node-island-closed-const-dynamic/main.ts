// @requires-libnode
// Island-closed constants of a module the program imports dynamically. The
// program can reach that module at any point of its run, so its constants
// are not deferred behind a snapshot: their generated module evaluates
// where the constants are declared, when the import runs.
import { describe, Kit } from "shape-kit";

const first = Kit.text({ label: "first" });
console.log("start", typeof first);
Kit.number();
const lazy = await import("./lazy.ts");
console.log(describe(lazy.shape), first.serial, lazy.shape.serial, lazy.inner.serial);
