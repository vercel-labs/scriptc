"use strict";
const log = (s) => console.log(s);
// Calls the native callback, which calls back in here, `depth` levels.
exports.bounce = function bounce(depth, native) {
  if (depth === 0) return "bottom";
  return `i${depth}<${native(depth - 1)}>`;
};
// The same with a throw at level `at` (thrown by whichever side owns it)
// and a catch at level `catchAt`; every level logs in a finally.
exports.guarded = function guarded(depth, at, catchAt, native) {
  try {
    if (depth === at) throw new RangeError(`island threw at ${depth}`);
    if (depth === 0) return "bottom";
    if (depth === catchAt) {
      try {
        return native(depth - 1);
      } catch (e) {
        return `island caught at ${depth}: ${e.name}: ${e.message}`;
      }
    }
    return native(depth - 1);
  } finally {
    log(`island finally ${depth}`);
  }
};
exports.viaBuiltins = (native) => {
  const out = [];
  out.push([3, 1, 2].map((v) => native("map", v)).join(","));
  out.push([3, 1, 2].sort((a, b) => native("cmp", a - b)).join(","));
  out.push(JSON.stringify({ a: 1, toJSON: () => native("toJSON", 0) }));
  out.push("abc".replace(/b/, (m) => native("replace", m)));
  const o = {
    get x() {
      return native("getter", 0);
    },
  };
  out.push(String(o.x));
  return out.join(" | ");
};
