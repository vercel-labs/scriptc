import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import {
  ZLIB_SOURCES,
  ZSTD_SOURCES,
  ICU_VERSION,
  ICU_SOURCE_URL,
  ICU_SOURCE_SHA256,
  ICU_SOURCE_SIZE,
  ICU_DATA_URL,
  ICU_DATA_FILE,
  ICU_DATA_SHA256,
  ICU_DATA_SIZE,
  ICU_DATA_ZIP_SHA256,
  ICU_DATA_ZIP_SIZE,
  icuSourceList,
  zlibInputs,
  zstdInputs,
} from "./vendor-inputs.js";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const zlibDir = join(repoRoot, "packages/runtime/vendor/zlib");
const zstdDir = join(repoRoot, "packages/runtime/vendor/zstd/lib");

const TRIPLES = [
  // The runtime packs' targets.
  "x86_64-unknown-linux-gnu",
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-gnu",
  "aarch64-unknown-linux-musl",
  "aarch64-unknown-linux-android26",
  "arm64-apple-macosx14.0.0",
  "x86_64-apple-macosx14.0.0",
  "arm64-apple-ios15.0",
  "arm64-apple-ios15.0-simulator",
  "x86_64-pc-windows-msvc",
  "wasm32-unknown-wasi",
  // Zig cross targets and host spellings.
  "x86_64-linux-gnu",
  "aarch64-linux-musl",
  "aarch64-macos",
  "x86_64-windows-gnu",
  "aarch64-windows-gnu",
  "wasm32-wasi",
  "x86_64-linux",
  "aarch64-darwin",
];

test("the compiler's zlib inputs match the runtime packs' for every target", async () => {
  const packInputs = (await import(
    pathToFileURL(join(repoRoot, "packages/runtime-pack-common/scripts/zlib-inputs.mjs")).href
  )) as { zlibInputs(triple: string): { sources: string[]; defines: string[] } };
  for (const triple of TRIPLES) {
    expect(zlibInputs(triple), triple).toEqual(packInputs.zlibInputs(triple));
  }
});

test("every zlib input exists, and ZLIB_SOURCES lists every source a target compiles", () => {
  const listed = new Set<string>(ZLIB_SOURCES);
  for (const triple of TRIPLES) {
    for (const source of zlibInputs(triple).sources) {
      expect(listed.has(source), `${triple}: ${source}`).toBe(true);
      expect(existsSync(join(zlibDir, source)), source).toBe(true);
    }
  }
});

test("zlib inputs follow Node's deps/zlib/zlib.gyp", () => {
  const x64 = zlibInputs("x86_64-unknown-linux-gnu");
  expect(x64.sources).toContain("adler32_simd.c");
  expect(x64.sources).toContain("contrib/optimizations/inflate.c");
  expect(x64.sources).not.toContain("inflate.c");
  expect(x64.defines).toEqual([
    "HAVE_HIDDEN",
    "ADLER32_SIMD_SSSE3",
    "X86_NOT_WINDOWS",
    "INFLATE_CHUNK_SIMD_SSE2",
    "INFLATE_CHUNK_READ_64LE",
    "DEFLATE_SLIDE_HASH_SSE2",
  ]);
  expect(zlibInputs("x86_64-pc-windows-msvc").defines).toContain("X86_WINDOWS");
  const mac = zlibInputs("arm64-apple-macosx14.0.0");
  expect(mac.sources).toContain("crc32_simd.c");
  expect(mac.defines).toContain("ARMV8_OS_MACOS");
  expect(mac.defines).toContain("CRC32_ARMV8_CRC32");
  const ios = zlibInputs("arm64-apple-ios15.0");
  expect(ios.sources).not.toContain("crc32_simd.c");
  expect(ios.defines).not.toContain("CRC32_ARMV8_CRC32");
  expect(ios.defines).toContain("INFLATE_CHUNK_SIMD_NEON");
  expect(zlibInputs("aarch64-unknown-linux-android26").defines).toContain("ARMV8_OS_LINUX");
  const wasm = zlibInputs("wasm32-unknown-wasi");
  expect(wasm.sources).toContain("inflate.c");
  expect(wasm.sources).not.toContain("contrib/optimizations/inflate.c");
  expect(wasm.defines).toEqual(["HAVE_HIDDEN", "CPU_NO_SIMD"]);
});

test("the compiler's zstd inputs match the runtime packs' for every target", async () => {
  const packInputs = (await import(
    pathToFileURL(join(repoRoot, "packages/runtime-pack-common/scripts/zstd-inputs.mjs")).href
  )) as {
    zstdInputs(triple: string): {
      sources: string[];
      defines: string[];
      compileFlags: string[];
    };
  };
  for (const triple of TRIPLES) {
    expect(zstdInputs(triple), triple).toEqual(packInputs.zstdInputs(triple));
  }
});

