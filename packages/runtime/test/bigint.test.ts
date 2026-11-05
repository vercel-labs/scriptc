import { execFile, execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_bigint");

// Compiled with ASan + UBSan: test_bigint.c checks long division, radix
// conversion in every base, chunked parsing, Karatsuba and squaring, and
// the asIntN/asUintN widths against known values and exact identities.
beforeAll(async () => {
  await mkdir(join(testDir, "build"), { recursive: true });
  const args = [
    "-std=c11",
    "-O1",
    "-Wall",
    "-Wextra",
    "-fsanitize=address,undefined",
    "-fno-sanitize-recover=undefined",
    "-o",
    bin,
    join(testDir, "test_bigint.c"),
    join(testDir, "../src/scr_map.c"),
    join(testDir, "../src/scr_string.c"),
    join(testDir, "../src/scr_number.c"),
    join(testDir, "../src/scr_cycle.c"),
    join(testDir, "../src/scr_alloc.c"),
    // the _v RC adapters (scr_str_retain_v & co.) live with the unions,
    // which pull in the closure/array/box machinery
    join(testDir, "../src/scr_union.c"),
    join(testDir, "../src/scr_array.c"),
    join(testDir, "../src/scr_arena.c"),
    // Checked-value collection equality shares the native JSON value runtime.
    join(testDir, "../src/scr_json.c"),
    join(testDir, "../src/scr_bigint.c"),
    join(testDir, "../src/scr_closure.c"),
    join(testDir, "../src/scr_object.c"),
    join(testDir, "../src/scr_bytes.c"),
    join(testDir, "../src/scr_shared.c"),
    join(testDir, "../src/scr_lib.c"),
    join(testDir, "../src/scr_hash.c"),
    join(testDir, "../src/scr_console.c"),
    join(testDir, "../src/scr_path.c"),
    join(testDir, "../src/scr_url.c"),
    join(testDir, "../src/scr_url_params.c"),
    join(testDir, "../src/scr_error.c"),
    join(testDir, "../src/scr_exception.c"),
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ];
  await execFileAsync("clang", args);
});

test("bigint runtime: division, radix conversion, products, widths", async () => {
  const { stderr } = await execFileAsync(bin, []);
  expect(stderr.trim()).toMatch(/^(\d+)\/\1 cases passed$/);
});

function zigOnPath(): boolean {
  try {
    execFileSync("zig", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// 32-bit size_t: the size guards (scr_bigint_digits_fit and the limb-count
// checks) must compile, warning-free, where a bit count can wrap.
test.skipIf(!zigOnPath())("bigint runtime builds for wasm32 with its size guards", async () => {
  const out = join(testDir, "build", "scr_bigint.wasm32.o");
  await execFileAsync("zig", [
    "cc",
    "-target",
    "wasm32-wasi",
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-c",
    "-o",
    out,
    join(testDir, "../src/scr_bigint.c"),
  ]);
  const { stdout } = await execFileAsync("zig", ["nm", out]).catch(async () =>
    execFileAsync("llvm-nm", [out]),
  );
  expect(stdout).toContain("scr_bigint_digits_fit");
});
