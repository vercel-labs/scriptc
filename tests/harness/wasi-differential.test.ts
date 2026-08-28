/* wasm32-wasi is a production LLVM target. This lane compares
 * pointer-width-sensitive corpus seeds against Node and pins the backend
 * selection independently of the host platform.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile, compileLibrary } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const islandShim = join(import.meta.dirname, "island-shim.mjs");

function zigOnPath(): boolean {
  try {
    execFileSync("zig", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const WASI_RUNNER = [
  'const fs=require("node:fs")',
  'const {WASI}=require("node:wasi")',
  'const p=process.argv[1]',
  'const wasi=new WASI({version:"preview1",args:[p],env:{...process.env,PWD:"/",HOME:"/",TMPDIR:"/tmp"},preopens:{"/":process.cwd(),"/tmp":"/tmp"},returnOnExit:true})',
  'const mod=new WebAssembly.Module(fs.readFileSync(p))',
  'const instance=new WebAssembly.Instance(mod,wasi.getImportObject())',
  'process.exitCode=wasi.start(instance)',
].join(";");

async function run(cmd: string, args: string[], input = ""): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ stdout, stderr, exitCode: 0 });
      } else if (typeof error.code === "number") {
        resolve({ stdout, stderr, exitCode: error.code });
      } else {
        reject(error);
      }
    });
    // A closed pipe is the corpus harness's standard stdin. Closing it
    // explicitly also lets stdin/readline cases observe EOF under WASI.
    child.stdin?.end(input);
  });
}

function expectedExitCode(entry: string): number {
  const source = require("node:fs").readFileSync(entry, "utf8") as string;
  const match = /^\/\/ @exit:\s*(\d+)\s*$/m.exec(source);
  return match === null ? 0 : Number(match[1]);
}

describe.skipIf(!zigOnPath())("wasm32-wasi differential", () => {
  let oldCc: string | undefined;
  let oldTarget: string | undefined;

  beforeAll(() => {
    oldCc = process.env["SCRIPTC_CC"];
    oldTarget = process.env["SCRIPTC_TARGET"];
    process.env["SCRIPTC_CC"] = "zigcc";
    process.env["SCRIPTC_TARGET"] = "wasm32-wasi";
  });

  afterAll(() => {
    if (oldCc === undefined) delete process.env["SCRIPTC_CC"];
    else process.env["SCRIPTC_CC"] = oldCc;
    if (oldTarget === undefined) delete process.env["SCRIPTC_TARGET"];
    else process.env["SCRIPTC_TARGET"] = oldTarget;
  });

  test.each([
    "2700-wasi-core.ts",
    "1612-cjs-module-globals.cjs",
    "992-fs-roundtrip.ts",
    "751-cycle-records-mutual.ts",
    "1000-json-stringify-basics.ts",
    "1002-json-parse-cast.ts",
    "1010-json-stringify-space.ts",
    "1020-async-basics.ts",
    "1021-async-ordering.ts",
    "1022-async-exceptions.ts",
    "1023-async-rc-stress.ts",
    "1024-async-pending-exit.ts",
    "1025-async-promise-capture.ts",
    "1026-throw-promise.ts",
    "1027-async-return-promise.ts",
    "1028-async-return-record-literals.ts",
    "1029-async-eager-chains.ts",
    "1428-settled-await-order.ts",
    "1429-promise-catch-finally.ts",
    "1430-promise-race.ts",
    "1438-promise-all.ts",
    "1440-interval-basics.ts",
    "1444-exit-listeners.ts",
    "1447-stdin-closed-events.ts",
    "1475-readline-closed-stdin.ts",
    "1400-typedarray-basics.ts",
    "1409-typedarray-integer-loops.ts",
    "1551-dyn-receiver-methods.ts",
    "1558-any-joins-and-dyn-validation.ts",
    "1634-inspect-classes.ts",
    "1644-ee-basics.ts",
    "1666-dyn-fn-identity.ts",
    "1800-immediate-basics.ts",
    "1805-timer-callback-args.ts",
    "2010-generators-basics.ts",
    "2011-generators-forof.ts",
    "2012-generators-return-throw.ts",
    "2013-generators-sent-values.ts",
    "2014-generators-values.ts",
    "2015-generators-yieldstar.ts",
    "2016-generators-rc-stress.ts",
    "2017-generators-async.ts",
    "2018-generators-uncaught.ts",
    "2019-generators-loops.ts",
    "2093-timers-promises.ts",
    "2683-fs-rename-js.cjs",
  ])("the LLVM target runs %s byte-identically to Node", async (fixture) => {
    const entry = join(repoRoot, "tests/corpus", fixture);
    const outDir = await mkdtemp("/tmp/scriptc-wasi-");
    const outPath = join(outDir, "program.wasm");
    const result = await compile(entry, { outDir, outPath });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(result.backend).toBe("llvm");
    expect(result.cPath.endsWith(".ll")).toBe(true);
    expect([...(await readFile(outPath)).subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);

    const node = await run(process.execPath, ["--no-warnings", entry]);
    const wasm = await run(
      process.execPath,
      ["--no-warnings", "--experimental-wasi-unstable-preview1", "-e", WASI_RUNNER, outPath],
    );
    expect(wasm.stdout).toBe(node.stdout);
    expect(wasm.exitCode).toBe(expectedExitCode(entry));
    expect(node.exitCode).toBe(expectedExitCode(entry));
    if (wasm.exitCode === 0) expect(wasm.stderr).toBe(node.stderr);
  });

  test("the explicit LLVM pin emits wasm", async () => {
    const outDir = await mkdtemp("/tmp/scriptc-wasi-refusal-");
    const llvmResult = await compile(join(repoRoot, "tests/corpus/001-hello.ts"), {
      outDir,
      outPath: join(outDir, "llvm.wasm"),
      backend: "llvm",
    });
    expect(llvmResult.ok).toBe(true);
    if (llvmResult.ok) expect(llvmResult.backend).toBe("llvm");
  });

  test("library mode reports a target diagnostic instead of invoking the WASI toolchain", async () => {
    const outDir = await mkdtemp("/tmp/scriptc-wasi-library-");
    const result = await compileLibrary({
      profilePath: join(repoRoot, "tests/library-mode/scalars/profile.json"),
      outDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.code).toBe("SC3002");
      expect(result.diagnostics[0]?.message).toMatch(/does not support library-mode archive builds/);
    }
  });

  test("the explicit C backend still emits async-free wasm", async () => {
    const outDir = await mkdtemp("/tmp/scriptc-wasi-c-");
    const result = await compile(join(repoRoot, "tests/corpus/001-hello.ts"), {
      outDir,
      outPath: join(outDir, "program.wasm"),
      backend: "c",
    });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    expect(result.backend).toBe("c");
  });

  test("the explicit C backend diagnoses coroutine-dependent programs", async () => {
    const outDir = await mkdtemp("/tmp/scriptc-wasi-c-refusal-");
    const result = await compile(join(repoRoot, "tests/corpus/1020-async-basics.ts"), {
      outDir,
      outPath: join(outDir, "program.wasm"),
      backend: "c",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.code).toBe("SC3001");
      expect(result.diagnostics[0]?.message).toMatch(
        /c backend does not support an async function .* for wasm32-wasi; use --backend llvm/,
      );
    }
  });

  test("embedded source comments mentioning fetch do not trigger SC3002", async () => {
    const entry = join(repoRoot, "tests/fixtures/npm/cases/island-web-plumbing/main.ts");
    const outDir = await mkdtemp("/tmp/scriptc-wasi-fetch-comment-");
    const result = await compile(entry, {
      outDir,
      outPath: join(outDir, "program.wasm"),
      dynamic: true,
    });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    expect(result.backend).toBe("llvm");
  });

  test("embedded destructuring of global fetch reports SC3002", async () => {
    const entry = join(repoRoot, "tests/fixtures/npm/cases/fetch-destructure/main.ts");
    const outDir = await mkdtemp("/tmp/scriptc-wasi-fetch-destructure-");
    const result = await compile(entry, {
      outDir,
      outPath: join(outDir, "program.wasm"),
      dynamic: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.code).toBe("SC3002");
      expect(result.diagnostics[0]?.message).toMatch(/network-backed fetch/);
    }
  });

  test.each([
    ["1360-spawn-sync.ts", /child processes/],
    ["1443-signal-handlers.ts", /OS signals/],
    ["1564-fs-watch.ts", /filesystem watching/],
    ["1780-http-res-surface.ts", /network sockets/],
  ])("reports unavailable WASI capabilities for %s", async (fixture, message) => {
    const outDir = await mkdtemp("/tmp/scriptc-wasi-capability-");
    const result = await compile(join(repoRoot, "tests/corpus", fixture), {
      outDir,
      outPath: join(outDir, "program.wasm"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.code).toBe("SC3002");
      expect(result.diagnostics[0]?.message).toMatch(message);
    }
  });

  test("the LLVM target supports the dynamic island", async () => {
    const entry = join(repoRoot, "tests/corpus/1100-island-eval-basics.ts");
    const outDir = await mkdtemp("/tmp/scriptc-wasi-dynamic-");
    const outPath = join(outDir, "program.wasm");
    const result = await compile(entry, { outDir, outPath, dynamic: true });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(result.backend).toBe("llvm");

    const node = await run(process.execPath, ["--import", islandShim, entry]);
    const wasm = await run(
      process.execPath,
      ["--no-warnings", "--experimental-wasi-unstable-preview1", "-e", WASI_RUNNER, outPath],
    );
    expect(wasm).toEqual(node);
  });

  test("pending static promises cross into the dynamic island", async () => {
    const entry = join(repoRoot, "tests/corpus/2633-island-promise-crossing.js");
    const outDir = await mkdtemp("/tmp/scriptc-wasi-dynamic-promise-");
    const outPath = join(outDir, "program.wasm");
    const result = await compile(entry, { outDir, outPath, dynamic: true });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(result.backend).toBe("llvm");

    const node = await run(process.execPath, ["--import", islandShim, entry]);
    const wasm = await run(
      process.execPath,
      ["--no-warnings", "--experimental-wasi-unstable-preview1", "-e", WASI_RUNNER, outPath],
    );
    expect(wasm).toEqual(node);
  });

  test("the LLVM target embeds npm packages for the dynamic island", async () => {
    const entry = join(repoRoot, "tests/fixtures/npm/cases/namespace/main.ts");
    const outDir = await mkdtemp("/tmp/scriptc-wasi-npm-");
    const outPath = join(outDir, "program.wasm");
    const result = await compile(entry, { outDir, outPath, dynamic: true });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(result.backend).toBe("llvm");

    const node = await run(process.execPath, ["--no-warnings", entry]);
    const wasm = await run(
      process.execPath,
      ["--no-warnings", "--experimental-wasi-unstable-preview1", "-e", WASI_RUNNER, outPath],
    );
    expect(wasm).toEqual(node);
  });

  test.each([
    "top-level-await-pending-exit-code",
    "top-level-await-pending-exit-listener",
  ])("embedded npm preserves pending-module exit precedence for %s", async (fixture) => {
    const entry = join(repoRoot, "tests/fixtures/npm/cases", fixture, "main.ts");
    const outDir = await mkdtemp("/tmp/scriptc-wasi-npm-pending-");
    const outPath = join(outDir, "program.wasm");
    const result = await compile(entry, { outDir, outPath, dynamic: true });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(result.backend).toBe("llvm");

    const node = await run(process.execPath, ["--no-warnings", entry]);
    const wasm = await run(
      process.execPath,
      ["--no-warnings", "--experimental-wasi-unstable-preview1", "-e", WASI_RUNNER, outPath],
    );
    expect(wasm).toEqual(node);
  });

  test("the LLVM target embeds compressed npm sources and builtin shims", async () => {
    const entry = join(repoRoot, "tests/fixtures/npm/cases/zlib-shims/main.ts");
    const outDir = await mkdtemp("/tmp/scriptc-wasi-npm-zlib-");
    const outPath = join(outDir, "program.wasm");
    const result = await compile(entry, { outDir, outPath, dynamic: true });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(result.backend).toBe("llvm");

    const node = await run(process.execPath, ["--no-warnings", entry]);
    const wasm = await run(
      process.execPath,
      ["--no-warnings", "--experimental-wasi-unstable-preview1", "-e", WASI_RUNNER, outPath],
    );
    expect(wasm).toEqual(node);
  });

  test("scriptc run hosts the module with inherited stdio", async () => {
    const entry = join(repoRoot, "tests/corpus/2700-wasi-core.ts");
    const outDir = await mkdtemp("/tmp/scriptc-wasi-cli-");
    const loader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");
    const result = await execFileAsync(process.execPath, [
      "--import", loader,
      join(repoRoot, "packages/cli/src/main.ts"),
      "run", entry,
      "--no-keep-c",
      "-o", join(outDir, "program.wasm"),
    ]);
    const node = await execFileAsync(process.execPath, [entry]);
    expect(result.stdout).toBe(node.stdout);
    expect(result.stderr).toBe(node.stderr);
  });
});
