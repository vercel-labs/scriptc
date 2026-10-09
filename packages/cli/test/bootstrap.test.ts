import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { release as osRelease, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { precompiledRuntimePackTarget } from "../../compiler/src/startup-cache.js";
import { platformLinkerSupportsPersistentCache } from "../../compiler/src/backend/linker.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../../..");
const bootstrap = join(repoRoot, "packages/cli/dist/bootstrap.js");
const runtimePackHost =
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  Number.parseInt(osRelease().split(".", 1)[0] ?? "", 10) >= 24;
const helperTarget = precompiledRuntimePackTarget();
const persistentExecutable =
  helperTarget === null || platformLinkerSupportsPersistentCache(process.env, helperTarget);

test("bootstrap serves version and help without loading the compiler graph", async () => {
  const preloadDir = await mkdtemp(join(tmpdir(), "scriptc-bootstrap-preload-"));
  const preload = join(preloadDir, "preload.mjs");
  try {
    await writeFile(
      preload,
      [
        "import { registerHooks } from 'node:module';",
        "registerHooks({ load(url, context, nextLoad) {",
        "  if (url.includes('/packages/compiler/dist/index.js')) throw new Error('compiler graph loaded');",
        "  return nextLoad(url, context);",
        "}});",
        "",
      ].join("\n"),
    );
    const version = await execFileAsync(process.execPath, [
      "--import",
      preload,
      bootstrap,
      "--version",
    ]);
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
    execFileAsync(
      process.execPath,
      [...(rejectFullCompiler ? ["--import", preload] : []), bootstrap, "build", entry],
      {
        env,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  try {
    await mkdir(cacheRoot, { mode: 0o700 });
    await Promise.all([
      writeFile(entry, 'console.log("one");\n'),
      writeFile(
        preload,
        [
          "import { registerHooks } from 'node:module';",
          "registerHooks({ load(url, context, nextLoad) {",
          "  if (url.includes('/packages/compiler/dist/index.js')) throw new Error('compiler graph loaded');",
          "  return nextLoad(url, context);",
          "}});",
          "",
        ].join("\n"),
      ),
    ]);
    expect((await build()).stderr).toContain("scriptc lowering");
    expect((await build()).stderr).not.toContain("scriptc lowering");
    expect((await execFileAsync(outPath)).stdout).toBe("one\n");

    // A routed cache hit preserves outputs from earlier invocations.
    const savedIr = join(outDir, "main.ir.json");
    const savedC = join(outDir, "main.c");
    await writeFile(savedIr, "saved IR\n");
    await writeFile(savedC, "saved C\n");
    await expect(build()).resolves.toBeDefined();
    expect(await readFile(savedIr, "utf8")).toBe("saved IR\n");
    expect(await readFile(savedC, "utf8")).toBe("saved C\n");

    // Route metadata can be evicted independently of the executable payload.
    // One full-compiler fallback must repair it so the following invocation is
    // once again able to run with the package root import forbidden.
    await Promise.all([
      rm(join(cacheRoot, "early-exe-route"), { recursive: true, force: true }),
      rm(join(cacheRoot, "early-exe-implementation"), { recursive: true, force: true }),
    ]);
    expect((await build()).stderr).not.toContain("scriptc lowering");
    if (persistentExecutable) {
      await expect(build(true)).resolves.toMatchObject({ stderr: "" });
    } else {
      // This target intentionally lacks a persistent native dependency proof.
      // It must enter the full compiler to relink, even on a frontend hit.
      await expect(build(true)).rejects.toMatchObject({
        stderr: expect.stringContaining("compiler graph loaded"),
      });
      expect((await build()).stderr).not.toContain("scriptc lowering");
      expect((await execFileAsync(outPath)).stdout).toBe("one\n");
    }

    await writeFile(entry, 'console.log("two");\n');
    expect((await build()).stderr).toContain("scriptc lowering");
    expect((await build()).stderr).not.toContain("scriptc lowering");
    expect((await execFileAsync(outPath)).stdout).toBe("two\n");
    expect(await readFile(join(outDir, "main.ll"), "utf8")).toContain("two");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);

test.skipIf(!runtimePackHost)(
  "bootstrap cache hits reuse LLVM executables",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-bootstrap-llvm-cache-"));
    const cacheRoot = join(dir, "cache");
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "program");
    const env = {
      ...process.env,
      SCRIPTC_CACHE_DIR: cacheRoot,
      SCRIPTC_CC: "clang",
      SCRIPTC_TIMING: "1",
    };
    delete env.SCRIPTC_NO_CACHE;
    const build = () =>
      execFileAsync(process.execPath, [bootstrap, "build", entry, "-o", outPath], {
        env,
        maxBuffer: 4 * 1024 * 1024,
      });
    try {
      await writeFile(entry, 'console.log("LLVM cache");\n');
      const first = await build();
      expect((await execFileAsync(outPath)).stdout).toBe("LLVM cache\n");
      expect(first.stderr).toContain("scriptc lowering");

      const cached = await build();
      expect((await execFileAsync(outPath)).stdout).toBe("LLVM cache\n");
      expect(cached.stderr).not.toContain("scriptc lowering");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  120_000,
);

test.skipIf(!runtimePackHost)(
  "bootstrap probes the native driver once for cold builds, repeats, and source edits",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-bootstrap-driver-probes-"));
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "program");
    const probes = join(dir, "probes.log");
    const preload = join(dir, "count-probes.mjs");
    const env = { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache") };
    delete env.SCRIPTC_NO_CACHE;
    const build = () =>
      execFileAsync(
        process.execPath,
        ["--import", preload, bootstrap, "build", entry, "-o", outPath],
        { env },
      );
    try {
      await Promise.all([
        writeFile(entry, 'console.log("one");\n'),
        writeFile(
          preload,
          [
            'import childProcess from "node:child_process";',
            'import { appendFileSync } from "node:fs";',
            'import { syncBuiltinESMExports } from "node:module";',
            'import { promisify } from "node:util";',
            "const original = childProcess.execFile;",
            `const record = (args) => { if (args?.includes("-print-prog-name=clang")) appendFileSync(${JSON.stringify(probes)}, "probe\\n"); };`,
            "childProcess.execFile = function (file, args, ...rest) {",
            "  record(args);",
            "  return original.call(this, file, args, ...rest);",
            "};",
            "childProcess.execFile[promisify.custom] = function (file, args, ...rest) {",
            "  record(args);",
            "  return promisify(original).call(this, file, args, ...rest);",
            "};",
            "syncBuiltinESMExports();",
            "",
          ].join("\n"),
        ),
      ]);
      await build();
      expect(await readFile(probes, "utf8")).toBe("probe\n");
      expect((await execFileAsync(outPath)).stdout).toBe("one\n");
      await build();
      expect(await readFile(probes, "utf8")).toBe("probe\nprobe\n");
      await writeFile(entry, 'console.log("two");\n');
      await build();
      expect(await readFile(probes, "utf8")).toBe("probe\nprobe\nprobe\n");
      expect((await execFileAsync(outPath)).stdout).toBe("two\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  120_000,
);

test("bootstrap replays an unchanged coverage verdict without loading the compiler graph", async () => {
  const work = await mkdtemp(join(tmpdir(), "scriptc-bootstrap-coverage-"));
  const preload = join(work, "preload.mjs");
  const entry = join(work, "main.ts");
  const env = { ...process.env, SCRIPTC_CACHE_DIR: join(work, "cache") };
  try {
    await writeFile(
      preload,
      [
        "import { registerHooks } from 'node:module';",
        "registerHooks({ load(url, context, nextLoad) {",
        "  if (url.includes('/packages/compiler/dist/index.js')) throw new Error('compiler graph loaded');",
        "  return nextLoad(url, context);",
        "}});",
        "",
      ].join("\n"),
    );
    await writeFile(entry, "const [[a]] = [[1]] as number[][];\nconsole.log(a);\n");
    const first = await execFileAsync(process.execPath, [bootstrap, "coverage", entry], { env });
    expect(first.stdout).toContain("statements analyzed");
    const replayed = await execFileAsync(
      process.execPath,
      ["--import", preload, bootstrap, "coverage", entry],
      { env },
    );
    expect(replayed.stdout).toBe(first.stdout);
    // A changed source must load the compiler again.
    await writeFile(entry, "console.log(1);\n");
    await expect(
      execFileAsync(process.execPath, ["--import", preload, bootstrap, "coverage", entry], { env }),
    ).rejects.toThrow("compiler graph loaded");
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
});
