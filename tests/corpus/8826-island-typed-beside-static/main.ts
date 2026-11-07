// @requires-libnode
// A typed island package beside a package the build compiles statically.
// `hljs` runs in a Node island (its own CommonJS module is imported
// dynamically), so its declarations are its whole surface: the program is
// checked against `types/index.d.ts`, never against the JSDoc of the files
// the island loads. The statically compiled `plainpkg` keeps the flag that
// admits node_modules JavaScript to the checker active, and the island's
// files must stay out of every program that flag builds. Here they would
// change the answer: the language module's JSDoc requires the argument its
// declaration makes optional, so a check against the JSDoc refuses the
// `registerLanguage` call the declarations accept.
import hljs from "hljs/lib/core.js";
import easy from "hljs/lib/languages/easy.js";
import { shout } from "plainpkg";

hljs.registerLanguage("easy", easy);
console.log(shout(hljs.highlight("x", { language: "easy" }).value));

void import("hljs/lib/index.js").then((ns) => {
  console.log(typeof ns.default);
  console.log(shout(ns.default.highlight("y", { language: "easy" }).value));
});
