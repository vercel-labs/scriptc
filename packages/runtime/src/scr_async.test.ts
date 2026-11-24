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
    // The gated async unit: the AsyncResource handle and its payload.
    join(import.meta.dirname, "scr_async_dyn.c"),
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
test("the promise resource table survives tombstone churn", async () => {
  const result = await execFileAsync(bin, ["promises"]);
  expect(result.stdout).toBe("promise table survives tombstone churn\n");
  expect(withoutContextWarning(result.stderr)).toBe("");
});

test("a destroyed AsyncResource keeps its context until the resource is freed", async () => {
  const result = await execFileAsync(bin, ["destroy"]);
  expect(result.stdout).toBe(
    "a destroyed async resource keeps its context until the resource is freed\n",
  );
  expect(withoutContextWarning(result.stderr)).toBe("");
});

test("AsyncResource bindings own their payload and release it", async () => {
  const result = await execFileAsync(bin, ["bindings"]);
  expect(result.stdout).toBe("async resource bindings own and release their payload\n");
  expect(withoutContextWarning(result.stderr)).toBe("");
});

test("a promiseResolve hook may drop the settling promise's owner", async () => {
  const result = await execFileAsync(bin, ["settlehook"]);
  expect(result.stdout).toBe("a promiseResolve hook may drop the settling promise's owner\n");
  expect(withoutContextWarning(result.stderr)).toBe("");
});

test("a store and a resource that hold each other are collected", async () => {
  const result = await execFileAsync(bin, ["cycle"]);
  expect(result.stdout).toBe("a store and a resource that hold each other are collected\n");
  expect(withoutContextWarning(result.stderr)).toBe("");
});

test("teardown releases cyclic stores without walking a disposed snapshot", async () => {
  const result = await execFileAsync(bin, ["teardown"]);
  expect(result.stdout).toBe(
    "teardown releases cyclic stores without walking a disposed snapshot\n",
  );
  expect(withoutContextWarning(result.stderr)).toBe("");
});

test("an AsyncResource handle owns its payload", async () => {
  const result = await execFileAsync(bin, ["resources"]);
  expect(result.stdout).toBe("async resource handles own their payload\n");
  expect(withoutContextWarning(result.stderr)).toBe("");
});

test("executionAsyncResource answers a handle that owns its reference", async () => {
  const result = await execFileAsync(bin, ["execres"]);
  expect(result.stdout).toBe("async resource execution resource owns its reference\n");
  expect(withoutContextWarning(result.stderr)).toBe("");
});

test("disposing an AsyncResource queues its destroy", async () => {
  const result = await execFileAsync(bin, ["autodestroy"]);
  expect(result.stdout).toBe("async resource disposal queues its destroy\n");
  expect(withoutContextWarning(result.stderr)).toBe("");
});

test("a bound function's resource queues its destroy when the binding drops", async () => {
  const result = await execFileAsync(bin, ["binddestroy"]);
  expect(result.stdout).toBe("async resource bindings queue their destroy\n");
  expect(withoutContextWarning(result.stderr)).toBe("");
});

test("a collected resource cycle queues its destroy", async () => {
  const result = await execFileAsync(bin, ["cycledestroy"]);
  expect(result.stdout).toBe("collected async resources queue their destroy\n");
  expect(withoutContextWarning(result.stderr)).toBe("");
});

test("due timers run by deadline, then by creation, before the turn's immediates", async () => {
  const result = await execFileAsync(bin, ["timers"]);
  expect(result.stdout).toBe(
    "due timers run by deadline, then by creation, before the turn's immediates\n",
  );
  expect(withoutContextWarning(result.stderr)).toBe("");
});

test("a timer armed during a turn runs after that turn's immediates", async () => {
  const result = await execFileAsync(bin, ["turnorder"]);
  expect(result.stdout).toBe(
    "a timer armed during a turn runs after that turn's immediates\n" +
      "a timer armed by an I/O callback runs after that turn's immediates\n" +
      "a timer armed by a startup tick runs before that turn's immediates\n",
  );
  expect(withoutContextWarning(result.stderr)).toBe("");
});

// The queue's capacity is the white-box part: a program sees it only as
// memory that grows with every immediate it ever queued, and as a
// clearImmediate that gets slower with them.
test("the immediate queue reuses its slots and finds the newest immediate at its end", async () => {
  const result = await execFileAsync(bin, ["immediates"]);
  expect(result.stdout).toBe(
    "the immediate queue reuses the slots of immediates that ran or were cleared\n" +
      "clearing the newest immediate does not walk the cleared ones\n",
  );
  expect(withoutContextWarning(result.stderr)).toBe("");
});
