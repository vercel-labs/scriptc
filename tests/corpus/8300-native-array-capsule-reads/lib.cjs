"use strict";
// Reads and writes the arrays the typed program passes in.
exports.total = function (xs) {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s;
};
exports.at = function (xs, i) {
  return xs[i];
};
exports.describe = function (xs, keys) {
  const out = [];
  for (const k of keys) {
    const v = xs[k];
    out.push(typeof v === "number" && Object.is(v, -0) ? "-0" : String(v));
  }
  return out.join(" ");
};
exports.has = function (xs, i) {
  return i in xs;
};
exports.write = function (xs, i, v) {
  xs[i] = v;
  return xs[i];
};
exports.grow = function (xs, v) {
  xs.push(v);
  return xs.length;
};
exports.cut = function (xs, n) {
  xs.length = n;
  return xs.length;
};
exports.lengthOf = function (xs) {
  return xs.length;
};
