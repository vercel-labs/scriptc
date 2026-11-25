// @env: NODE_DISABLE_COMPILE_CACHE=1
// node:module's compile cache family in JavaScript: the members destructured
// from a dynamic import, the objects themselves, Node's argument validation
// and its order.
const { enableCompileCache, getCompileCacheDir, flushCompileCache, constants } =
  await import("node:module");
import * as nodeModule from "node:module";
import defaultModule from "node:module";

const result = enableCompileCache();
console.log(result, getCompileCacheDir(), flushCompileCache());
console.log(constants, nodeModule.constants === constants);
console.log(
  Object.isFrozen(constants),
  Object.isFrozen(constants.compileCacheStatus),
  Object.getPrototypeOf(constants),
  Object.getPrototypeOf(constants.compileCacheStatus),
);
console.log(
  Object.keys(constants),
  Object.keys(constants.compileCacheStatus),
  JSON.stringify(constants),
);
console.log(
  constants.compileCacheStatus.FAILED,
  constants.compileCacheStatus.ENABLED,
  constants.compileCacheStatus.ALREADY_ENABLED,
  constants.compileCacheStatus.DISABLED,
  constants.compileCacheStatus.MISSING,
);
try {
  constants.compileCacheStatus.ENABLED = 9;
} catch (error) {
  console.log(error.name);
}
console.log(constants.compileCacheStatus.ENABLED);

// Each call answers a fresh ordinary object.
const again = enableCompileCache();
result.status = 99;
result.extra = 1;
console.log(result === again, result, again);
console.log(Object.getPrototypeOf(again) === Object.prototype, Object.isFrozen(again));

// The functions are values.
console.log(typeof enableCompileCache, typeof getCompileCacheDir, typeof flushCompileCache);
console.log(
  enableCompileCache.name,
  enableCompileCache.length,
  getCompileCacheDir.name,
  getCompileCacheDir.length,
  flushCompileCache.name,
  flushCompileCache.length,
);
const held = { enable: enableCompileCache, dir: getCompileCacheDir, flush: flushCompileCache };
console.log(held.enable(), held.dir(), held.flush());
console.log(enableCompileCache.call(null, undefined), enableCompileCache.apply(undefined, []));

// The optional spellings of a program that also runs on older Node.
const optional = defaultModule.enableCompileCache?.();
console.log(
  optional?.status,
  typeof defaultModule.enableCompileCache,
  "enableCompileCache" in defaultModule,
  defaultModule.getCompileCacheDir?.(),
);
if (typeof defaultModule.enableCompileCache === "function" && !defaultModule.getCompileCacheDir()) {
  console.log("no cache directory");
}

// Node's validation: the directory is a string or undefined, named directly
// or by an object's `directory`.
const show = (label, call) => {
  try {
    console.log(label, call());
  } catch (error) {
    console.log(
      label,
      "throws",
      error.name,
      error.code,
      JSON.stringify(error.message),
      error instanceof TypeError,
    );
  }
};
show("number", () => nodeModule.enableCompileCache(1));
show("null", () => nodeModule.enableCompileCache(null));
show("boolean", () => nodeModule.enableCompileCache(true));
show("empty string", () => nodeModule.enableCompileCache(""));
show("directory: number", () => nodeModule.enableCompileCache({ directory: 1 }));
show("portable: number", () => nodeModule.enableCompileCache({ portable: 1 }));
show("array", () => nodeModule.enableCompileCache([]));
show("function", () => nodeModule.enableCompileCache(() => 1));
show("symbol", () => nodeModule.enableCompileCache(Symbol("directory")));
show("bigint", () => nodeModule.enableCompileCache(1n));
show("two arguments", () => nodeModule.enableCompileCache("/nonexistent/compile-cache", "b"));
show("flush(number)", () => nodeModule.flushCompileCache(1));
show("flush(null)", () => nodeModule.flushCompileCache(null));
show("flush(true)", () => nodeModule.flushCompileCache(true));
show("flush(undefined)", () => nodeModule.flushCompileCache(undefined));
show("directory(number)", () => nodeModule.getCompileCacheDir(1));

// Every argument is evaluated before the first is validated, and the
// options object's members are read in Node's order.
const log = [];
const note = (value) => {
  log.push(value);
  return value;
};
try {
  enableCompileCache(note(1), note("later"));
} catch (error) {
  log.push(error.code);
}
try {
  enableCompileCache(
    note(1),
    (() => {
      throw new Error("the later argument wins");
    })(),
  );
} catch (error) {
  log.push(error.message);
}
const options = {
  get directory() {
    log.push("directory read");
    return "/nonexistent/compile-cache";
  },
  get portable() {
    log.push("portable read");
    return false;
  },
};
console.log(enableCompileCache(options), log);
try {
  flushCompileCache(note("x"), note("y"));
} catch (error) {
  log.push(error.code);
}
console.log(log);
