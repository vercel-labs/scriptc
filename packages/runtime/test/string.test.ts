import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
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
    "-std=c11", "-O1", "-Wall", "-Wextra",
    "-fsanitize=address", "-DSCR_RC_AUDIT", "-DSCR_SIDX_TEST",
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
    "-o", bin,
    join(testDir, "test_string.c"),
    join(testDir, "../src/scr_string.c"),
    join(testDir, "../src/scr_number.c"),
    // scr_str_split returns a real string[]: the array module and its
    // own dependencies join the link (the array.test.ts set).
    join(testDir, "../src/scr_array.c"),
    join(testDir, "../src/scr_bytes.c"),
    join(testDir, "../src/scr_error.c"),
    join(testDir, "../src/scr_exception.c"),
    join(testDir, "../src/scr_object.c"),
    join(testDir, "../src/scr_cycle.c"),
    ...(process.platform === "linux" ? ["-lm"] : []),
  ]);
});

// Runs against the committed case file (generated once from Node via
// gen-string-cases.mjs — see that file to regenerate). Covers UTF-16
// length/charCodeAt/indexOf/includes/startsWith/endsWith/slice/repeat/
// trim/trimStart/trimEnd/split/padStart/padEnd/charAt plus parseInt over
// ASCII, Latin-1, CJK, astral, and combining-mark strings, including the
// documented lone-surrogate → U+FFFD divergence.
//
// On macOS every committed case matches byte-for-byte. On Linux (glibc,
// measured on the sandbox-suite lane's AL2023 clang 15) exactly two
// parseInt cases — giant base-36 inputs whose magnitude assembly rides
// libm — land one ulp away from V8's correctly-rounded conversion.
// scr_number.c is pinned and shared across every consumer, so the
// divergence is documented HERE as an allowlist keyed by exact input and
// exact divergent output: a third value, a new failing case, or a future
// conversion fix all fail loudly.
const LINUX_PARSEINT_ULP: ReadonlyMap<string, string> = new Map([
  [
    // parseInt("9007199254740993", 36): Node 1.9896986116031812e+24,
    // glibc lane 1.9896986116031807e+24.
    "parseInt(39303037313939323534373430393933 ; 36)",
    "312e39383936393836313136303331383037652b3234",
  ],
  [
    // parseInt("123456789012345678901234567890", 36):
    // Node 1.436287679432363e+45, glibc lane 1.4362876794323633e+45.
    "parseInt(313233343536373839303132333435363738393031323334353637383930 ; 36)",
    "312e34333632383736373934333233363333652b3435",
  ],
]);

test("string methods match Node on committed oracle cases", async () => {
  const r = await execFileAsync(bin, [join(testDir, "string-cases.txt")]).then(
    (v) => ({ stderr: v.stderr }),
    (e: Error & { stderr?: string }) => ({ stderr: e.stderr ?? "" }),
  );
  const stderr = r.stderr.trim();
  if (process.platform !== "linux") {
    expect(stderr).toMatch(/^(\d+)\/\1 cases passed$/);
    return;
  }
  const lines = stderr.split("\n");
  const mismatches = lines.filter((l) => l.startsWith("MISMATCH "));
  for (const line of mismatches) {
    const m = /^MISMATCH (.+) expected=[0-9a-f]* got=([0-9a-f]*)$/.exec(line);
    expect(m, `unparseable mismatch line: ${line}`).not.toBeNull();
    expect(LINUX_PARSEINT_ULP.get(m![1]!), line).toBe(m![2]);
  }
  // The harness prints at most 20 mismatch lines; the pass-count tail is
  // the ground truth that NOTHING beyond the printed (allowlisted) set
  // failed.
  const t = /^(\d+)\/(\d+) cases passed$/.exec(lines.at(-1) ?? "");
  expect(t, `missing pass-count line: ${lines.at(-1)}`).not.toBeNull();
  expect(Number(t![2]) - Number(t![1]), "failed-case count").toBe(mismatches.length);
  expect(mismatches.length).toBeLessThanOrEqual(LINUX_PARSEINT_ULP.size);
});

// repeat(count) with count < 0 or Infinity is a RangeError in JS; scriptc
// has no exceptions, so the runtime must print the error and abort().
test.each(["--crash-repeat", "--crash-repeat-inf"])(
  "repeat RangeError aborts (%s)",
  async (mode) => {
    const err = await execFileAsync(bin, [mode]).then(
      () => {
        throw new Error("expected scr_str_repeat to abort");
      },
      (e: Error & { signal?: string; stderr?: string }) => e,
    );
    expect(err.signal).toBe("SIGABRT");
    expect(err.stderr).toContain("scriptc: RangeError: Invalid count value");
  },
);
