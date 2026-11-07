"use strict";
let held;

exports.call = (d, setter, value) => d[setter](value);
exports.uncurried = (d, value) => Date.prototype.setTime.call(d, value);
exports.time = (d) => d.getTime();
exports.hold = (d) => {
  held = d;
};
exports.heldTime = () => held.getTime();
exports.heldText = () => String(held);
