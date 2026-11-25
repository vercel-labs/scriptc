import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);

// scr_lib.c spells every process string, environment name/value, temporary
// directory and user name in UTF-8. On Windows that means each Win32 call
// goes through the W (UTF-16) form and a CP_UTF8 conversion: the A forms
// would spell the text in the active ANSI code page, which garbles anything
// outside it (CP932, CP1251, ...). The C side drives the round-trip with
// Japanese text and an astral code point and validates the bytes; on other
// platforms it re-checks the same API contract, where the conversions are
// the identity.
test("process surface round-trips non-ASCII strings as UTF-8", async () => {
  const testDir = import.meta.dirname;
  const srcDir = join(testDir, "../src");
  const buildDir = join(testDir, "build");
  const configuredCompiler = process.env["SCRIPTC_CC"];
  const compiler = configuredCompiler === "zigcc" ? "zig" : (configuredCompiler ?? "clang");
  const compilerArgs = configuredCompiler === "zigcc" ? ["cc"] : [];
  const windows = process.platform === "win32";
  await mkdir(buildDir, { recursive: true });
  const bin = join(buildDir, `test_win_ansi${windows ? ".exe" : ""}`);
  await execFileAsync(compiler, [
    ...compilerArgs,
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
    "-I",
    srcDir,
    "-o",
    bin,
    join(testDir, "test_win_ansi.c"),
    // scr_lib.c and the units it links against directly (the same set
    // lib.test.ts builds, without the sanitizer/audit instrumentation).
    join(srcDir, "scr_lib.c"),
    join(srcDir, "scr_hash.c"),
    join(srcDir, "scr_url.c"),
    join(srcDir, "scr_url_params.c"),
    join(srcDir, "scr_path.c"),
    join(srcDir, "scr_string.c"),
    join(srcDir, "scr_array.c"),
    join(srcDir, "scr_arena.c"),
    join(srcDir, "scr_map.c"),
    join(srcDir, "scr_exception.c"),
    join(srcDir, "scr_error.c"),
    join(srcDir, "scr_number.c"),
    join(srcDir, "scr_console.c"),
    join(srcDir, "scr_closure.c"),
    join(srcDir, "scr_object.c"),
    join(srcDir, "scr_union.c"),
    join(srcDir, "scr_cycle.c"),
    join(srcDir, "scr_alloc.c"),
    join(srcDir, "scr_json.c"),
    join(srcDir, "scr_bigint.c"),
    join(srcDir, "scr_bytes.c"),
    join(srcDir, "scr_shared.c"),
    join(srcDir, "scr_context.c"),
    // The Windows runtime pack adds scr_win.c: it supplies the MinGW-shaped
    // shims (arc4random_buf over RtlGenRandom, stpcpy) the CRT lacks there.
    ...(windows ? [join(srcDir, "scr_win.c")] : []),
    ...(windows ? ["-ladvapi32", "-liphlpapi", "-lws2_32"] : ["-lm"]),
  ]);
  const { stdout, stderr } = await execFileAsync(bin);
  expect(stdout).toMatch(/^\d+ checks, 0 failures\r?\n$/);
  expect(stderr).toBe("");
});
