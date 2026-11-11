import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";
import { buildCFixture } from "./build-c.js";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_regex");
const vendorDir = join(testDir, "../vendor/quickjs-ng");
const linux = process.platform === "linux";

// Compiled once with ASan + the RC audit: test_regex.c asserts the C-level
// contracts (RC accounting of results, catchable throws through the
// exception cell, CESU-8 pattern re-encoding, UTF-16 round-trips) directly
// against the vendored libregexp — the same objects regex-using static
// binaries link.
// The 27 units compile side by side (buildCFixture): one clang process over
// all of them took 42 to 46 s of a free 24-core machine and 49 to 68 s beside
// a test lane's other workers, and the hook's former 60 s bound failed 67
// lane rounds on 2026-11-07. Side by side the same builds took 11 to 13 s
// and 13 to 25 s. The hook keeps the suite's hook timeout (vitest.config.ts),
// a hang detector: the busiest lane machines have run a ten-second parallel
// build (the mbedTLS archive of native-toolchain.test.ts) in 87 s at the median.
beforeAll(async () => {
  await buildCFixture({
    output: bin,
    // no -Wall/-Wextra: the vendored libunicode.c is not warning-clean
    flags: [
      "-std=c11",
      "-O1",
      "-fsanitize=address",
      "-DSCR_RC_AUDIT",
      "-I",
      vendorDir,
      ...(linux ? ["-D_GNU_SOURCE"] : []),
    ],
    sources: [
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
      join(testDir, "../src/scr_arena.c"),
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
      join(testDir, "../src/scr_hash.c"),
      join(testDir, "../src/scr_url.c"),
      join(testDir, "../src/scr_url_params.c"),
      join(testDir, "../src/scr_path.c"),
      join(testDir, "../src/scr_bytes.c"),
      join(testDir, "../src/scr_shared.c"),
    ],
    libraries: linux ? ["-lm"] : [],
  });
});

test("regex runtime: matching, substitutions, split, throws, RC accounting", async () => {
  const { stderr } = await execFileAsync(bin, []);
  expect(stderr.trim()).toMatch(/^(\d+)\/\1 cases passed$/);
});

// The native one-byte matcher (scr_regex_native.h) against lre_exec itself:
// random patterns over the translated subset and its bail-outs, random ASCII
// subjects, every start index; results and all capture slots must agree.
// Patterns anchored at position 0 are searched with one attempt by both
// engines, and that search must agree with the reference search too.
const fuzzBin = join(testDir, "build", "test_regex_native");

test("regex native matcher: differential fuzz against libregexp", async () => {
  await buildCFixture({
    output: fuzzBin,
    flags: [
      "-std=c11",
      "-O1",
      "-fsanitize=address,undefined",
      "-fno-sanitize-recover=undefined",
      "-I",
      vendorDir,
      ...(linux ? ["-D_GNU_SOURCE"] : []),
    ],
    sources: [
      join(testDir, "test_regex_native.c"),
      join(vendorDir, "libregexp.c"),
      join(vendorDir, "libunicode.c"),
    ],
    libraries: linux ? ["-lm"] : [],
  });
  for (const seed of ["1", "2", "3"]) {
    const { stderr } = await execFileAsync(fuzzBin, ["4000", seed]);
    const summary = /^\d+\/\d+ translated, (\d+) anchored, \d+ checks$/.exec(stderr.trim());
    expect(summary, stderr).not.toBeNull();
    expect(Number(summary![1])).toBeGreaterThan(0);
  }
}, 120_000);

// The interpreter's WTF-8 subject type (the scriptc addition to the vendored
// libregexp) against its 16-bit subject type: random patterns with and
// without `u`, random subjects with characters of every width and unpaired
// surrogates, every start index; results and all captures must agree.
const wtf8Bin = join(testDir, "build", "test_regex_wtf8");

test("regex interpreter: WTF-8 subjects agree with UTF-16 subjects", async () => {
  await execFileAsync("clang", [
    "-std=c11",
    "-O1",
    "-fsanitize=address,undefined",
    "-fno-sanitize-recover=undefined",
    "-I",
    vendorDir,
    "-o",
    wtf8Bin,
    join(testDir, "test_regex_wtf8.c"),
    join(vendorDir, "libregexp.c"),
    join(vendorDir, "libunicode.c"),
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ]);
  for (const seed of ["1", "2", "3"]) {
    const { stderr } = await execFileAsync(wtf8Bin, ["6000", seed]);
    const summary =
      /^\d+ patterns, \d+ checks, (\d+) matches, (\d+) captures between the halves of a pair$/.exec(
        stderr.trim(),
      );
    expect(summary, stderr).not.toBeNull();
    expect(Number(summary![1])).toBeGreaterThan(1000);
    expect(Number(summary![2])).toBeGreaterThan(10);
  }
}, 120_000);
