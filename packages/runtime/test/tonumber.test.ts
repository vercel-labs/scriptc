import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;

// Compiles and runs the C-side oracle test for scr_string_to_number
// (ToNumber over strings — the Number(aString) / unary-+ lowering)
// against the committed case file (generated once from Node via
// gen-tonumber-cases.mjs — see that file to regenerate or fuzz). Every
// case asserts BIT equality with Node's Number(input): the StrWhiteSpace
// set, signed decimals with exponents through the boundary doubles
// (denormals, MAX_VALUE overflow, 2^53 neighbors), unsigned 0x/0o/0b
// with giant exact-integer inputs, and the garbage shapes that must be
// NaN. Built with ASan + the RC audit so the ~50k allocate/parse/release
// round-trips also prove the parser neither leaks nor double-frees.
test("scr_string_to_number matches Node Number(s) on committed oracle cases", async () => {
  const buildDir = join(testDir, "build");
  await mkdir(buildDir, { recursive: true });
  const bin = join(buildDir, "test_tonumber");
  await execFileAsync("clang", [
    "-std=c11", "-O1", "-Wall", "-Wextra",
    "-fsanitize=address", "-DSCR_RC_AUDIT",
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
    "-o", bin,
    join(testDir, "test_tonumber.c"),
    join(testDir, "../src/scr_string.c"),
    join(testDir, "../src/scr_number.c"),
    // scr_string.c's own link closure (the string.test.ts set):
    // scr_str_split pulls the array module and its dependencies.
    join(testDir, "../src/scr_array.c"),
    join(testDir, "../src/scr_bytes.c"),
    join(testDir, "../src/scr_error.c"),
    join(testDir, "../src/scr_exception.c"),
    join(testDir, "../src/scr_object.c"),
    join(testDir, "../src/scr_cycle.c"),
    ...(process.platform === "linux" ? ["-lm"] : []),
  ]);
  const { stderr } = await execFileAsync(bin, [join(testDir, "tonumber-cases.txt")]);
  expect(stderr.trim()).toMatch(/^(\d+)\/\1 cases passed$/);
}, 120_000);
