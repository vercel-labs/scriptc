"use strict";
// Minifiers spell `true` as `!0`: Object.defineProperty(exports,
// "__esModule", { value: !0 }) is the same interop stamp as { value: true }.
const stamped = require("./stamped.cjs");
const moduleStamped = require("./module-stamped.cjs");
console.log(stamped.answer, stamped.twice(4), moduleStamped.label);
console.log(typeof stamped.twice, moduleStamped.label.length);
