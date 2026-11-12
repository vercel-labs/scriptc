import { execFile } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";
import { buildCFixture } from "./build-c.js";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const srcDir = join(testDir, "../src");
const bin = join(testDir, "build", "test_spkac_shared");
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
  // The worker-enabled units reach the per-thread context.
  "scr_context.c",
  "scr_json.c",
  "scr_inspect.c",
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

// Compiled once with ASan, UBSan and the RC audit, with SCR_WORKERS on so
// the shared-input snapshot is part of the build. test_spkac_shared.c
// includes scr_pki.c and calls the three SPKAC methods with a spkac argument
// backed by SharedArrayBuffer storage: each method must release the
// reference it owns exactly once, leaving the snapshot's cleanup to release
// its copy.
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
  await buildCFixture({
    output: bin,
    sources: [
      join(testDir, "test_spkac_shared.c"),
      ...runtimeSources.map((source) => join(srcDir, source)),
      ...mbedtlsSources.map((source) => join(mbedtls, "library", source)),
    ],
    flags: [
      "-std=c11",
      "-O1",
      "-Wall",
      "-Wextra",
      "-Wno-missing-field-initializers",
      "-Wno-deprecated-declarations",
      "-fsanitize=address,undefined",
      "-DSCR_RC_AUDIT",
      "-DSCR_WORKERS",
      "-I",
      srcDir,
      "-I",
      testDir,
      "-I",
      join(mbedtls, "include"),
      "-I",
      join(mbedtls, "library"),
      ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-pthread"] : []),
    ],
    libraries: ["-lz", ...(process.platform === "linux" ? ["-lm", "-lpthread"] : [])],
  });
}, 600_000);

test("spkac runtime: a shared input is released once", async () => {
  const { stdout, stderr } = await execFileAsync(bin, [], {
    env: { ...process.env, UBSAN_OPTIONS: "halt_on_error=1" },
  });
  expect(stdout.trim()).toBe("spkac shared input checks passed");
  expect(stderr).toBe("");
});
