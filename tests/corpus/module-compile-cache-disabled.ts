// @env: NODE_DISABLE_COMPILE_CACHE=1
// node:module's compile cache family in typed code. With the variable set
// Node answers the DISABLED status and never makes a cache directory, which
// is what a compiled program answers: it loads no JavaScript to cache.
import * as nodeModule from "node:module";
import {
  constants,
  enableCompileCache,
  flushCompileCache,
  getCompileCacheDir,
} from "node:module";

const first = enableCompileCache();
console.log(first.status, first.message, first.directory);
console.log(Object.keys(first), JSON.stringify(first), "directory" in first, "message" in first);
console.log(first);

const statuses = constants.compileCacheStatus;
console.log(statuses.FAILED, statuses.ENABLED, statuses.ALREADY_ENABLED, statuses.DISABLED);
console.log(
  first.status === constants.compileCacheStatus.DISABLED,
  first.status === statuses.ENABLED,
  first.status === statuses.ALREADY_ENABLED,
  first.status === statuses.FAILED,
);

function describe(): string {
  const result = enableCompileCache();
  switch (result.status) {
    case constants.compileCacheStatus.ENABLED:
      return "enabled " + result.directory;
    case constants.compileCacheStatus.ALREADY_ENABLED:
      return "already " + result.directory;
    case constants.compileCacheStatus.FAILED:
      return "failed " + result.message;
    case constants.compileCacheStatus.DISABLED:
      return "disabled " + (result.message ?? "");
    default:
      return "unknown";
  }
}
const directory: string | undefined = getCompileCacheDir();
console.log(describe(), directory === undefined, directory ?? "no directory");

// A directory, the options object, and the namespace spelling.
const named = nodeModule.enableCompileCache("/nonexistent/compile-cache");
const byOptions = enableCompileCache({ directory: "/nonexistent/compile-cache" });
const portable = enableCompileCache({ directory: "/nonexistent/compile-cache", portable: true });
const empty = enableCompileCache({});
const omitted = enableCompileCache(undefined);
console.log(named.status, byOptions.status, portable.status, empty.status, omitted.status);
console.log(named === byOptions, named.message === byOptions.message);
console.log(nodeModule.getCompileCacheDir(), nodeModule.constants.compileCacheStatus.DISABLED);
flushCompileCache();
nodeModule.flushCompileCache();

// The functions as values.
const enable = enableCompileCache;
const dir = getCompileCacheDir;
const flush = flushCompileCache;
console.log(typeof enableCompileCache, typeof enable, enable().status, dir());
console.log(enable.name, enable.length, dir.name, dir.length, flush.name, flush.length);
flush();

// Values whose type only the run knows: Node validates the directory.
const values: unknown[] = [
  "/nonexistent/compile-cache",
  undefined,
  {},
  { directory: "relative" },
  1,
  null,
  true,
  { directory: 1 },
  [],
  "",
];
for (const value of values) {
  try {
    const result = enableCompileCache(value as string);
    console.log(typeof value, result.status, result.message);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    console.log(
      typeof value,
      "throws",
      failure.name,
      failure.code,
      failure.message,
      failure instanceof TypeError,
    );
  }
}
