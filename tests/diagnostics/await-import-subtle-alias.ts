// An awaited initializer keeps its ordinary lane: a const alias would emit
// no code and drop the import's microtask hop.
import * as crypto from "node:crypto";

const s = (await import("node:crypto")).subtle;
console.log(typeof s);
void crypto;
