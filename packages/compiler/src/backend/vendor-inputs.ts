/** The pinned QuickJS, mbedTLS, zlib, and brotli inputs used by native recipes. */
export const QJS_COMMIT = "3c8f3d68953955950074c41c6e4d999562ae82a7";
export const MBEDTLS_VERSION = "3.6.7";
/** The zlib Node v24.22.0 bundles (`process.versions.zlib` there), the
 * Chromium fork in Node's deps/zlib (packages/runtime/vendor/zlib). */
export const ZLIB_VERSION = "1.3.2.1-motley-285e94b";
/** The brotli release Node v24.22.0 bundles (packages/runtime/vendor/brotli). */
export const BROTLI_VERSION = "1.2.0";
/** Exact translation-unit membership shared by cache builds and external
 * source-pack recipes. */
export const LRE_SOURCES = ["libregexp.c", "libunicode.c"] as const;
const ZLIB_COMMON_SOURCES = [
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
] as const;

/** Every zlib translation unit some target compiles (zlibInputs). */
export const ZLIB_SOURCES = [
  ...ZLIB_COMMON_SOURCES,
  "adler32_simd.c",
  "crc32_simd.c",
  "inflate.c",
  "contrib/optimizations/inffast_chunk.c",
  "contrib/optimizations/inflate.c",
] as const;

/** The zlib translation units and defines for a target, chosen the way
 * Node's deps/zlib/zlib.gyp chooses them. The SIMD units carry their own
 * target attributes and check the CPU at run time, so every unit builds with
 * the same flags, and compressed output does not depend on the choice.
 * packages/runtime-pack-common/scripts/zlib-inputs.mjs keeps the same table
 * for the runtime packs. `triple` is an LLVM or Zig target triple. */
export function zlibInputs(triple: string): { sources: string[]; defines: string[] } {
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
  const sources: string[] = [...ZLIB_COMMON_SOURCES];
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
