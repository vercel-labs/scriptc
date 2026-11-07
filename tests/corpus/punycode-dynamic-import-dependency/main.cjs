// @normalize-pid
// A dependency whose first load of node:punycode is a dynamic import
// reports DEP0040: isInsideNodeModules() reads the stack of the builtin's
// load, which a dynamic import performs inside the loader with no
// requiring frame of the importing file on it, so the dependency's report
// is not skipped the way its require() is (6126-punycode-dependency). The
// module cache keeps the program's own later import silent.
"use strict";
const seen = [];
process.on("warning", (w) => {
  if (w.code === "DEP0040") seen.push("dep");
});
const toAscii = require("puny-dep");
(async () => {
  console.log(await toAscii("mañana.com"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  console.log("reports", seen.join(","));
  const punycode = await import("punycode");
  console.log(punycode.default.toUnicode("xn--maana-pta.com"), seen.join(","));
})();
