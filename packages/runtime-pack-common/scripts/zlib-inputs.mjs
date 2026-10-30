// The translation units and defines of the vendored zlib (packages/runtime/vendor/zlib,
// the copy Node v24.22.0 bundles in deps/zlib), chosen per target the way Node's
// deps/zlib/zlib.gyp chooses them. The SIMD units carry their own target attributes
// and check the CPU at run time, so every unit builds with the same flags. Compressed
// output does not depend on these choices. packages/compiler/src/backend/vendor-inputs.ts
// keeps the same table for cross builds; a unit test checks that the two agree.

const COMMON_SOURCES = [
  "adler32.c",
  "compress.c",
  "cpu_features.c",
  "crc32.c",
  "deflate.c",
  "infback.c",
  "inffast.c",
  "inftrees.c",
  "trees.c",
  "uncompr.c",
  "zutil.c",
];

/**
 * @param {string} triple an LLVM or Zig target triple, such as
 *   "x86_64-unknown-linux-gnu", "arm64-apple-ios15.0" or "aarch64-linux-musl".
 * @returns {{ sources: string[], defines: string[] }}
 */
export function zlibInputs(triple) {
  const [cpu = "", ...rest] = triple.split("-");
  const system = rest.join("-");
  const architecture =
    cpu === "x86_64" || cpu === "amd64"
      ? "x64"
      : cpu === "aarch64" || cpu === "arm64"
        ? "arm64"
        : cpu;
  const ios = system.includes("ios");
  const windows =
    system.includes("windows") || system.includes("win32") || system.includes("mingw");
  // Android reads the CPU features through getauxval, as Linux does: Node's
  // ARMV8_OS_ANDROID path needs the NDK's cpu-features library.
  const linux = system.includes("linux") || system.includes("android");
  const mac = !ios && (system.includes("darwin") || system.includes("macos"));
  const sources = [...COMMON_SOURCES];
  const defines = windows ? [] : ["HAVE_HIDDEN"];
  if (architecture === "x64" && !ios) {
    sources.push(
      "adler32_simd.c",
      "contrib/optimizations/inffast_chunk.c",
      "contrib/optimizations/inflate.c",
    );
    defines.push(
      "ADLER32_SIMD_SSSE3",
      windows ? "X86_WINDOWS" : "X86_NOT_WINDOWS",
      "INFLATE_CHUNK_SIMD_SSE2",
      "INFLATE_CHUNK_READ_64LE",
      "DEFLATE_SLIDE_HASH_SSE2",
    );
  } else if (architecture === "arm64") {
    sources.push("contrib/optimizations/inffast_chunk.c", "contrib/optimizations/inflate.c");
    defines.push(
      "INFLATE_CHUNK_SIMD_NEON",
      "INFLATE_CHUNK_READ_64LE",
      "__ARM_NEON__",
      "DEFLATE_SLIDE_HASH_NEON",
    );
    if (windows) {
      defines.push("ARMV8_OS_WINDOWS");
    } else if (linux || mac) {
      // Node builds the Adler-32 and CRC-32 units for every arm64 target but
      // iOS and Windows.
      sources.push("adler32_simd.c", "crc32_simd.c");
      defines.push(
        "ADLER32_SIMD_NEON",
        "CRC32_ARMV8_CRC32",
        linux ? "ARMV8_OS_LINUX" : "ARMV8_OS_MACOS",
      );
    }
  } else {
    sources.push("inflate.c");
    defines.push("CPU_NO_SIMD");
  }
  return { sources, defines };
}
