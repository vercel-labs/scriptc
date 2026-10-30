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

test("a relative --node path links the checkout's fixtures and common helpers into the minimal tree", () => {
  const checkout = join(scratch, "node");
  mkdirSync(join(checkout, "test", "parallel"), { recursive: true });
  mkdirSync(join(checkout, "test", "fixtures"), { recursive: true });
  mkdirSync(join(checkout, "test", "common"), { recursive: true });
  writeFileSync(join(checkout, "test", "fixtures", "marker.txt"), "fixture\n");
  for (const helper of ["fixtures.js", "dns.js", "internet.js"])
    writeFileSync(
      join(checkout, "test", "common", helper),
      `module.exports = ${JSON.stringify(helper)};\n`,
    );
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
  for (const helper of ["dns.js", "internet.js"])
    expect(readFileSync(join(out, "tree", "test", "common", helper), "utf8")).toBe(
      `module.exports = ${JSON.stringify(helper)};\n`,
    );
  expect(existsSync(join(out, "tree", "test", "common", "tmpdir.js"))).toBe(true);
});

test("concurrent files get their own test/common tmpdir", () => {
  const checkout = join(scratch, "node-tmpdir");
  mkdirSync(join(checkout, "test", "parallel"), { recursive: true });
  mkdirSync(join(checkout, "test", "fixtures"), { recursive: true });
  mkdirSync(join(checkout, "test", "common"), { recursive: true });
  for (const helper of ["fixtures.js", "dns.js", "internet.js"])
    writeFileSync(join(checkout, "test", "common", helper), "module.exports = {};\n");
  // Each file refreshes the tmpdir, writes a marker and reads it back after
  // the other file has refreshed its own: with a shared directory the
  // marker is gone and the file exits with 1.
  const body = `const fs = require("fs");
const tmpdir = require("../common/tmpdir");
tmpdir.refresh();
fs.writeFileSync(tmpdir.resolve("marker"), __filename);
setTimeout(() => {
  process.exit(fs.existsSync(tmpdir.resolve("marker")) ? 0 : 1);
}, 500);
`;
  for (const name of ["test-tmp-a.js", "test-tmp-b.js"])
    writeFileSync(join(checkout, "test", "parallel", name), body);
  const failingCli = join(scratch, "failing-cli.mjs");
  writeFileSync(failingCli, "process.exit(1);\n");
  const out = join(scratch, "out-tmpdir");
  const result = spawnSync(
    process.execPath,
    [
      join(repo, "tests/node-parallel/run.mjs"),
      "--node",
      checkout,
      "--pattern",
      "^test-tmp-",
      "--out",
      out,
      "--cli",
      failingCli,
      "--jobs",
      "2",
    ],
    { cwd: scratch, encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as {
    nodeExit: number;
  }[];
  expect(results.map((r) => r.nodeExit)).toEqual([0, 0]);
});
