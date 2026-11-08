import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { EXECUTABLE_RUNTIME_SOURCES } from "../../compiler/src/backend/native-toolchain.js";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";

let dir = "";
let bin = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "scriptc-fiber-stacks-"));
  bin = join(dir, "fiber-stacks");
  await execFileAsync("clang", [
    "-std=c11",
    "-O1",
    "-Wall",
    "-Wextra",
    "-Wno-deprecated-declarations",
    "-pthread",
    ...(sanitize ? ["-fsanitize=address,undefined", "-DSCR_RC_AUDIT"] : []),
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
    join(import.meta.dirname, "scr_async.test.c"),
    ...EXECUTABLE_RUNTIME_SOURCES.filter((name) => name !== "scr_async.c").map((name) =>
      join(import.meta.dirname, name),
    ),
    ...(process.platform === "linux" ? ["-lm"] : []),
    "-o",
    bin,
  ]);
});

afterAll(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true });
});

function withoutContextWarning(stderr: string): string {
  return stderr.replace(
    /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext.*\n/gm,
    "",
  );
}

test("fiber stacks commit on demand and preserve large frames across suspension", async () => {
  const result = await execFileAsync(bin);
  expect(result.stdout).toBe("fiber stacks stay lazy and preserve large suspended frames\n");
  expect(withoutContextWarning(result.stderr)).toBe("");
});

// With every deadline already passed, the order is the timer heap's and the
// loop's, not the clock's: tests/corpus/timers-cross-kind-clears.ts once
// showed the first of these only when its own script ran fast enough.
test("due timers run by deadline, then by creation, before the turn's immediates", async () => {
  const result = await execFileAsync(bin, ["timers"]);
  expect(result.stdout).toBe(
    "due timers run by deadline, then by creation, before the turn's immediates\n",
  );
  expect(withoutContextWarning(result.stderr)).toBe("");
});
