// @exit: 1
// A cycle member's top level reads a const of the module that imported
// it before that module's body ran: Node throws an uncaught
// ReferenceError there, after the earlier output.
import { width } from "./frame.ts";

console.log("main never runs", width);
