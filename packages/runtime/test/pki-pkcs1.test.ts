import { execFile } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_pki_pkcs1");
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
  // The color/style table the inspect unit reads through scr_util_style.h.
  "scr_util_style.c",
  "scr_bigint.c",
  "scr_async.c",
  "scr_async_dyn.c",
  // scr_pki.c's callback-style sign and verify complete through the loop's
  // defer queue, which lives in scr_crypto_async.c.
  "scr_crypto_async.c",
  "scr_child.c",
  "scr_path.c",
  "scr_url.c",
  "scr_url_params.c",
  "scr_ed25519.c",
];

// Compiled once with ASan, UBSan and the RC audit. test_pki_pkcs1.c includes
// scr_pki.c, generates an RSA key, and decrypts a block with valid PKCS#1 v1.5
// type 2 padding and one without: it checks both answers, and that the keyed
// work of the implicit rejection (the HMACs of the rejection key derivation
// and of the synthetic message and length) is finished either way, since
// finishing it only for a rejected ciphertext is the padding oracle the
// scheme removes.
beforeAll(async () => {
  await mkdir(join(testDir, "build"), { recursive: true });
  // The public-key layer reaches all of mbedTLS but its TLS and socket
  // modules, which nothing here links.
  const mbedtlsSources = (await readdir(join(mbedtls, "library")))
    .filter((name) => name.endsWith(".c") && !name.startsWith("ssl_"))
    .filter(
      (name) =>
        !["debug.c", "memory_buffer_alloc.c", "net_sockets.c", "padlock.c", "timing.c"].includes(
          name,
        ),
    )
    .sort();
  await execFileAsync("clang", [
    "-std=c11",
    "-O1",
    "-Wall",
    "-Wextra",
    "-Wno-missing-field-initializers",
    "-Wno-deprecated-declarations",
    "-fsanitize=address,undefined",
    "-DSCR_RC_AUDIT",
    "-I",
    join(testDir, "../src"),
    "-I",
    join(testDir),
    "-I",
    join(mbedtls, "include"),
    "-I",
    join(mbedtls, "library"),
    "-o",
    bin,
    join(testDir, "test_pki_pkcs1.c"),
    ...runtimeSources.map((source) => join(testDir, "../src", source)),
    ...mbedtlsSources.map((source) => join(mbedtls, "library", source)),
    "-lz",
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ]);
}, 300_000);

test("pkcs1 runtime: a rejected ciphertext does the same keyed work", async () => {
  const { stdout, stderr } = await execFileAsync(bin, [], {
    env: { ...process.env, UBSAN_OPTIONS: "halt_on_error=1" },
  });
  expect(stdout.trim()).toBe("pkcs1 implicit rejection");
  expect(stderr).toBe("");
});
