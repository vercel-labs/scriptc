// `new <module>.<Class>()` over a builtin module binding constructs the same
// class a named import does: an ESM namespace and a default import here, and
// `var m = require("m")` in encode.cjs.
import * as util from "node:util";
import url from "node:url";
import { runWith } from "./encode.cjs";

console.log(new util.TextEncoder().encode("héllo").length);
console.log(new url.URL("https://example.com/path?q=1").pathname);
console.log(runWith("store", () => "ran"));
