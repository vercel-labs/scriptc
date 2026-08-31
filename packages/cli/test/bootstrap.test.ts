import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../../..");
const bootstrap = join(repoRoot, "packages/cli/dist/bootstrap.js");

function peSubsystem(bytes: Buffer): number {
  expect(bytes.subarray(0, 2)).toEqual(Buffer.from("MZ"));
  const peOffset = bytes.readUInt32LE(0x3c);
  expect(bytes.subarray(peOffset, peOffset + 4)).toEqual(Buffer.from("PE\0\0"));
  const optionalHeader = peOffset + 4 + 20;
  expect(bytes.readUInt16LE(optionalHeader)).toBe(0x20b);
  return bytes.readUInt16LE(optionalHeader + 0x44);
}

test("bootstrap serves version and help without loading the compiler graph", async () => {
  const preloadDir = await mkdtemp(join(tmpdir(), "scriptc-bootstrap-preload-"));
  const preload = join(preloadDir, "preload.mjs");
  try {
    await writeFile(preload, [
      "import { registerHooks } from 'node:module';",
      "registerHooks({ load(url, context, nextLoad) {",
      "  if (url.includes('/packages/compiler/dist/index.js')) throw new Error('compiler graph loaded');",
      "  return nextLoad(url, context);",
      "}});",
      "",
    ].join("\n"));
    const version = await execFileAsync(process.execPath, ["--import", preload, bootstrap, "--version"]);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    const help = await execFileAsync(process.execPath, ["--import", preload, bootstrap, "--help"]);
    expect(help.stdout).toContain("scriptc build <file.ts|.js>");
  } finally {
    await rm(preloadDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("bootstrap exact builds use the routed cache and source edits fall through", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-bootstrap-cache-"));
  const cacheRoot = join(dir, "cache");
  const entry = join(dir, "main.ts");
  const outDir = join(dir, ".scriptc");
  const outPath = join(outDir, process.platform === "win32" ? "main.exe" : "main");
  const preload = join(dir, "reject-full-compiler.mjs");
  const env = { ...process.env, SCRIPTC_CACHE_DIR: cacheRoot, SCRIPTC_TIMING: "1" };
  const build = (rejectFullCompiler = false): Promise<{ stderr: string }> =>
    execFileAsync(process.execPath, [
      ...(rejectFullCompiler ? ["--import", preload] : []),
      bootstrap,
      "build",
      entry,
    ], {
      env,
      maxBuffer: 4 * 1024 * 1024,
    });
  try {
    await mkdir(cacheRoot, { mode: 0o700 });
    await Promise.all([
      writeFile(entry, 'console.log("one");\n'),
      writeFile(preload, [
        "import { registerHooks } from 'node:module';",
        "registerHooks({ load(url, context, nextLoad) {",
        "  if (url.includes('/packages/compiler/dist/index.js')) throw new Error('compiler graph loaded');",
        "  return nextLoad(url, context);",
        "}});",
        "",
      ].join("\n")),
    ]);
    expect((await build()).stderr).toContain("scriptc lowering");
    expect((await build()).stderr).not.toContain("scriptc lowering");
    expect((await execFileAsync(outPath)).stdout).toBe("one\n");

    // A source-primary build may replace the cached executable between exact
    // invocations. The shipped bootstrap must not leave its stale IR sibling
    // behind, whether cache validation returns directly or falls through.
    const staleIr = join(outDir, "main.ir.json");
    await writeFile(staleIr, "stale source-primary IR\n");
    await expect(build()).resolves.toBeDefined();
    await expect(readFile(staleIr)).rejects.toMatchObject({ code: "ENOENT" });

    // Route metadata can be evicted independently of the executable payload.
    // One full-compiler fallback must repair it so the following invocation is
    // once again able to run with the package root import forbidden.
    await Promise.all([
      rm(join(cacheRoot, "early-exe-route"), { recursive: true, force: true }),
      rm(join(cacheRoot, "early-exe-implementation"), { recursive: true, force: true }),
    ]);
    expect((await build()).stderr).not.toContain("scriptc lowering");
    await expect(build(true)).resolves.toMatchObject({ stderr: "" });

    await writeFile(entry, 'console.log("two");\n');
    expect((await build()).stderr).toContain("scriptc lowering");
    expect((await build()).stderr).not.toContain("scriptc lowering");
    expect((await execFileAsync(outPath)).stdout).toBe("two\n");
    expect(await readFile(join(outDir, "main.ll"), "utf8")).toContain("two");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);

test.skipIf(process.platform !== "win32")(
  "bootstrap routed cache keeps Windows GUI subsystem artifacts separate",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-bootstrap-subsystem-"));
    const cacheRoot = join(dir, "cache");
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.exe");
    const preload = join(dir, "reject-full-compiler.mjs");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SCRIPTC_CACHE_DIR: cacheRoot,
      SCRIPTC_CC: "zigcc",
      SCRIPTC_TARGET: "x86_64-windows-gnu",
    };
    delete env.SCRIPTC_NO_CACHE;
    const build = (subsystem?: "windows", rejectFullCompiler = false) => execFileAsync(process.execPath, [
      ...(rejectFullCompiler ? ["--import", preload] : []),
      bootstrap,
      "build",
      entry,
      "-o",
      outPath,
      ...(subsystem === undefined ? [] : ["--subsystem=windows"]),
    ], { env, maxBuffer: 16 * 1024 * 1024 });
    try {
      await mkdir(cacheRoot, { mode: 0o700 });
      await Promise.all([
        writeFile(entry, "process.exit(0);\n"),
        writeFile(preload, [
          "import { registerHooks } from 'node:module';",
          "registerHooks({ load(url, context, nextLoad) {",
          "  if (url.includes('/packages/compiler/dist/index.js')) throw new Error('compiler graph loaded');",
          "  return nextLoad(url, context);",
          "}});",
          "",
        ].join("\n")),
      ]);
      await build();
      expect(peSubsystem(await readFile(outPath))).toBe(3);
      await build("windows");
      expect(peSubsystem(await readFile(outPath))).toBe(2);
      await expect(build("windows", true)).resolves.toMatchObject({ stderr: "" });
      await expect(execFileAsync(outPath, [], { windowsHide: true, encoding: "utf8" })).resolves.toMatchObject({
        stderr: "",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  120_000,
);
