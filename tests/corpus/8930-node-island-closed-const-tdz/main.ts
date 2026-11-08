// @requires-libnode
// A function that reads an island-closed constant before its declaration
// ran: the constant is still the module's own binding, so the read throws
// the temporal-dead-zone ReferenceError, as in Node, and works afterwards.
import { describe, Kit } from "shape-kit";

function early(): string {
  return describe(late);
}

try {
  console.log(early());
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
const late = Kit.text({ label: "late" });
console.log(early());
