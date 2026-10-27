import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_dh");
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

// The bignum modules scr_dh.c uses.
const mbedtlsSources = ["bignum.c", "bignum_core.c", "constant_time.c", "platform_util.c"];

// Compiled once with ASan, UBSan and the RC audit. test_dh.c includes
// scr_dh.c and checks the primality tests' Montgomery exponentiation
// against mbedTLS's, the primality test on primes, Carmichael numbers and
// strong pseudoprimes, exponents past mbedTLS's 8192-bit limit, DH_check
// results, and generated safe primes.
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
    join(testDir, "test_dh.c"),
    ...runtimeSources.map((source) => join(testDir, "../src", source)),
    ...mbedtlsSources.map((source) => join(mbedtls, "library", source)),
    "-Wno-deprecated-declarations",
    "-lz",
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ]);
}, 300_000);

test("DiffieHellman runtime: exponentiation, primality and safe primes", async () => {
  const { stderr } = await execFileAsync(bin, [], {
    env: { ...process.env, UBSAN_OPTIONS: "halt_on_error=1" },
  });
  expect(stderr.trim().split("\n").pop()).toMatch(/^(\d+)\/\1 cases passed$/);
}, 300_000);
