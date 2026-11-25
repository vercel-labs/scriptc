// @requires-libnode
// A native callback passed into island code calls back into the island,
// many levels deep; a throw at each depth unwinds through the finally
// blocks of both sides to a catch on either side.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

function bounce(depth) {
  if (depth === 0) return "bottom";
  return `n${depth}<${lib.bounce(depth - 1, bounce)}>`;
}
log(bounce(12));
log(String(lib.bounce(300, function deep(d) { return d === 0 ? 0 : lib.bounce(d - 1, deep).length; }).length));

function guarded(at, catchAt) {
  return function step(depth) {
    try {
      if (depth === at) throw new TypeError(`native threw at ${depth}`);
      if (depth === 0) return "bottom";
      if (depth === catchAt) {
        try {
          return lib.guarded(depth - 1, at, catchAt, step);
        } catch (e) {
          return `native caught at ${depth}: ${e.name}: ${e.message}`;
        }
      }
      return lib.guarded(depth - 1, at, catchAt, step);
    } finally {
      log(`native finally ${depth}`);
    }
  };
}

for (const [at, catchAt] of [[0, 5], [1, 4], [2, 5], [3, 4], [0, 99], [1, 99], [9, 9]]) {
  log(`-- throw at ${at}, catch at ${catchAt}`);
  try {
    log(guarded(at, catchAt)(6));
  } catch (e) {
    log(`top caught ${e.name}: ${e.message}`);
  }
}

log("-- native callbacks under island built-ins");
log(lib.viaBuiltins((what, v) => (what === "cmp" ? v : `${what}:${v}`)));
try {
  lib.viaBuiltins((what, v) => {
    if (what === "toJSON") throw new Error("native threw in toJSON");
    return what === "cmp" ? v : `${what}:${v}`;
  });
} catch (e) {
  log(`caught ${e.message}`);
}
