// The translation units, defines and compile flags of the vendored zstd
// (packages/runtime/vendor/zstd, the copy Node v24.22.1 bundles in deps/zstd),
// chosen the way Node's deps/zstd/zstd.gyp chooses them.
// packages/compiler/src/backend/vendor-inputs.ts keeps the same table for
// cross builds; a unit test checks that the two agree.

const SOURCES = [
  "common/debug.c",
  "common/entropy_common.c",
  "common/error_private.c",
  "common/fse_decompress.c",
  "common/pool.c",
  "common/threading.c",
  "common/xxhash.c",
  "common/zstd_common.c",
  "compress/fse_compress.c",
  "compress/hist.c",
  "compress/huf_compress.c",
  "compress/zstd_compress.c",
  "compress/zstd_compress_literals.c",
  "compress/zstd_compress_sequences.c",
  "compress/zstd_compress_superblock.c",
  "compress/zstd_double_fast.c",
  "compress/zstd_fast.c",
  "compress/zstd_lazy.c",
  "compress/zstd_ldm.c",
  "compress/zstd_opt.c",
  "compress/zstd_preSplit.c",
  "compress/zstdmt_compress.c",
  "decompress/huf_decompress.c",
  "decompress/zstd_ddict.c",
  "decompress/zstd_decompress.c",
  "decompress/zstd_decompress_block.c",
];

/**
 * @param {string} triple an LLVM or Zig target triple, such as
 *   "x86_64-unknown-linux-gnu", "arm64-apple-macosx14.0.0" or "wasm32-wasi".
 * @returns {{ sources: string[], defines: string[], compileFlags: string[] }}
 */
export function zstdInputs(triple) {
  const [cpu = "", ...rest] = triple.split("-");
  const system = rest.join("-");
  const windows =
    system.includes("windows") || system.includes("win32") || system.includes("mingw");
  // WASI's libc has no threads, so its build leaves out the multi-threaded
  // compressor (see vendor-inputs.ts zstdInputs).
  const wasi = system.includes("wasi") || cpu === "wasm32" || cpu === "wasm64";
  return {
    sources: [...SOURCES],
    defines: ["XXH_NAMESPACE=ZSTD_", ...(wasi ? [] : ["ZSTD_MULTITHREAD"]), "ZSTD_DISABLE_ASM"],
    compileFlags: !windows && !wasi ? ["-pthread"] : [],
  };
}
