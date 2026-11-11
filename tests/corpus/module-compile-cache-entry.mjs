// What a program sees of node:module's compile cache when the environment
// does not disable it. Node then turns its cache on (status ENABLED and a
// directory) and a compiled program, which loads no JavaScript, answers
// DISABLED, so the status itself is not printed. Pinned here is what holds
// on both sides: asking through the module's default export with a test for
// the function (the spelling of a program that also runs on a Node without
// the API) throws nothing and writes nothing to either stream, the answer
// is one of the documented statuses and never FAILED, and a cache directory
// is named exactly when the cache is on.
import nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = join(tmpdir(), "scriptc-corpus-compile-cache");
const result =
  typeof nodeModule.enableCompileCache === "function"
    ? nodeModule.enableCompileCache(directory)
    : undefined;
console.error("asked");
console.log(result !== undefined);

const { compileCacheStatus } = nodeModule.constants;
const statuses = Object.values(compileCacheStatus);
console.log(
  typeof result.status,
  statuses.includes(result.status),
  result.status === compileCacheStatus.FAILED,
);
const named = nodeModule.getCompileCacheDir?.();
console.log(result.status === compileCacheStatus.DISABLED ? named === undefined : typeof named === "string");
