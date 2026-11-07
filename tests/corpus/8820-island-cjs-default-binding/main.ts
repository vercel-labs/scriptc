// @requires-libnode
// A CommonJS package reached through a default import binds the package's
// module.exports object, and the island that runs it hands back a handle.
// The handle is a VALUE, not a namespace: member reads and calls go through
// it, exactly as Node's module.exports object does.
import hljs from "hljs/lib/core.js";
import easy from "hljs/lib/languages/easy.js";

hljs.registerLanguage("easy", easy);
console.log(hljs.highlight("a+b", { language: "easy" }).value);
console.log(hljs.getLanguage("easy") !== undefined);
console.log(String(hljs.getLanguage("missing")));
console.log(typeof hljs.highlight);
