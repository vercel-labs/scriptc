// Method calls on a JavaScript binding that holds one type beside null:
// Node's TypeError for the missing value, the method otherwise, with the
// receiver evaluated once.
"use strict";
var /** @type {Uint8Array | null} */ view = null;
var calls = 0;
function getView() { calls++; return view; }
function tail(n) { return view.subarray(n).length; }
function viaCall() { return getView().subarray(1).length; }
function attempt(name, f) {
  try { console.log(name, f()); } catch (e) { console.log(name, e.constructor.name, e.message); }
}
attempt("tail", () => tail(2));
attempt("viaCall", viaCall);
view = new Uint8Array(6);
attempt("tail", () => tail(2));
attempt("viaCall", viaCall);
console.log("calls", calls);
// A use the checker narrowed to null still calls through the declared type.
var /** @type {Uint8Array | null} */ narrowed = null;
attempt("narrowed", () => narrowed.subarray(0).length);
narrowed = new Uint8Array(2);
attempt("narrowed", () => narrowed.subarray(1).length);
