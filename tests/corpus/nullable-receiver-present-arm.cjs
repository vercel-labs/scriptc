// Member reads and method calls on a JavaScript binding that holds one type
// beside null or undefined: Node's TypeError for the missing value, the
// member otherwise, with the receiver evaluated once.
"use strict";
var /** @type {Uint8Array | null} */ view = null;
var /** @type {string | undefined} */ label = undefined;
var calls = 0;
var holder = { /** @type {Uint8Array | null} */ buf: null };
function getView() { calls++; return view; }
function size() { return view.length; }
function tail(n) { return view.subarray(n).length; }
function shout() { return label.toUpperCase(); }
function viaCall() { return getView().subarray(1).length; }
function viaField() { return holder.buf.byteLength; }
function attempt(name, f) {
  try { console.log(name, f()); } catch (e) { console.log(name, e.constructor.name, e.message); }
}
attempt("size", size);
attempt("tail", () => tail(2));
attempt("shout", shout);
attempt("viaCall", viaCall);
attempt("viaField", viaField);
view = new Uint8Array(6); label = "hi"; holder.buf = new Uint8Array(3);
attempt("size", size);
attempt("tail", () => tail(2));
attempt("shout", shout);
attempt("viaCall", viaCall);
attempt("viaField", viaField);
console.log("calls", calls);
var /** @type {Uint8Array | null} */ narrowed = null;
attempt("narrowed", () => narrowed.subarray(0).length);
narrowed = new Uint8Array(2);
attempt("narrowed", () => narrowed.subarray(1).length);
