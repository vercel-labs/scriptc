import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// Whether a program is compiled as one that uses workers is decided by what
// its own source does, never by an object it holds. A JavaScript source that
// holds `process` holds process.getBuiltinModule with it, and that loader's
// inventory lists worker_threads.SHARE_ENV, whose value lives in the worker
// unit. These are native-only contracts (the module record and a refusal),
// so they are not differential programs; the behaviour Node shares is in
// tests/corpus/held-process-loader-*.mjs.
async function build(source: string): Promise<{
  workers: boolean;
  stdout: string;
  stderr: string;
  code: number;
}> {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-held-process-workers-"));
  const entry = join(outDir, "main.mjs");
  writeFileSync(entry, source);
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    emitIr: true,
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return { workers: false, stdout: "", stderr: "", code: -1 };
  const module = JSON.parse(readFileSync(result.irPath!, "utf8")) as { workers?: boolean };
  const workers = module.workers === true;
  try {
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    return { workers, stdout, stderr, code: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return {
      workers,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
      code: failed.code ?? -1,
    };
  }
}

const REFUSAL =
  "native builtin 'worker_threads.SHARE_ENV' is not supported through process.getBuiltinModule yet [SC2020]";

test("holding process does not make a program one that uses workers", async () => {
  const { workers, stdout, stderr, code } = await build(`const pass = (value) => value;
const host = pass(process);
const ids = ["worker_threads", "node:os"];
const threads = host.getBuiltinModule(ids[0]);
console.log(typeof host.getBuiltinModule, threads.isMainThread, threads.threadId);
console.log(host.getBuiltinModule(ids[1]).platform() === host.platform);
`);
  expect(workers).toBe(false);
  expect(stderr).toBe("");
  expect(stdout).toBe("function true 0\ntrue\n");
  expect(code).toBe(0);
});

test("SHARE_ENV through a held process object is refused by name where it is read", async () => {
  const { workers, stdout, stderr, code } = await build(`const pass = (value) => value;
const host = pass(process);
const ids = ["worker_threads"];
const threads = host.getBuiltinModule(ids[0]);
console.log("before", threads.isMainThread);
let outcome = "no error";
try {
  outcome = typeof threads.SHARE_ENV;
} catch (error) {
  outcome = error.message;
}
console.log(outcome);
console.log("uncaught", typeof host.getBuiltinModule(ids[0]).SHARE_ENV);
console.log("after");
`);
  expect(workers).toBe(false);
  expect(stdout).toBe(`before true\n${REFUSAL}\n`);
  expect(stderr).toContain(REFUSAL);
  expect(code).toBe(1);
});

test("the loader spelled in the source answers SHARE_ENV for an id the compiler cannot see", async () => {
  const { workers, stdout, stderr, code } = await build(`const load = process.getBuiltinModule;
const ids = ["worker_threads"];
const symbol = load(ids[0]).SHARE_ENV;
const pass = (value) => value;
console.log(typeof symbol, pass(process).getBuiltinModule(ids[0]).SHARE_ENV === symbol);
`);
  expect(workers).toBe(true);
  expect(stderr).toBe("");
  expect(stdout).toBe("symbol true\n");
  expect(code).toBe(0);
});
