import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_string");

// Compiles the C-side oracle test once for both tests below. Built with
// ASan + the RC audit so the oracle run also proves the new string
// functions neither leak nor double-free across ~26k calls.
beforeAll(async () => {
  await mkdir(join(testDir, "build"), { recursive: true });
  await execFileAsync("clang", [
    "-std=c11",
    "-O1",
    "-Wall",
    "-Wextra",
    "-fsanitize=address",
    "-DSCR_RC_AUDIT",
    "-DSCR_SIDX_TEST",
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
    "-o",
    bin,
    join(testDir, "test_string.c"),
    join(testDir, "../src/scr_string.c"),
    join(testDir, "../src/scr_number.c"),
    // scr_str_split returns a real string[]: the array module and its
    // own dependencies join the link (the array.test.ts set).
    join(testDir, "../src/scr_array.c"),
    join(testDir, "../src/scr_arena.c"),
    // Checked-value collection equality shares the native JSON value runtime.
    join(testDir, "../src/scr_json.c"),
    join(testDir, "../src/scr_map.c"),
    join(testDir, "../src/scr_union.c"),
    join(testDir, "../src/scr_bigint.c"),
    join(testDir, "../src/scr_closure.c"),
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
    join(testDir, "../src/scr_object.c"),
    join(testDir, "../src/scr_cycle.c"),
    join(testDir, "../src/scr_alloc.c"),
    ...(process.platform === "linux" ? ["-lm"] : []),
  ]);
});

// Runs against the committed case file generated from Node via
// gen-string-cases.mjs. The first test below also verifies the checked-in
// oracle against the generator, so a stale result cannot pass. Covers UTF-16
// length/charCodeAt/indexOf/includes/startsWith/endsWith/slice/repeat/
// trim/trimStart/trimEnd/split/padStart/padEnd/charAt plus parseInt over
// ASCII, Latin-1, CJK, astral, and combining-mark strings, including the
// documented lone-surrogate → U+FFFD divergence.
//
// parseInt cases whose Node answer differs between arm64 and x64 are
// recorded once per architecture ("parseInt.arm64" / "parseInt.x64", see
// ARCH_PARSEINT in gen-string-cases.mjs), so the generated file is the same
// on either machine and the C harness checks this architecture's answer.
test("committed string oracle matches Node", async () => {
  const caseFile = join(testDir, "string-cases.txt");
  const [{ stdout }, committed] = await Promise.all([
    execFileAsync(process.execPath, [join(testDir, "gen-string-cases.mjs")], {
      maxBuffer: 2 * 1024 * 1024,
    }),
    readFile(caseFile, "utf8"),
  ]);
  const generated = stdout.split("\n");
  const expected = committed.split("\n");
  expect(generated).toHaveLength(expected.length);
  expect(generated.filter((line, index) => line !== expected[index])).toEqual([]);
});

test("string methods match Node on committed oracle cases", async () => {
  const r = await execFileAsync(bin, [join(testDir, "string-cases.txt")]).then(
    (v) => ({ stderr: v.stderr }),
    (e: Error & { stderr?: string }) => ({ stderr: e.stderr ?? "" }),
  );
  expect(r.stderr.trim()).toMatch(/^(\d+)\/\1 cases passed$/);
});

// A template literal of strings and numbers allocates exactly its length:
// numbers format before the result is sized, not into a reserved maximum.
test("template-literal concatenation allocates its exact length", async () => {
  const { stderr } = await execFileAsync(bin, ["--concat-capacity"]);
  expect(stderr.trim()).toBe("0 concat capacity failures");
});

// repeat(count) with count < 0 or Infinity is Node's catchable RangeError
// ("Invalid count value: -1"); the runtime leaves it pending.
test.each([
  ["--crash-repeat", "-1"],
  ["--crash-repeat-inf", "Infinity"],
])("repeat throws a catchable RangeError (%s)", async (mode, shown) => {
  const { stderr } = await execFileAsync(bin, [mode]);
  expect(stderr).toContain(`Uncaught RangeError: Invalid count value: ${shown}`);
});
