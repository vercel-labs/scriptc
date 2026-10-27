// Host detection in CommonJS: typeof on globals nothing declares (window,
// self, document) answers "undefined" without throwing, esbuild's minified
// `typeof x < "u"` test included, and the untaken arm of a detection chain
// is code Node never runs. The global object's members read as the
// globals themselves.
"use strict";
console.log(typeof window, typeof self, typeof document, typeof global, typeof globalThis);
console.log(typeof window < "u", typeof global < "u", typeof self !== "undefined");

var OurUint8Array =
  (typeof global < "u" ? global : typeof window < "u" ? window : typeof self < "u" ? self : {})
    .Uint8Array || function () {};
console.log(OurUint8Array === Uint8Array, new OurUint8Array(3).length);

var isBrowser = typeof window !== "undefined" && typeof window.document !== "undefined";
console.log(isBrowser ? "browser" : "node");
if (typeof window !== "undefined") {
  console.log(window.location.href);
} else {
  console.log("no window");
}
var where = typeof self < "u" ? self.location : typeof process === "object" ? process.platform.length > 0 : null;
console.log(where);

console.log(globalThis.Uint8Array === Uint8Array, global.Buffer === Buffer);
console.log(typeof global.setTimeout, typeof globalThis.queueMicrotask, typeof globalThis.Uint8Array);
var U = global.Uint8Array || function () {};
console.log(new U(2).length);
