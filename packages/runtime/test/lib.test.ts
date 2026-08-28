import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_lib");
let scratch: string;

// Built with ASan + the RC audit: a clean exit also proves the library's
// ownership contract (borrowed fs args, +1 results, interned argv/platform
// released by the atexit cleanup before the audit runs).
beforeAll(async () => {
  await mkdir(join(testDir, "build"), { recursive: true });
  await execFileAsync("clang", [
    "-std=c11", "-O1", "-Wall", "-Wextra",
    "-fsanitize=address", "-DSCR_RC_AUDIT",
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
    "-I", join(testDir, "../src"),
    "-o", bin,
    join(testDir, "test_lib.c"),
    join(testDir, "../src/scr_lib.c"),
    join(testDir, "../src/scr_string.c"),
    join(testDir, "../src/scr_array.c"),
    join(testDir, "../src/scr_map.c"),
    join(testDir, "../src/scr_exception.c"),
    join(testDir, "../src/scr_error.c"),
    join(testDir, "../src/scr_number.c"),
    join(testDir, "../src/scr_console.c"),
    join(testDir, "../src/scr_closure.c"),
    join(testDir, "../src/scr_object.c"),
    join(testDir, "../src/scr_union.c"),
    join(testDir, "../src/scr_cycle.c"),
    join(testDir, "../src/scr_json.c"),
    join(testDir, "../src/scr_bytes.c"),
    ...(process.platform === "linux" ? ["-lm"] : []),
  ]);
  scratch = await mkdtemp(join(tmpdir(), "scriptc-lib-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// The C side runs process/fs happy paths as checks and routes each expected
// fs failure through scr_exc_print_uncaught. fs failures are Error
// INSTANCES whose messages carry Node's exact shape ("<ERRNO>: <text>,
// <syscall> '<path>'"), so the uncaught line renders "Error: <message>" —
// the same first line Node prints for an uncaught fs error. Typed catches
// observe the message itself (`e.message`, corpus-covered differentially);
// these lines pin OUR uncaught rendering.
test("process + fs library: checks pass, error messages match Node's shape", async () => {
  const { stdout, stderr } = await execFileAsync(bin, [scratch]);
  expect(stdout).toMatch(/^(\d+)\/\1 checks passed\n$/);
  expect(stderr).toBe(
    [
      `Uncaught Error: ENOENT: no such file or directory, open '${scratch}/missing.txt'`,
      `Uncaught Error: ENOENT: no such file or directory, lstat '${scratch}/missing.txt'`,
      `Uncaught Error: ENOENT: no such file or directory, rmdir '${scratch}/missing.txt'`,
      `Uncaught Error: ENOENT: no such file or directory, scandir '${scratch}/missing.txt'`,
      `Uncaught Error: EEXIST: file already exists, mkdir '${scratch}/sub'`,
      `Uncaught Error: ENOENT: no such file or directory, mkdir '${scratch}/nope/deep'`,
      `Uncaught Error: EISDIR: illegal operation on a directory, rm '${scratch}/sub'`,
      ``,
    ].join("\n"),
  );
});
