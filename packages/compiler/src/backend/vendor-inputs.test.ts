import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { ZLIB_SOURCES, zlibInputs } from "./vendor-inputs.js";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const zlibDir = join(repoRoot, "packages/runtime/vendor/zlib");

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
