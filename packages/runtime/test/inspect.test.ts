import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_inspect");

// Compiles the C-side oracle test once. Built with ASan + the RC audit so
// the run also proves the inspect engine neither leaks nor double-frees
// across every rendered frame.
beforeAll(async () => {
  await mkdir(join(testDir, "build"), { recursive: true });
  await execFileAsync("clang", [
    "-std=c11", "-O1", "-Wall", "-Wextra",
    "-fsanitize=address", "-DSCR_RC_AUDIT",
    "-o", bin,
    join(testDir, "test_inspect.c"),
    join(testDir, "../src/scr_inspect.c"),
    // scr_insp_dyn drives the layout engine through parsed JSON trees;
    // the JSON module and its dependencies join the link (scr_closure.c:
    // releasing a dyn tree releases SCR_DYN_FUNC boxes' closures).
    join(testDir, "../src/scr_json.c"),
    join(testDir, "../src/scr_closure.c"),
    join(testDir, "../src/scr_string.c"),
    join(testDir, "../src/scr_number.c"),
    join(testDir, "../src/scr_array.c"),
    join(testDir, "../src/scr_bytes.c"),
    join(testDir, "../src/scr_error.c"),
    join(testDir, "../src/scr_exception.c"),
    join(testDir, "../src/scr_object.c"),
    join(testDir, "../src/scr_cycle.c"),
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ]);
});

// Runs against the committed case file (generated once from Node v24's
// util.inspect via gen-inspect-cases.mjs — see that file to regenerate).
// Covers number formatting (-0, exponents), the string quoting ladder
// (single→double→backtick, C0/C1/DEL/lone-surrogate escapes, the
// 10000-char cap, per-line ` +` continuations), the layout engine over
// JSON trees (break-length edges, grid grouping, depth placeholders,
// unicode widths), and Buffer's <Buffer ..> form; the file pins Node's
// byte-exact answers.
test("util.inspect engine matches Node on committed oracle cases", async () => {
  const { stderr } = await execFileAsync(bin, [join(testDir, "inspect-cases.txt")]);
  expect(stderr.trim()).toMatch(/^(\d+)\/\1 cases passed$/);
});
