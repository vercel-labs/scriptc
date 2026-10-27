// `new <module>.<Class>()` over a builtin module binding constructs the same
// class a named import does: ESM namespace and default imports here, and
// `var m = require("m")` in encode.cjs.
import * as util from "node:util";
import * as hooks from "node:async_hooks";
import url from "node:url";
import { encodeLength, runWith } from "./encode.cjs";

const encoder = new util.TextEncoder();
const bytes = encoder.encode("héllo");
console.log(bytes.length, new util.TextDecoder().decode(bytes), encoder.encoding);

const storage = new hooks.AsyncLocalStorage();
storage.run({ request: 1 }, () => console.log(storage.getStore().request));
console.log(storage.getStore());

const parsed = new url.URL("https://example.com/path?q=1#h");
console.log(parsed.pathname, parsed.searchParams.get("q"), new url.URLSearchParams("a=1&b=2").get("b"));

console.log(encodeLength("ünïcode"), runWith("store", () => "ran"));
