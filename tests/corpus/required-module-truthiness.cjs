// A required builtin module object in a boolean context is truthy, as any
// object: readable-stream's `process.env.READABLE_STREAM === "disable" &&
// Stream` and `Stream || exports` guards.
"use strict";
var Stream = require("stream");
var os = require("os");
console.log(Stream ? "stream" : "none", !!os, !os);
console.log(process.env.SCRIPTC_UNSET_FLAG === "disable" && Stream ? "disabled" : "default");
var fallback = Stream || null;
console.log(fallback === Stream);
