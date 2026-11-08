// @requires-libnode
// Consecutive island-closed constants where the second one's initializer
// invokes a callback registered before both: the callback reads the first
// constant, which must already hold its value by then, as it does in Node.
import { Kit } from "shape-kit";

let seen = "";
Kit.onRead(() => {
  seen = tag;
  return tag;
});
const tag = Kit.mark("a");
const read = Kit.read();
console.log(tag, read, seen);
console.log(Kit.read(), seen);