test("every zstd input exists, and ZSTD_SOURCES lists every source a target compiles", () => {
  const listed = new Set<string>(ZSTD_SOURCES);
  for (const triple of TRIPLES) {
    for (const source of zstdInputs(triple).sources) {
      expect(listed.has(source), `${triple}: ${source}`).toBe(true);
      expect(existsSync(join(zstdDir, source)), source).toBe(true);
    }
  }
});

test("zstd inputs follow Node's deps/zstd/zstd.gyp", () => {
  // The whole library: no dictionary builder or legacy decoder, which the
  // vendored tree does not carry either.
  expect(ZSTD_SOURCES).toHaveLength(26);
  expect(ZSTD_SOURCES.every((source) => existsSync(join(zstdDir, source)))).toBe(true);
  const linux = zstdInputs("x86_64-unknown-linux-gnu");
  expect(linux.defines).toEqual(["XXH_NAMESPACE=ZSTD_", "ZSTD_MULTITHREAD", "ZSTD_DISABLE_ASM"]);
  expect(linux.compileFlags).toEqual(["-pthread"]);
  // Threads exist on every native target, through pthread.h on POSIX and
  // through Win32 primitives on Windows (where the flag does not apply).
  expect(zstdInputs("x86_64-pc-windows-msvc").defines).toContain("ZSTD_MULTITHREAD");
  expect(zstdInputs("x86_64-pc-windows-msvc").compileFlags).toEqual([]);
  expect(zstdInputs("arm64-apple-macosx14.0.0").compileFlags).toEqual(["-pthread"]);
  // WASI has no threads: the multi-threaded compressor is left out.
  const wasm = zstdInputs("wasm32-unknown-wasi");
  expect(wasm.defines).toEqual(["XXH_NAMESPACE=ZSTD_", "ZSTD_DISABLE_ASM"]);
  expect(wasm.compileFlags).toEqual([]);
});

test("the pinned ICU is the release the oracle Node bundles", () => {
  // Node's own Intl answers from the ICU it was built with, so the fetched
  // release must be that version exactly: the differential corpus compares
  // scriptc's ICU output against Node's, byte for byte.
  expect(process.versions.icu).toBe(ICU_VERSION);
});

test("the compiler's ICU pins match the runtime packs'", async () => {
  const pack = (await import(
    pathToFileURL(join(repoRoot, "packages/runtime-pack-common/scripts/icu-inputs.mjs")).href
  )) as Record<string, string | number>;
  expect(pack["ICU_VERSION"]).toBe(ICU_VERSION);
  expect(pack["ICU_SOURCE_URL"]).toBe(ICU_SOURCE_URL);
  expect(pack["ICU_SOURCE_SHA256"]).toBe(ICU_SOURCE_SHA256);
  expect(pack["ICU_SOURCE_SIZE"]).toBe(ICU_SOURCE_SIZE);
  expect(pack["ICU_DATA_URL"]).toBe(ICU_DATA_URL);
  expect(pack["ICU_DATA_FILE"]).toBe(ICU_DATA_FILE);
  expect(pack["ICU_DATA_SHA256"]).toBe(ICU_DATA_SHA256);
  expect(pack["ICU_DATA_SIZE"]).toBe(ICU_DATA_SIZE);
  expect(pack["ICU_DATA_ZIP_SHA256"]).toBe(ICU_DATA_ZIP_SHA256);
  expect(pack["ICU_DATA_ZIP_SIZE"]).toBe(ICU_DATA_ZIP_SIZE);
  // Both pins name the official release assets for the pinned version.
  expect(ICU_SOURCE_URL).toBe(
    `https://github.com/unicode-org/icu/releases/download/release-${ICU_VERSION}/icu4c-${ICU_VERSION}-sources.tgz`,
  );
  expect(ICU_DATA_URL).toBe(
    `https://github.com/unicode-org/icu/releases/download/release-${ICU_VERSION}/icu4c-${ICU_VERSION}-data-bin-l.zip`,
  );
  expect(ICU_SOURCE_SHA256).toMatch(/^[0-9a-f]{64}$/);
  expect(ICU_DATA_SHA256).toMatch(/^[0-9a-f]{64}$/);
});

test("ICU source lists parse to the units a build compiles", () => {
  expect(icuSourceList("# a comment\n\n  b.cpp  \nc.cpp\n")).toEqual(["b.cpp", "c.cpp"]);
});
