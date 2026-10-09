import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_regex");
const vendorDir = join(testDir, "../vendor/quickjs-ng");

// Compiled once with ASan + the RC audit: test_regex.c asserts the C-level
// contracts (RC accounting of results, catchable throws through the
// exception cell, CESU-8 pattern re-encoding, UTF-16 round-trips) directly
// against the vendored libregexp — the same objects regex-using static
// binaries link.
beforeAll(async () => {
  await mkdir(join(testDir, "build"), { recursive: true });
  await execFileAsync("clang", [
    // no -Wall/-Wextra: the vendored libunicode.c is not warning-clean
    "-std=c11",
    "-O1",
    "-fsanitize=address",
    "-DSCR_RC_AUDIT",
    "-I",
    vendorDir,
    "-o",
    bin,
    join(testDir, "test_regex.c"),
    join(testDir, "../src/scr_regex.c"),
    // scr_regex.c hosts assert.match and calls the assert throw/inspect
    // helpers — regex-linking binaries always carry scr_assert.c (native-toolchain.ts).
    join(testDir, "../src/scr_assert.c"),
    join(vendorDir, "libregexp.c"),
    join(vendorDir, "libunicode.c"),
    join(testDir, "../src/scr_string.c"),
    join(testDir, "../src/scr_map.c"),
    join(testDir, "../src/scr_array.c"),
    join(testDir, "../src/scr_json.c"),
    join(testDir, "../src/scr_bigint.c"),
    join(testDir, "../src/scr_exception.c"),
    join(testDir, "../src/scr_error.c"),
    join(testDir, "../src/scr_number.c"),
    join(testDir, "../src/scr_console.c"),
    join(testDir, "../src/scr_closure.c"),
    join(testDir, "../src/scr_object.c"),
    join(testDir, "../src/scr_union.c"),
    join(testDir, "../src/scr_cycle.c"),
    join(testDir, "../src/scr_alloc.c"),
    join(testDir, "../src/scr_lib.c"),
    join(testDir, "../src/scr_url.c"),
    join(testDir, "../src/scr_url_params.c"),
    join(testDir, "../src/scr_path.c"),
    join(testDir, "../src/scr_bytes.c"),
    join(testDir, "../src/scr_shared.c"),
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ]);
}, 60_000);

test("regex runtime: matching, substitutions, split, throws, RC accounting", async () => {
  const { stderr } = await execFileAsync(bin, []);
  expect(stderr.trim()).toMatch(/^(\d+)\/\1 cases passed$/);
});

// The native one-byte matcher (scr_regex_native.h) against lre_exec itself:
// random patterns over the translated subset and its bail-outs, random ASCII
// subjects, every start index; results and all capture slots must agree.
const fuzzBin = join(testDir, "build", "test_regex_native");

test("regex native matcher: differential fuzz against libregexp", async () => {
  await execFileAsync("clang", [
    "-std=c11",
    "-O1",
    "-fsanitize=address,undefined",
    "-fno-sanitize-recover=undefined",
    "-I",
    vendorDir,
    "-o",
    fuzzBin,
    join(testDir, "test_regex_native.c"),
    join(vendorDir, "libregexp.c"),
    join(vendorDir, "libunicode.c"),
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ]);
  for (const seed of ["1", "2", "3"]) {
    const { stderr } = await execFileAsync(fuzzBin, ["4000", seed]);
    expect(stderr.trim()).toMatch(/^\d+\/\d+ translated, \d+ checks$/);
  }
}, 120_000);
