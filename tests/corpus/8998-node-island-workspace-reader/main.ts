// @requires-libnode
// A workspace package exported as TypeScript source names no JavaScript entry
// under Node's runtime conditions, so a bare subpath import of it neither
// resolves through the runtime pass nor, without that answer, binds to the
// island module the file is. cache-warmer.ts is native and calls the island
// module's function: it must run in Node and see the patch, as it does under
// Node itself.
import { installPatch } from "./patch.ts";
import { warmCache } from "./cache-warmer.ts";

installPatch();
console.log("value:", warmCache());
console.log("again:", warmCache());
