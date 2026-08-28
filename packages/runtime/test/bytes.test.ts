import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_bytes");
let scratch: string;

// Compiled once with ASan + the RC audit: the assertions in test_bytes.c
// cover the ToUint8/ToUint32 coercion matrix, ToIndex construction,
// slice/set copies, the utf8/hex/base64 conversions (invalid-utf8
// replacement included), concat, the u32be pair, the fs Buffer round trip,
// zlib deflate/inflate, and the RC recursion through SCR_ELEM_BYTES arrays
// — the sanitized run proves no leak/double-free across all of them.
beforeAll(async () => {
  await mkdir(join(testDir, "build"), { recursive: true });
  await execFileAsync("clang", [
    "-std=c11", "-O1", "-Wall", "-Wextra",
    "-fsanitize=address", "-DSCR_RC_AUDIT",
    "-I", join(testDir, "../src"),
    "-o", bin,
    join(testDir, "test_bytes.c"),
    join(testDir, "../src/scr_bytes.c"),
    join(testDir, "../src/scr_bytes_io.c"),
    join(testDir, "../src/scr_zlib.c"),
    join(testDir, "../src/scr_lib.c"),
    join(testDir, "../src/scr_string.c"),
    join(testDir, "../src/scr_array.c"),
    join(testDir, "../src/scr_map.c"),
    join(testDir, "../src/scr_exception.c"),
    join(testDir, "../src/scr_error.c"),
    join(testDir, "../src/scr_number.c"),
    join(testDir, "../src/scr_console.c"),
    join(testDir, "../src/scr_closure.c"),
    join(testDir, "../src/scr_ffi.c"),
    join(testDir, "../src/scr_object.c"),
    join(testDir, "../src/scr_union.c"),
    join(testDir, "../src/scr_cycle.c"),
    join(testDir, "../src/scr_json.c"),
    join(testDir, "../src/scr_async.c"),
    join(testDir, "../src/scr_child.c"),
    join(testDir, "../src/scr_path.c"),
    join(testDir, "../src/scr_url.c"),
    "-Wno-deprecated-declarations",
    "-lz",
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ]);
  scratch = await mkdtemp(join(tmpdir(), "scriptc-bytes-"));
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

test("bytes runtime: coercions, encodings, zlib, fs, RC", async () => {
  const { stderr } = await execFileAsync(bin, [scratch]);
  expect(stderr.trim().split("\n").pop()).toMatch(/^(\d+)\/\1 cases passed$/);
});

// JS reads undefined / ignores writes out of bounds on typed arrays; both
// are unrepresentable, so the runtime traps (documented divergence, the
// array runtime's exact discipline).
test.each([
  ["--crash-get-oob", "typed array index 1 out of bounds (length 1)"],
  ["--crash-get-frac", "typed array index 0.5 out of bounds (length 1)"],
  ["--crash-set-oob", "typed array index 1 out of bounds (length 1)"],
])("trap aborts (%s)", async (mode, message) => {
  const err = await execFileAsync(bin, [mode]).then(
    () => {
      throw new Error(`expected ${mode} to abort`);
    },
    (e: Error & { signal?: string; stderr?: string }) => e,
  );
  expect(err.signal).toBe("SIGABRT");
  expect(err.stderr).toContain(`scriptc: RangeError: ${message}`);
});
