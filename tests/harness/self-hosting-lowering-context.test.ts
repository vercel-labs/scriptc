import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compileInChild } from "./self-hosting-compiler-process.js";
import { ts7Executable } from "../../packages/compiler/src/frontend/ts7/rpc-api.js";

const root = join(import.meta.dirname, "../..");
const entry = join(root, "tests/fixtures/self-hosting/lowering-context.ts");
const oracle = join(root, "tests/fixtures/self-hosting/lowering-context-node.ts");
const nativeSources = join(root, "packages/compiler/native");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

// One build lowers the fixture's frontend and emits it: measured as a single
// file on four pinned CPUs (the CI lane's size), 100 s plain and 109 s
// sanitized, so the default 300 s budget is the hang detector this file
// needs. The analyze pass this replaces lowered the same program a second
// time and took the sanitized case to 221 s, past the budget under a loaded
// lane (test (Linux, san, 5/20)).

const directory = mkdtempSync(
  join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-lowering-context-"),
);
const profile = join(directory, "ffi.json");
const source = join(directory, "input.ts");
let nodeStdout = "";
let nodeStderr = "";
let nodeReport: { first: string[]; second: string[] };

// The Node oracle loads and preflights the fixture; its report is the
// differential baseline the native client must reproduce. It runs once, in
// setup, so the case below reports its own budget.
beforeAll(() => {
  const object = join(directory, "process.o");
  execFileSync("clang", [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    ...(sanitize ? ["-fsanitize=address"] : []),
    "-c",
    join(nativeSources, "ts7-process.c"),
    "-o",
    object,
  ]);
  writeFileSync(
    profile,
    JSON.stringify({
      ...JSON.parse(readFileSync(join(nativeSources, "ts7-process.ffi.json"), "utf8")),
      libraries: [object],
    }),
  );
  writeFileSync(
    source,
    `
        export const value = 1;
        export function shadow(): number { const value = 2; return value; }
        export const unused = 3;
      `,
  );
  const expected = join(directory, "node.json");
  const node = spawnSync(
    process.execPath,
    ["--import", "tsx", oracle, ts7Executable(), source, expected],
    {
      encoding: "utf8",
      timeout: 90_000,
    },
  );
  expect(node.error, node.stderr).toBeUndefined();
  expect(node.status, node.stderr).toBe(0);
  expect(node.stdout).toBe("");
  expect(node.stderr).toBe("");
  nodeStdout = node.stdout;
  nodeStderr = node.stderr;
  nodeReport = JSON.parse(readFileSync(expected, "utf8")) as {
    first: string[];
    second: string[];
  };
  expect(nodeReport.first).toHaveLength(16);
  expect(nodeReport.second).toEqual(nodeReport.first);
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

for (const backend of ["llvm"] as const) {
  test(`production lexical contexts run with native TS7 symbols (${backend})`, async () => {
    // The build's own frontend pass is the coverage check: a build fails on
    // a preflight diagnostic, and the stats below are what a second
    // analyze() pass would lower the same program again to compute. They
    // are absent only on an executable cache hit, which this case's fresh
    // temporary outDir keeps out of reach.
    const built = await compileInChild(entry, {
      backend,
      optimization: "dev",
      sanitize,
      ffiProfilePath: profile,
      outDir: directory,
      outPath: join(directory, process.platform === "win32" ? "contexts.exe" : "contexts"),
    });
    if (!built.ok)
      throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    if (built.stats === undefined)
      throw new Error("the build lowered the program but reported no lowering stats");
    expect(built.stats.statementsFailed).toBe(0);
    expect(built.stats.functionsSkipped).toBe(0);
    expect(built.backend).toBe(backend);

    const output = join(directory, "native.json");
    const run = spawnSync(built.binaryPath, [ts7Executable(), source, output], {
      encoding: "utf8",
      timeout: 90_000,
    });
    expect(run.error, run.stderr).toBeUndefined();
    expect(run.signal, run.stderr).toBeNull();
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe(nodeStdout);
    expect(run.stderr).toBe(nodeStderr);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(nodeReport);
  });
}
