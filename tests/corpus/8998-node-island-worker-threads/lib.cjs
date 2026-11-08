"use strict";
// The island both threads reach: a plain object in, a string out.
exports.params = () => ({ model: "m" });
exports.create = (p) => JSON.stringify(p);
