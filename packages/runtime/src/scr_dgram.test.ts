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

// The fixture includes scr_dgram.c itself so it can hand the dispatch a
// batch of its own; the other units and the poller backends link beside it
// (each backend TU is empty off its platform).
const POLLER_BACKENDS = ["scr_loop_kqueue.c", "scr_loop_epoll.c", "scr_loop_wsapoll.c"];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "scriptc-dgram-dispatch-"));
  bin = join(dir, "dgram-dispatch");
  await execFileAsync("clang", [
    "-std=c11",
    "-O1",
    "-Wall",
    "-Wextra",
    "-Wno-deprecated-declarations",
    "-pthread",
    ...(sanitize ? ["-fsanitize=address,undefined", "-DSCR_RC_AUDIT"] : []),
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
    join(import.meta.dirname, "scr_dgram.test.c"),
    ...[...EXECUTABLE_RUNTIME_SOURCES, ...POLLER_BACKENDS]
      .filter((name) => name !== "scr_dgram.c")
      .map((name) => join(import.meta.dirname, name)),
    ...(process.platform === "linux" ? ["-lm"] : []),
    "-o",
    bin,
  ]);
});

afterAll(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true });
});

test("a poll key no registered socket owns is not read as one", async () => {
  const result = await execFileAsync(bin);
  expect(result.stdout).toBe("a key no socket owns is not read as a socket\n");
  expect(result.stderr).toBe("");
});
