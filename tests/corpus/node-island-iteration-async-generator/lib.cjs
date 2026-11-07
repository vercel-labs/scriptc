"use strict";
const log = (s) => console.log(s);
exports.gen = async function* gen(n) {
  try {
    for (let i = 0; i < n; i++) {
      log(`island yields ${i}`);
      yield i;
      await null;
    }
    return "island done";
  } finally {
    log("island generator finally");
  }
};
