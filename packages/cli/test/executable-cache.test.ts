import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { precompiledRuntimePackTarget } from "../../compiler/src/startup-cache.js";
import { platformLinkerSupportsPersistentCache } from "../../compiler/src/backend/linker.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");
const helperTarget = precompiledRuntimePackTarget();
const persistentExecutable =
  helperTarget === null || platformLinkerSupportsPersistentCache(process.env, helperTarget);

test("exact executable repeats skip lowering while edits and damaged outputs stay correct", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cli-executable-cache-"));
  const cacheRoot = join(dir, "cache");
  const entry = join(dir, "main.ts");
  const outPath = join(dir, process.platform === "win32" ? "program.exe" : "program");
  const tuPath = join(dir, "main.ll");
  try {
    await mkdir(cacheRoot, { mode: 0o700 });
    await writeFile(entry, 'console.log("one");\n');
    const build = async (
      extra: string[] = [],
      env: NodeJS.ProcessEnv = {},
    ): Promise<{ stderr: string }> => {
      const { stderr } = await execFileAsync(
        process.execPath,
        ["--import", tsxLoader, cliEntry, "build", entry, "-o", outPath, ...extra],
        {
          env: {
            ...process.env,
            SCRIPTC_CACHE_DIR: cacheRoot,
            SCRIPTC_TIMING: "1",
            ...env,
          },
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      return { stderr };
    };
    const run = async (): Promise<string> =>
      (await execFileAsync(outPath, [], { maxBuffer: 1024 * 1024 })).stdout;

    expect((await build()).stderr).toContain("scriptc lowering");
    expect(await run()).toBe("one\n");
    const originalBinaryTime = (await stat(outPath)).mtimeMs;
    const originalTuTime = (await stat(tuPath)).mtimeMs;

    // Every route reuses the frontend. Only routes with a complete native
    // dependency proof can also retain the executable inode; other targets
    // deliberately relink their cached translation unit.
    expect((await build()).stderr).not.toContain("scriptc lowering");
    if (persistentExecutable) expect((await stat(outPath)).mtimeMs).toBe(originalBinaryTime);
    expect(await run()).toBe("one\n");
    expect((await stat(tuPath)).mtimeMs).toBe(originalTuTime);

    // An exact early hit leaves earlier source outputs in place.
    const irPath = join(dir, "main.ir.json");
    await writeFile(irPath, "saved IR\n");
    expect((await build()).stderr).not.toContain("scriptc lowering");
    expect(await readFile(irPath, "utf8")).toBe("saved IR\n");

    // Caller damage does not poison the cache: the verified cached binary is
    // atomically restored without rebuilding the frontend.
    await writeFile(outPath, "damaged\n");
    await chmod(outPath, 0o777 & ~process.umask());
    expect((await build()).stderr).not.toContain("scriptc lowering");
    expect(await run()).toBe("one\n");

    // Source bytes are frontend inputs. A semantic edit misses, emits a new
    // TU/binary, and the next exact repeat returns early again.
    await writeFile(entry, 'console.log("two");\n');
    expect((await build()).stderr).toContain("scriptc lowering");
    expect(await run()).toBe("two\n");
    expect((await build()).stderr).not.toContain("scriptc lowering");

    // Native optimization posture is independently keyed too: dev cannot
    // consume a release executable or TU, and then exact dev repeats hit.
    expect((await build(["--optimization", "dev"])).stderr).toContain("scriptc lowering");
    expect(await run()).toBe("two\n");
    expect((await build(["--optimization", "dev"])).stderr).not.toContain("scriptc lowering");
    expect(await readFile(tuPath, "utf8")).toContain("define i32 @main");

    // Speed shares release's -O2 class but links different code: it can
    // consume neither the release nor the dev entry, and neither can
    // consume its entry afterwards.
    expect((await build(["--optimization", "speed"])).stderr).toContain("scriptc lowering");
    expect(await run()).toBe("two\n");
    expect((await build(["--optimization", "speed"])).stderr).not.toContain("scriptc lowering");
    expect((await build(["--optimization", "release"])).stderr).not.toContain("scriptc lowering");
    expect(await run()).toBe("two\n");
    expect((await build(["--optimization", "speed"])).stderr).not.toContain("scriptc lowering");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);

test.skipIf(process.platform === "win32")(
  "an executable appearing earlier on unchanged PATH invalidates the early binary",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-cli-executable-path-"));
    // Keep the mutable tool directory outside the frontend/native output tree:
    // this pins driver resolution itself rather than incidental directory
    // dependency tracking under outDir.
    const toolDir = await mkdtemp(join(tmpdir(), "scriptc-cli-tool-path-"));
    const cacheRoot = join(dir, "cache");
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "program");
    const path = `${toolDir}${delimiter}${process.env["PATH"] ?? ""}`;
    const build = (): Promise<void> =>
      execFileAsync(
        process.execPath,
        ["--import", tsxLoader, cliEntry, "build", entry, "-o", outPath],
        {
          env: { ...process.env, PATH: path, SCRIPTC_CACHE_DIR: cacheRoot },
          maxBuffer: 4 * 1024 * 1024,
        },
      ).then(() => undefined);
    try {
      await mkdir(cacheRoot, { mode: 0o700 });
      await writeFile(entry, 'console.log("cached");\n');
      await build();

      const clang = join(toolDir, "clang");
      await writeFile(clang, "#!/bin/sh\nprintf 'new clang selected\\n' >&2\nexit 97\n");
      await chmod(clang, 0o755);

      await expect(build()).rejects.toMatchObject({
        stderr: expect.stringContaining("new clang selected"),
      });
    } finally {
      await Promise.all([
        rm(dir, { recursive: true, force: true }),
        rm(toolDir, { recursive: true, force: true }),
      ]);
    }
  },
  120_000,
);
