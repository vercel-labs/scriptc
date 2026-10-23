/* The libnode bridge against a real pack, without the compiler: the C host
 * in bridge-smoke.c loads the pack the way scr_node_island.c does and makes
 * calls through the bridge with the runtime's embedded bootstrap. Needs a
 * pack in SCRIPTC_LIBNODE; required in the Linux x64 CI lanes
 * (tests/harness/libnode.ts). */
import { bridgeAbi } from "../build-pack.mjs";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { libnodePack } from "../../../tests/harness/libnode.js";

const execFileAsync = promisify(execFile);
const here = import.meta.dirname;
const outDir = join(here, "../../../node_modules/.cache/scriptc-tests/libnode-bridge");

test("a libnode pack runs calls through the bridge", async ({ skip }) => {
  const pack = libnodePack();
  if (pack === null) return skip();
  mkdirSync(outDir, { recursive: true });
  const module = join(outDir, "smoke.cjs");
  writeFileSync(
    module,
    `"use strict";
exports.add = (a, b) => a + b;
exports.fails = () => { const e = new RangeError("out of range"); e.code = "ERR_X"; throw e; };
exports.later = (ms) => new Promise((resolve) => setTimeout(() => resolve({ waited: ms }), ms));
exports.quit = (code) => process.exit(code);
`,
  );
  const binary = join(outDir, "bridge-smoke");
  await execFileAsync("cc", [
    "-O1",
    "-I",
    join(here, "../../runtime/src"),
    join(here, "bridge-smoke.c"),
    "-ldl",
    "-o",
    binary,
  ]);
  const result = await execFileAsync(binary, [pack, module], { encoding: "utf8" }).then(
    ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
    (err: { stdout: string; stderr: string; code: number }) => err,
  );
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(
    [
      `abi ${bridgeAbi()} ok 1`,
      "sync add -> R5",
      'sync fails -> T{"error":{"kind":2,"message":"out of range","code":"ERR_X"}}',
      `sync missing -> T{"error":{"kind":1,"message":"'missing' exported by './smoke.cjs' is not a function"}}`,
      "async later -> pending",
      'settle 7 R{"waited":5}',
      "exit 3",
      "",
    ].join("\n"),
  );
  expect(result.code).toBe(3);
});
