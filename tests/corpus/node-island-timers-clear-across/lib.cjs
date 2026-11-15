"use strict";
exports.start = (ms) => setTimeout(() => console.log("NOT REACHED island timer"), ms);
exports.startInterval = (ms) => setInterval(() => console.log("island interval"), ms);
exports.clear = (t) => clearTimeout(t);
