"use strict";
var jsxRuntime = require("./jsx-runtime.cjs");
var element = jsxRuntime.jsx("div", { id: 1 });
console.log(element.type, element.version, jsxRuntime.Fragment.kind);
function loadReact() {
  return require("./react.cjs");
}
console.log(loadReact() === loadReact(), loadReact() === loadReact());
console.log(require("./react.cjs").version, typeof loadReact());
function loadForward() {
  return require("./forward.cjs");
}
console.log(loadForward() === loadReact(), loadForward().version);
function take() {
  var { value, table } = require("./state.cjs");
  require("./state.cjs").set("second");
  return value + ":" + table.counted;
}
console.log(take());
console.log(take());
