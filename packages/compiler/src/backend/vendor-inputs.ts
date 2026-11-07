/** The pinned QuickJS, mbedTLS, zlib, brotli, and zstd inputs used by native
 * recipes. */
export const QJS_COMMIT = "3c8f3d68953955950074c41c6e4d999562ae82a7";
export const MBEDTLS_VERSION = "3.6.7";
/** The zlib Node v24.22.1 bundles (`process.versions.zlib` there), the
 * Chromium fork in Node's deps/zlib (packages/runtime/vendor/zlib). */
export const ZLIB_VERSION = "1.3.2.1-motley-285e94b";
/** The brotli release Node v24.22.1 bundles (packages/runtime/vendor/brotli). */
export const BROTLI_VERSION = "1.2.0";
/** The zstd release Node v24.22.1 bundles (packages/runtime/vendor/zstd). */
export const ZSTD_VERSION = "1.5.7";
/** ICU4C release 78.3 — the exact version Node v24.22.1 bundles
 * (`process.versions.icu` there), from the `release-78.3` tag. ICU is not
 * vendored: the build fetches the release's own source tarball and data zip
 * from unicode-org/icu's GitHub release, pinning each by version and sha256,
 * and caches the download. The runtime packs ship its data file icudt78l.dat
 * (33,107,232 B) without the categories no Intl form reads (11,653,984 B),
 * beside the executable; see packages/runtime-pack-common/scripts/
 * icu-data.mjs. */
export const ICU_VERSION = "78.3";
const ICU_RELEASE_URL = `https://github.com/unicode-org/icu/releases/download/release-${ICU_VERSION}`;
/** The release's source tarball (icu, not icu4j), the only build input that
 * is not vendored. */
export const ICU_SOURCE_URL = `${ICU_RELEASE_URL}/icu4c-${ICU_VERSION}-sources.tgz`;
export const ICU_SOURCE_SHA256 = "3a2e7a47604ba702f345878308e6fefeca612ee895cf4a5f222e7955fabfe0c0";
export const ICU_SOURCE_SIZE = 27_977_255;
/** The release's prebuilt little-endian data zip. 969 source files are
 * reviewable; 33 MiB of compiled CLDR tables are not, so the data is fetched
 * too, pinned the same way. */
export const ICU_DATA_URL = `${ICU_RELEASE_URL}/icu4c-${ICU_VERSION}-data-bin-l.zip`;
export const ICU_DATA_ZIP_SHA256 =
  "982619632b78887f1895b063e96e8c3cc7f99283337c8abbd05aa71635de613c";
export const ICU_DATA_ZIP_SIZE = 12_836_659;
export const ICU_DATA_FILE = "icudt78l.dat";
export const ICU_DATA_SHA256 = "d5cf2a40dccbe471781ec7af85693bff542ff12f0b670c9630c4e72d60714b8b";
export const ICU_DATA_SIZE = 33_107_232;
/** The glibc target the ICU archive compiles for: the floor the linux-x64-gnu
 * runtime pack builds against (packages/runtime-pack-common/scripts/
 * glibc-toolchain.mjs GLIBC_RUNTIME_FLOOR), spelled for Zig's C++ driver.
 * ICU is the one C++ archive, and C++ compiled against a newer host glibc
 * binds the C23 strtol names (__isoc23_*) that floor forbids. */
export const ICU_CXX_TARGET = "x86_64-linux-gnu.2.34";
/** The translation units one of ICU's own source lists names, in its order.
 * The fetched tarball carries the lists (`source/common/sources.txt`,
 * `source/i18n/sources.txt`) verbatim, so the units a build compiles are
 * exactly the units ICU's own autoconf build compiles for this release.
 * Entries are bare file names. The pack build reads the same files
 * (packages/runtime-pack-common/scripts/icu-data.mjs). */
export function icuSourceList(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}
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

/** Every zstd translation unit a build compiles: the list Node's
 * deps/zstd/zstd.gyp names for the static library (its libraries without C
 * files, such as bitstream and entropy, contribute none). */
export const ZSTD_SOURCES = [
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
] as const;

/** The zstd translation units, defines and compile flags for a target,
 * chosen the way Node's deps/zstd/zstd.gyp chooses them: the same units
 * everywhere against the same defines, so compressed bytes do not depend on
 * the target. ZSTD_MULTITHREAD turns on the multi-threaded compressor, which
 * Node builds in on every target that has threads, and which is left out of
 * WASI (its libc has none); a WASI build compresses on one thread, so it
 * rejects the nbWorkers parameter Node accepts. packages/runtime-pack-common/
 * scripts/zstd-inputs.mjs keeps the same table for the runtime packs.
 * `triple` is an LLVM or Zig target triple. */
export function zstdInputs(triple: string): {
  sources: string[];
  defines: string[];
  compileFlags: string[];
} {
  const [cpu = "", ...rest] = triple.split("-");
  const system = rest.join("-");
  const windows =
    system.includes("windows") || system.includes("win32") || system.includes("mingw");
  const wasi = system.includes("wasi") || cpu === "wasm32" || cpu === "wasm64";
  return {
    sources: [...ZSTD_SOURCES],
    defines: [
      // The units share Node's xxhash under zstd's own symbol prefix, so the
      // library never collides with another xxhash implementation.
      "XXH_NAMESPACE=ZSTD_",
      ...(wasi ? [] : ["ZSTD_MULTITHREAD"]),
      // The hand-written HUF decoder assembly is not built; the portable C
      // path decodes the same bytes.
      "ZSTD_DISABLE_ASM",
    ],
    // zstd's threading units include pthread.h on POSIX; Node builds them
    // with -pthread, which also selects the reentrant C library headers.
    compileFlags: !windows && !wasi ? ["-pthread"] : [],
  };
}
