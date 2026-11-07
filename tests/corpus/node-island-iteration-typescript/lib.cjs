"use strict";
const log = (s) => console.log(s);
exports.count = function* count(label, n) {
  try {
    for (let i = 0; i < n; i++) {
      log(`${label} yields ${i}`);
      yield i;
    }
  } finally {
    log(`${label} finally`);
  }
};
exports.later = async function* later(label, n) {
  try {
    for (let i = 0; i < n; i++) {
      await null;
      yield `${label} ${i}`;
    }
  } finally {
    log(`${label} finally`);
  }
};
exports.take = (iterable, n) => {
  const out = [];
  for (const v of iterable) {
    out.push(v);
    if (out.length === n) break;
  }
  return out.join(",");
};
exports.takeAsync = async (iterable, n) => {
  const out = [];
  for await (const v of iterable) {
    out.push(v);
    if (out.length === n) break;
  }
  return out.join(",");
};
