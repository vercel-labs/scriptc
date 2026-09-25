import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const bootstrapEntry = join(repoRoot, "packages/cli/dist/bootstrap.js");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");

test.each(["auto", "c", "from-c"] as const)(
  "--strip shrinks and runs %s executables without mixing cache variants",
  async (route) => {
    const dir = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-strip-"));
    const entry = join(dir, route === "from-c" ? "main.c" : "main.ts");
    const outPath = join(dir, process.platform === "win32" ? "program.exe" : "program");
    const env = { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache") };
    const routeArgs = route === "auto" ? [] : route === "c" ? ["--backend=c"] : ["--from-c"];
    const build = async (strip: boolean, bootstrap = false): Promise<number> => {
      await execFileAsync(process.execPath, [
        ...(bootstrap ? [bootstrapEntry] : ["--import", tsxLoader, cliEntry]),
        "build", entry, "-o", outPath, ...routeArgs, ...(strip ? ["--strip"] : []),
      ], { env, maxBuffer: 4 * 1024 * 1024 });
      return (await stat(outPath)).size;
    };
    try {
      await writeFile(entry, route === "from-c"
        ? '#include <stdio.h>\nint main(void) { puts("strip-ok"); return 0; }\n'
        : 'console.log("strip-ok");\n');
      const originalSize = await build(false);
      const strippedSize = await build(true);
      expect(strippedSize).toBeLessThan(originalSize);
      expect((await execFileAsync(outPath)).stdout).toBe("strip-ok\n");
      if (route === "auto") {
        expect(await build(true, true)).toBe(strippedSize);
        expect(await build(false, true)).toBe(originalSize);
        expect((await execFileAsync(outPath)).stdout).toBe("strip-ok\n");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  180_000,
);
