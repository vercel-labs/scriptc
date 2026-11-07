"use strict";
console.log("lib evaluating");
exports.note = (s) => console.log(`island notes ${s}`);
exports.later = (label) => {
  setTimeout(() => console.log(`island timer ${label}`), 1);
};
