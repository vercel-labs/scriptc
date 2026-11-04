// @requires-libnode
// A module that patches a builtin module's CommonJS export (the photon
// idiom): loader.ts replaces fs.readFileSync while a package loads, so the
// package's own require("fs").readFileSync finds a payload that is not at
// its default path. Because it patches a builtin, loader.ts runs in a Node
// island automatically and shares Node's one fs with the package; the
// entry stays native. Its named import of readFileSync is not patched:
// Node's ES module bindings of builtins do not follow CommonJS patches.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPayload } from "./loader.ts";

const here = dirname(fileURLToPath(import.meta.url));
const result = await loadPayload();
console.log("package read:", result.text);
console.log("calls through the patch:", result.patchedCalls);
console.log("restored:", result.restored);
console.log("native read:", readFileSync(join(here, "fallback", "payload.txt"), "utf8").trim());
