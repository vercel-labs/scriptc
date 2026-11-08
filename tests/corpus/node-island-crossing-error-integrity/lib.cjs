const attrs = (d) =>
  d === undefined ? "none" : `${d.writable ? "w" : "-"}${d.enumerable ? "e" : "-"}${d.configurable ? "c" : "-"}`;

exports.describe = (e) =>
  ["message", "name", "cause"].map((k) => `${k}:${attrs(Object.getOwnPropertyDescriptor(e, k))}`).join(" ");

// This module is not strict: a write a property refuses is dropped silently.
exports.write = (e) => {
  e.message = "written";
  e.cause = "changed";
  return `${e.message} ${String(e.cause)}`;
};

exports.strictWrite = (e) =>
  (function () {
    "use strict";
    try {
      e.message = "strict";
      return `ok ${e.message}`;
    } catch (x) {
      return `throws ${x instanceof TypeError}`;
    }
  })();

exports.redefine = (e) => {
  try {
    Object.defineProperty(e, "message", { value: "redefined", writable: true, configurable: true });
    return `ok ${e.message}`;
  } catch (x) {
    return `throws ${x instanceof TypeError}`;
  }
};

exports.remove = (e) => {
  const gone = delete e.cause;
  return `${gone} ${String(e.cause)}`;
};
