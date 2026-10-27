import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_glob");
const vendorDir = join(testDir, "../vendor/quickjs-ng");

// Compiled once with ASan + the RC audit: the oracle run also proves the
// glob port neither leaks nor double-frees across the case file's calls.
// Segment regexes compile through the vendored libregexp, as in programs.
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
    join(testDir, "test_glob.c"),
    join(testDir, "../src/scr_glob.c"),
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
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ]);
}, 60_000);

// Runs against the committed case file, generated from Node v24's bundled
// minimatch with matchGlobPattern's options (gen-glob-cases.mjs): curated
// brace, extglob, class, globstar, dot, drive and UNC patterns over a path
// vocabulary, plus a seeded fuzz corpus, for both path families and both
// case modes.
test("path.matchesGlob matches Node on committed oracle cases", async () => {
  const { stderr } = await execFileAsync(bin, [join(testDir, "glob-cases.txt")], {
    maxBuffer: 16 * 1024 * 1024,
  });
  expect(stderr.trim()).toMatch(/^(\d+)\/\1 cases passed$/);
}, 120_000);
