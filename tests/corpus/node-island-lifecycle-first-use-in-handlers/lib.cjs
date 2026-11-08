"use strict";
console.log("lib evaluating");
let fired = false;
exports.note = (s) => console.log(`island notes ${s}`);
exports.later = (label) => {
  setTimeout(() => {
    console.log(`island timer ${label}`);
    fired = true;
  }, 1);
};
exports.fired = () => fired;
