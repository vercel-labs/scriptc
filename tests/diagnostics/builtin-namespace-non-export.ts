// An ES module namespace object has exactly the module's exports. node:zlib
// owns the deprecated Z_* constants without enumerating them, so
// `zlib.Z_NO_FLUSH` through `import * as zlib` is undefined in Node, which
// the declared type (number) cannot hold: the read is refused by name. The
// constants object and an exported function read as usual.
import * as zlib from "node:zlib";

const ordinary: number = zlib.constants.Z_NO_FLUSH;
const flush: number = zlib.Z_NO_FLUSH;
const level: number = zlib.Z_BEST_COMPRESSION;
const alias = zlib;
const strategy: number = alias.Z_DEFAULT_STRATEGY;
console.log(ordinary, flush, level, strategy, typeof zlib.gzipSync);
