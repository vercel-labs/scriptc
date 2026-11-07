"use strict";
const log = (s) => console.log(s);
exports.gen = async function* gen(n) {
  try {
    for (let i = 0; i < n; i++) yield i;
  } finally {
    log("island generator finally");
  }
};
exports.syncGen = function* syncGen(n) {
  try {
    for (let i = 0; i < n; i++) yield i * 10;
  } finally {
    log("island sync generator finally");
  }
};
