// @requires-libnode
// Island-closed constants the program uses: the island evaluates their
// initializers in source order (the serial numbers), a later constant holds
// the earlier one it names, not a copy, and the values the program reads are
// the island's.
import { describe, Kit, Shape } from "shape-kit";

const id = Kit.text({ label: "id" });
const item = Kit.record({ id, count: Kit.number({ min: 1, max: 9 }) });
const items = (Kit.list(item) as Shape)!;
const plain = Kit.text();

console.log("start");
console.log(describe(items), describe(plain));
console.log(items.kind, id.serial, item.serial, items.serial, plain.serial);
console.log(items.item === item, items instanceof Shape);
console.log("made", Kit.made());
