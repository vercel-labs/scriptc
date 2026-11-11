// zlib.constants read as an object rather than member by member: Node's
// module answers one mutable singleton whose keys are inserted in its own
// order. Read it whole (typeof, identity, keys, spread, entries, for-in,
// JSON), read it by name, destructure it, reach it through the bracket and
// namespace spellings, pass it to a function and use its members in a codec
// call.
// BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH is skipped in the aggregate
// checks: the compiled table carries it (the pinned Node has it), some
// 24.22 builds do not, so naming it would make the program host-dependent.
import * as zlib from "node:zlib";
import { constants } from "node:zlib";

const EXTRA: string = "BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH";
const table: zlib.ZlibConstants = zlib.constants;

console.log("typeof", typeof zlib.constants);
console.log(
  "same",
  zlib.constants === zlib.constants,
  zlib.constants === constants,
  table === zlib.constants,
);

// The bracket spellings and the namespace's destructuring answer the same
// singleton the property form does, and the namespace's own key list names
// it. A bracket read reaches the namespace box the compiler builds for a
// namespace read as a value, so the box must serve this member.
const byLiteral: zlib.ZlibConstants = zlib["constants"];
const key: "constants" = "constants";
const byKey: zlib.ZlibConstants = zlib[key];
const { constants: viaNamespace } = zlib;
console.log(
  "spellings",
  byLiteral === table,
  byKey === table,
  viaNamespace === table,
  viaNamespace.ZSTD_CLEVEL_DEFAULT,
);
const namespaceKeys = Object.keys(zlib);
console.log("namespace keys", namespaceKeys.includes("constants"), namespaceKeys.length);

const keys = Object.keys(table).filter((key) => key !== EXTRA);
console.log("keys", keys.length, keys[0], keys[1], keys[keys.length - 2], keys[keys.length - 1]);

const copy = { ...table };
const copyKeys = Object.keys(copy).filter((key) => key !== EXTRA);
console.log("spread", copyKeys.length, copy.Z_SYNC_FLUSH, copy.Z_MAX_CHUNK, copy === table);

console.log(
  "literal",
  table.Z_NO_FLUSH,
  table.Z_FINISH,
  table.Z_BEST_COMPRESSION,
  table.Z_MAX_CHUNK,
  table.Z_DEFAULT_CHUNK,
  table.Z_MIN_MEMLEVEL,
);
console.log(
  "codec",
  table.BROTLI_PARAM_QUALITY,
  table.BROTLI_MAX_QUALITY,
  table.ZSTD_c_compressionLevel,
  table.ZSTD_c_strategy,
  table.BROTLI_DECODER_ERROR_FORMAT_DISTANCE,
);

const { Z_SYNC_FLUSH, Z_BEST_SPEED, ZSTD_c_checksumFlag } = zlib.constants;
console.log("destructured", Z_SYNC_FLUSH, Z_BEST_SPEED, ZSTD_c_checksumFlag);

function defaultLevel(k: zlib.ZlibConstants): number {
  return k.Z_DEFAULT_LEVEL + k.Z_DEFAULT_MEMLEVEL;
}
console.log("parameter", defaultLevel(zlib.constants), defaultLevel({ ...table }));

let sum = 0;
let nonFinite = 0;
let count = 0;
for (const [key, value] of Object.entries(table)) {
  if (key === EXTRA) continue;
  count++;
  if (Number.isFinite(value as number)) sum += value as number;
  else nonFinite++;
}
console.log("entries", count, sum, nonFinite);

let seen = 0;
for (const key in table) if (key !== EXTRA) seen++;
console.log("for-in", seen);
console.log("dynamic", table["Z_FINISH"], table["ZSTD_e_end"]);

const text: string = "zlib constants object ".repeat(20);
const packed: Buffer = zlib.deflateSync(text, {
  level: table.Z_BEST_COMPRESSION,
  flush: Z_SYNC_FLUSH,
  memLevel: table.Z_DEFAULT_MEMLEVEL,
  windowBits: table.Z_DEFAULT_WINDOWBITS,
});
console.log("round trip", zlib.inflateSync(packed).toString() === text);
console.log(
  "json",
  JSON.stringify({
    Z_NO_FLUSH: table.Z_NO_FLUSH,
    Z_MAX_CHUNK: table.Z_MAX_CHUNK,
    Z_FINISH: table.Z_FINISH,
  }),
);
