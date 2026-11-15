// @deferred-fences: 1
"use strict";
// wasm-bindgen's TextEncoder glue: a hoisted `var` answers the feature probe
// true, so the polyfill assignment below never runs.
var encoder = new TextEncoder();
console.log("encodeInto" in encoder);
if (!("encodeInto" in encoder)) encoder.encodeInto = function () {};
console.log("ready");

// The undefined arm of a hoisted binding still throws Node's TypeError when
// the probe actually selects it.
var unset;
try {
  console.log("toString" in unset);
} catch (err) {
  console.log(err.constructor.name, err.message);
}
