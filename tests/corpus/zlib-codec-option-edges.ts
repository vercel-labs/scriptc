// The zlib, Brotli and zstd option ladders on the one-shots: flush and
// finishFlush ranges, chunkSize's floor and the output buffer's ceiling,
// maxOutputLength's ERR_BUFFER_TOO_LARGE, params and dictionary type errors,
// and options the codecs ignore. Each failure prints Node's code and message.
import * as zlib from "node:zlib";

function attempt(label: string, fn: () => unknown): void {
  try {
    const value = fn();
    const shown = Buffer.isBuffer(value) ? "buffer" : value;
    console.log(label, "ok", shown);
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    console.log(label, "error", e.code, e.message);
  }
}

const text = "hello hello hello";
const dict = Buffer.from("hello");
// Values whose type is not what the option holds reach the ladder through
// the untyped lane, the way an options object built at run time would.
const anyValue: any = "not a record";
const anyNumber: any = 5;
const anyString: any = "fast";
// Brotli accepts a dictionary at run time although its option type does not
// declare one, and every codec accepts keys it ignores; both reach the ladder
// through this lane as a run-time-built options record would.
function untyped<T>(value: Record<string, unknown>): T {
  return value as T;
}

// Brotli flush accepts BROTLI_OPERATION_PROCESS/FLUSH/FINISH/EMIT_METADATA
// (0 to 3) and rejects 4; zstd accepts 0 to 2 and rejects 3.
for (const flush of [0, 1, 2, 3, 4]) {
  attempt(`brotli flush ${flush}`, () => zlib.brotliCompressSync(text, { flush }).length > 0);
}
for (const flush of [0, 1, 2, 3]) {
  attempt(`zstd flush ${flush}`, () => zlib.zstdCompressSync(text, { flush }).length > 0);
}
attempt("brotli finishFlush 3", () => zlib.brotliCompressSync(text, { finishFlush: 3 }).length > 0);
attempt("brotli finishFlush 4", () => zlib.brotliCompressSync(text, { finishFlush: 4 }));
attempt("zstd finishFlush 2", () => zlib.zstdCompressSync(text, { finishFlush: 2 }).length > 0);
attempt("zstd finishFlush 3", () => zlib.zstdCompressSync(text, { finishFlush: 3 }));

// chunkSize's floor and ceiling are the zlib ones for every codec.
attempt("brotli chunkSize 1", () => zlib.brotliCompressSync(text, { chunkSize: 1 }));
attempt("brotli chunkSize 64", () => zlib.brotliCompressSync(text, { chunkSize: 64 }).length > 0);
attempt("zstd chunkSize 1", () => zlib.zstdCompressSync(text, { chunkSize: 1 }));
attempt("zstd chunkSize 64", () => zlib.zstdCompressSync(text, { chunkSize: 64 }).length > 0);

// ZlibBase allocates the chunkSize-sized output buffer when the stream is
// built, so Buffer.allocUnsafe's ladder answers a size past the buffer
// limit: ERR_OUT_OF_RANGE on "size", with Node's underscore-separated
// rendering of the received value. A fractional size truncates, NaN takes
// the default, and a non-number is the option's type error.
attempt("gzip chunkSize 2**53", () => zlib.gzipSync(text, { chunkSize: 2 ** 53 }));
attempt("brotli chunkSize 2**53", () => zlib.brotliCompressSync(text, { chunkSize: 2 ** 53 }));
attempt("zstd chunkSize 2**53", () => zlib.zstdCompressSync(text, { chunkSize: 2 ** 53 }));
attempt("gzip chunkSize 1e21", () => zlib.gzipSync(text, { chunkSize: 1e21 }));
attempt("gzip chunkSize 63", () => zlib.gzipSync(text, { chunkSize: 63 }));
attempt("gzip chunkSize Infinity", () => zlib.gzipSync(text, { chunkSize: Infinity }));
attempt("gzip chunkSize fractional", () => zlib.gzipSync(text, { chunkSize: 64.9 }).length > 0);
attempt("gzip chunkSize NaN", () => zlib.gzipSync(text, { chunkSize: NaN }).length > 0);
attempt("gzip chunkSize string", () => zlib.gzipSync(text, { chunkSize: anyString }));

// maxOutputLength reports through ERR_BUFFER_TOO_LARGE in the one-shots.
attempt("brotli maxOutputLength", () => zlib.brotliCompressSync(text, { maxOutputLength: 1 }));
attempt("zstd maxOutputLength", () => zlib.zstdCompressSync(text, { maxOutputLength: 1 }));

// params values are clamped into the parameter's range and a fractional value
// is accepted, so the ladder checks the parameter's name and the value's type
// rather than its magnitude.
attempt("brotli param too large", () =>
  zlib.brotliCompressSync(text, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 12 } }),
);
attempt("brotli param fractional", () =>
  zlib.brotliCompressSync(text, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1.5 } }),
);
attempt("brotli params string", () => zlib.brotliCompressSync(text, { params: anyValue }));
attempt("zstd param unknown", () => zlib.zstdCompressSync(text, { params: { 99999: 1 } }));
attempt("zstd param wrong type", () =>
  zlib.zstdCompressSync(text, { params: { [zlib.constants.ZSTD_c_compressionLevel]: anyString } }),
);

// Dictionaries take byte inputs and reject the other primitive types.
attempt("brotli dictionary", () =>
  zlib.brotliCompressSync(text, untyped<zlib.BrotliOptions>({ dictionary: dict })).length > 0,
);
attempt("brotli dictionary string", () =>
  zlib.brotliCompressSync(text, untyped<zlib.BrotliOptions>({ dictionary: "hello" })).length > 0,
);
attempt("brotli dictionary number", () =>
  zlib.brotliCompressSync(text, untyped<zlib.BrotliOptions>({ dictionary: anyNumber })),
);
attempt("zstd dictionary", () => zlib.zstdCompressSync(text, { dictionary: dict }).length > 0);
attempt("zstd dictionary number", () => zlib.zstdCompressSync(text, { dictionary: anyNumber }));

// Options the one-shots ignore, and untyped/absent records.
attempt("brotli ignore windowBits", () =>
  zlib.brotliCompressSync(text, untyped<zlib.BrotliOptions>({ windowBits: 99 })).length > 0,
);
attempt("zstd ignore level", () =>
  zlib.zstdCompressSync(text, untyped<zlib.ZstdOptions>({ level: 99 })).length > 0,
);
attempt("brotli unknown key", () =>
  zlib.brotliCompressSync(text, untyped<zlib.BrotliOptions>({ mystery: 1 })).length > 0,
);
attempt("zstd undefined options", () => zlib.zstdCompressSync(text, undefined).length > 0);
attempt("brotli null options", () => zlib.brotliCompressSync(text, null as unknown as zlib.BrotliOptions).length > 0);
