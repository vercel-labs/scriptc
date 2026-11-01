// @requires-libnode
// A dynamic import of a package's own CommonJS module: Node loads the file
// through its CommonJS loader and the namespace carries module.exports as
// `default` plus the names its lexer proves. The package runs in a Node
// island, so the import answers that island module's namespace. The
// package declares its other subpaths but not this one (highlight.js 10.7.3
// declares `lib/core.js` and `lib/languages/*`, nothing for `lib/index.js`),
// and the island loads the file whether or not a declaration exists.
import hljs from "hljs/lib/core.js";
import easy from "hljs/lib/languages/easy.js";

hljs.registerLanguage("easy", easy);
console.log(hljs.highlight("x", { language: "easy" }).value);

void import("hljs/lib/index.js").then((ns) => {
  console.log(Object.keys(ns).sort().join(","));
  console.log(typeof ns.default);
  console.log(ns.default.highlight("y", { language: "easy" }).value);
});
