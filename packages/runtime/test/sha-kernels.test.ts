import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_sha_kernels");

// test_sha_kernels.c includes scr_lib.c, so it is not in this list.
const runtimeSources = [
  "scr_shared.c",
  "scr_bytes.c",
  "scr_bytes.test.c",
  "scr_bytes_io.c",
  "scr_fs_cp.c",
  "scr_zlib.c",
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

// Compiled once with ASan, UBSan and the RC audit. The test runs the SHA-NI and portable
// SHA-1/SHA-256 blocks and the SHA-512 kernels over the same inputs and checks known vectors.
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
    "-o",
    bin,
    join(testDir, "test_sha_kernels.c"),
    ...runtimeSources.map((source) => join(testDir, "../src", source)),
    "-lz",
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ]);
}, 300_000);

test("SHA-1, SHA-256, SHA-384 and SHA-512: the CPU kernels match the portable blocks", async () => {
  const { stderr } = await execFileAsync(bin, [], {
    env: { ...process.env, UBSAN_OPTIONS: "halt_on_error=1" },
  });
  expect(stderr.trim().split("\n").pop()).toMatch(/^(\d+)\/\1 cases passed$/);
});
