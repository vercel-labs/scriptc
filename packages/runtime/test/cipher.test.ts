import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_cipher");
const mbedtls = join(testDir, "../vendor/mbedtls");

const runtimeSources = [
  "scr_shared.c",
  "scr_bytes.c",
  "scr_bytes.test.c",
  "scr_bytes_io.c",
  "scr_fs_cp.c",
  "scr_zlib.c",
  "scr_lib.c",
  "scr_hash.c",
  "scr_string.c",
  "scr_array.c",
  "scr_arena.c",
  "scr_map.c",
  "scr_exception.c",
  "scr_error.c",
  "scr_number.c",
  "scr_console.c",
  "scr_closure.c",
  "scr_ffi.c",
  "scr_object.c",
  "scr_union.c",
  "scr_cycle.c",
  "scr_alloc.c",
  "scr_json.c",
  "scr_inspect.c",
  "scr_bigint.c",
  "scr_async.c",
  "scr_async_dyn.c",
  "scr_child.c",
  "scr_path.c",
  "scr_url.c",
  "scr_url_params.c",
];

// The AES, GCM, ChaCha20 and Poly1305 modules, and the generic cipher layer
// GCM is built on with the default configuration.
const mbedtlsSources = [
  "aes.c",
  "aesce.c",
  "aesni.c",
  "aria.c",
  "camellia.c",
  "ccm.c",
  "chacha20.c",
  "chachapoly.c",
  "cipher.c",
  "cipher_wrap.c",
  "constant_time.c",
  "des.c",
  "gcm.c",
  "nist_kw.c",
  "platform_util.c",
  "poly1305.c",
];

// Compiled once with ASan + the RC audit. test_cipher.c includes
// scr_cipher.c, moves contexts next to mbedTLS's GCM message and AAD
// limits, and checks that a failed update() or setAAD() returns no data
// and leaves every later call throwing, and that chacha20-poly1305
// decryption without a tag fails in final().
beforeAll(async () => {
  await mkdir(join(testDir, "build"), { recursive: true });
  await execFileAsync("clang", [
    "-std=c11",
    "-O1",
    "-Wall",
    "-Wextra",
    "-Wno-missing-field-initializers",
    "-fsanitize=address,undefined",
    "-DSCR_RC_AUDIT",
    "-I",
    join(testDir, "../src"),
    "-I",
    join(mbedtls, "include"),
    "-I",
    join(mbedtls, "library"),
    "-o",
    bin,
    join(testDir, "test_cipher.c"),
    ...runtimeSources.map((source) => join(testDir, "../src", source)),
    ...mbedtlsSources.map((source) => join(mbedtls, "library", source)),
    "-Wno-deprecated-declarations",
    "-lz",
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ]);
}, 300_000);

test("cipher runtime: backend failures retire the context", async () => {
  const { stderr } = await execFileAsync(bin, [], {
    env: { ...process.env, UBSAN_OPTIONS: "halt_on_error=1" },
  });
  expect(stderr.trim().split("\n").pop()).toMatch(/^(\d+)\/\1 cases passed$/);
});
