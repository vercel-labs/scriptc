import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_json");

// Built with ASan + the RC audit: a clean exit also proves the checked-dynamic tree's
// recursive ownership — including trees abandoned mid-parse by syntax
// errors — leaks nothing and frees nothing twice.
beforeAll(async () => {
  await mkdir(join(testDir, "build"), { recursive: true });
  await execFileAsync("clang", [
    "-std=c11", "-O1", "-Wall", "-Wextra",
    "-fsanitize=address", "-DSCR_RC_AUDIT",
    "-I", join(testDir, "../src"),
    "-o", bin,
    join(testDir, "test_json.c"),
    join(testDir, "../src/scr_json.c"),
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
    join(testDir, "../src/scr_lib.c"),
    join(testDir, "../src/scr_bytes.c"),
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ]);
});

// The C side parses/inspects dyn values as checks and routes each expected
// failure through scr_exc_print_uncaught. Parse failures are SyntaxError
// INSTANCES (the depth cap a RangeError, dynCheck failures TypeErrors), so
// every uncaught line renders "name: message" — e.name is Node-exact while
// the V8-flavored message wording stays approximate (SEMANTICS.md): these
// lines pin OUR rendering, not Node's.
test("json runtime: parser, dyn, dynCheck failure path, stringify buffer", async () => {
  const { stdout, stderr } = await execFileAsync(bin);
  expect(stdout).toMatch(/^(\d+)\/\1 checks passed\n$/);
  expect(stderr).toBe(
    [
      `Uncaught SyntaxError: Unexpected end of JSON input`,
      `Uncaught SyntaxError: Unexpected end of JSON input`,
      `Uncaught SyntaxError: Expected property name or '}' in JSON at position 1`,
      `Uncaught SyntaxError: Unexpected end of JSON input`,
      `Uncaught SyntaxError: Expected ',' or ']' after array element in JSON at position 3`,
      `Uncaught SyntaxError: Expected ':' after property name in JSON at position 4`,
      `Uncaught SyntaxError: Expected property name or '}' in JSON at position 7`,
      `Uncaught SyntaxError: Expected property name or '}' in JSON at position 1`,
      `Uncaught SyntaxError: Unterminated string in JSON at position 0`,
      `Uncaught SyntaxError: Bad escaped character in JSON at position 6`,
      `Uncaught SyntaxError: Bad control character in string literal in JSON at position 6`,
      `Uncaught SyntaxError: Bad Unicode escape in JSON at position 5`,
      `Uncaught SyntaxError: No number after minus sign in JSON at position 1`,
      `Uncaught SyntaxError: Unterminated fractional number in JSON at position 2`,
      `Uncaught SyntaxError: Exponent part is missing a number in JSON at position 3`,
      `Uncaught SyntaxError: Unexpected non-whitespace character after JSON at position 2`,
      `Uncaught SyntaxError: Unexpected token 'n', "nul" is not valid JSON`,
      `Uncaught RangeError: Maximum call stack size exceeded`,
      `Uncaught TypeError: expected number at $.items[2].price, got string`,
      `Uncaught TypeError: expected object at $, got undefined`,
      ``,
    ].join("\n"),
  );
});
