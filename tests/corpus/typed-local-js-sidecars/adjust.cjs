"use strict";
console.log("adjust init");
/** @param {import("./adjust.d.cts").Amount} amount */
function adjust(amount) { return amount + 1; }
exports.adjust = adjust;
