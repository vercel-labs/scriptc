// @requires-libnode
// `await` of a thenable reads its `then` once and calls what it read.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const once = lib.once();
const value = await once;
console.log(typeof value === "string" ? value : "the thenable itself", once.reads());
console.log(await lib.counting());
