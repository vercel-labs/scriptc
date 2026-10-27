/* Two programs whose entries share a name (main.ts) built into one output
 * directory share the kept `main.ll` beside their executables. Each build
 * must still compile, link and cache its own translation unit: a later
 * build that restores either program from the executable cache, or relinks
 * it from the cached translation unit, gets that program back.
 *
 * The overlap is made deterministic with a linker wrapper that rewrites the
 * kept `main.ll` with the other program's text while the first build links,
 * which is what a concurrent build of the other program does when it writes
 * its kept LLVM in that window. A caller-selected linker never publishes the
 * final executable, so every cache hit relinks from the cached translation
 * unit. Both builds also run concurrently. */
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");
const windows = process.platform === "win32";

let directory = "";

beforeAll(() => {
  directory = mkdtempSync(join(windows ? tmpdir() : "/tmp", "scriptc-shared-output-"));
  for (const name of ["first", "second"]) {
    mkdirSync(join(directory, name));
    writeFileSync(join(directory, name, "main.ts"), `console.log("${name} program");\n`);
  }
  mkdirSync(join(directory, "out"));
});

afterAll(() => {
  if (directory !== "") rmSync(directory, { recursive: true, force: true });
});

function outPath(name: string): string {
  return join(directory, "out", name + (windows ? ".exe" : ""));
}

async function build(name: string, env: NodeJS.ProcessEnv = {}): Promise<void> {
  await execFileAsync(
    process.execPath,
    [cli, "build", join(directory, name, "main.ts"), "-o", outPath(name)],
    {
      cwd: repoRoot,
      env: { ...process.env, SCRIPTC_CACHE_DIR: join(directory, "cache"), ...env },
      maxBuffer: 1 << 24,
    },
  );
}

function run(name: string): string {
  return execFileSync(outPath(name), { encoding: "utf8" });
}

describe.skipIf(windows)("executables built into one output directory", () => {
  test(
    "keep their own translation units when their builds overlap",
    { timeout: 600_000 },
    async () => {
      const keptLlvm = join(directory, "out", "main.ll");
      // The second program's kept LLVM, for the wrapper to write while the
      // first program links.
      await build("second");
      const secondLlvm = join(directory, "second.ll");
      writeFileSync(secondLlvm, readFileSync(keptLlvm));
      const linker = join(directory, "linker.sh");
      writeFileSync(
        linker,
        [
          "#!/bin/sh",
          `if [ -n "$SCRIPTC_TEST_OVERLAP" ]; then cp "${secondLlvm}" "${keptLlvm}"; fi`,
          'exec clang "$@"',
          "",
        ].join("\n"),
      );
      chmodSync(linker, 0o755);

      await build("first", { SCRIPTC_LINKER: linker, SCRIPTC_TEST_OVERLAP: "1" });
      expect(run("first")).toBe("first program\n");
      expect(readFileSync(keptLlvm, "utf8")).toContain("first program");
      // A cache hit relinks from the translation unit the build cached.
      rmSync(outPath("first"));
      await build("first", { SCRIPTC_LINKER: linker });
      expect(run("first")).toBe("first program\n");
      expect(readFileSync(keptLlvm, "utf8")).toContain("first program");

      // Both programs at once, cold and then from the cache.
      for (const round of [0, 1]) {
        if (round === 1) for (const name of ["first", "second"]) rmSync(outPath(name));
        const env = { SCRIPTC_CACHE_DIR: join(directory, "cache-both"), SCRIPTC_LINKER: linker };
        await Promise.all([build("first", env), build("second", env)]);
        expect(run("first")).toBe("first program\n");
        expect(run("second")).toBe("second program\n");
      }
    },
  );
});
