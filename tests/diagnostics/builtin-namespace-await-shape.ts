// Awaiting a value answers that value unless it is a promise. A promise typed
// `Promise<typeof import("node:fs")>` may resolve to an ES module namespace
// object (a dynamic import) or to the CommonJS exports object (a require
// call), so its type does not fix the shape of the value the reflection sees.
// Reflection over it is refused rather than answering for one shape.
import type * as NodeFs from "node:fs";

declare const p: Promise<typeof NodeFs>;
console.log(Object.keys(await p).length);
console.log("readFileSync" in (await p));
