import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, expect, test } from "vitest";
// @ts-expect-error -- a plain ESM helper of the runner script
import { sameTermination, termination } from "../node-parallel/verdict.mjs";

const repo = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(tmpdir(), "scriptc-node-parallel-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("runs that end by different signals, or by a signal and an exit, differ", () => {
  expect(sameTermination({ code: 0, signal: null }, { code: 0, signal: null })).toBe(true);
  expect(
    sameTermination({ code: null, signal: "SIGABRT" }, { code: null, signal: "SIGABRT" }),
  ).toBe(true);
  expect(
    sameTermination({ code: null, signal: "SIGABRT" }, { code: null, signal: "SIGSEGV" }),
  ).toBe(false);
  expect(sameTermination({ code: 1, signal: null }, { code: null, signal: "SIGKILL" })).toBe(false);
  expect(sameTermination({ code: 0, signal: null }, { code: 1, signal: null })).toBe(false);
  expect(termination({ code: null, signal: "SIGSEGV" })).toBe("SIGSEGV");
  expect(termination({ code: 0, signal: null })).toBe(0);
});

test("a relative --node path links the checkout's fixtures into the minimal tree", () => {
  const checkout = join(scratch, "node");
  mkdirSync(join(checkout, "test", "parallel"), { recursive: true });
  mkdirSync(join(checkout, "test", "fixtures"), { recursive: true });
  mkdirSync(join(checkout, "test", "common"), { recursive: true });
  writeFileSync(join(checkout, "test", "fixtures", "marker.txt"), "fixture\n");
  writeFileSync(join(checkout, "test", "common", "fixtures.js"), "module.exports = {};\n");
  const out = join(scratch, "out");
  const result = spawnSync(
    process.execPath,
    [
      join(repo, "tests/node-parallel/run.mjs"),
      "--node",
      relative(scratch, checkout),
      "--pattern",
      "^no-such-test$",
      "--out",
      out,
    ],
    { cwd: scratch, encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  const linked = join(out, "tree", "test", "fixtures", "marker.txt");
  expect(existsSync(linked)).toBe(true);
  expect(readFileSync(linked, "utf8")).toBe("fixture\n");
});
