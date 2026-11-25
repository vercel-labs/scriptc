// @requires-libnode
// Reflect.construct with a Node-island value as newTarget. Island objects
// cross the boundary as handles, not native function boxes; a
// non-constructor island object must raise Node's catchable TypeError
// instead of reaching the handle's bridge reference.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

function target(this: any): void {
  this.value = 1;
}

let caught = false;
try {
  Reflect.construct(target, [], lib as any);
} catch (error) {
  caught = error instanceof Error;
}
console.log("caught", caught);
