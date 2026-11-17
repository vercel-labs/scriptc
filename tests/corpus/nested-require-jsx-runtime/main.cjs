"use strict";
var jsxRuntime = require("./jsx-runtime.cjs");
var element = jsxRuntime.jsx("div", { id: 1 });
console.log(element.type, element.version, jsxRuntime.Fragment.kind);
function loadReact() {
  return require("./react.cjs");
}
console.log(loadReact() === loadReact(), loadReact() === loadReact());
console.log(require("./react.cjs").version, typeof loadReact());
