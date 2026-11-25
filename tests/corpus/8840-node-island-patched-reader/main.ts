// @requires-libnode
// A user module that reads a builtin member another module patches joins the
// Node island set, like an npm reader: it shares the island's fs with the
// patch, so the read sees it exactly as in Node. The entry's ES import of the
// same member is not patched (Node's ES module bindings of builtins do not
// follow CommonJS patches), so the entry stays native and reads natively.
import { readFileSync } from "node:fs";
import { installPatch } from "./patch.ts";
import { readThroughRequire } from "./read.ts";

installPatch();
console.log("reader:", readThroughRequire());
let outcome = "none";
try {
  readFileSync("/scriptc/does/not/exist", "utf-8");
} catch (error) {
  outcome = (error as { code?: unknown }).code === "ENOENT" ? "ENOENT" : "other";
}
console.log("entry read:", outcome);
