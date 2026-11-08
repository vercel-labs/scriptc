"use strict";
// Fresh island objects, and one every caller gets.
exports.make = (i) => ({ i });
exports.shared = { name: "shared" };
