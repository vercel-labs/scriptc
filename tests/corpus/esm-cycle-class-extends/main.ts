// @exit: 1
// A class statement's `extends` clause reads its base when the statement
// runs: in an import cycle whose member reaches this class before its own
// declaration ran, the read is a temporal-dead-zone ReferenceError.
import { started } from "./events.ts";

console.log("main never runs", started);
