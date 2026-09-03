// @dynamic
// @exit: 1
// Dynamic islands do not change the ESM loader's instantiate contract: a
// plain import of an interface is still a missing runtime export.
import { value, Shape as MissingShape } from "./types.ts";

console.log("never runs", value);
