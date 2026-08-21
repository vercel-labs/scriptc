import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../../..");
const bootstrap = join(repoRoot, "packages/cli/dist/bootstrap.js");

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
  const outPath = join(dir, process.platform === "win32" ? "program.exe" : "program");
  const env = { ...process.env, SCRIPTC_CACHE_DIR: cacheRoot, SCRIPTC_TIMING: "1" };
  const build = (): Promise<{ stderr: string }> =>
    execFileAsync(process.execPath, [bootstrap, "build", entry, "-o", outPath], {
      env,
      maxBuffer: 4 * 1024 * 1024,
    });
  try {
    await mkdir(cacheRoot, { mode: 0o700 });
    await writeFile(entry, 'console.log("one");\n');
    expect((await build()).stderr).toContain("scriptc lowering");
    expect((await build()).stderr).not.toContain("scriptc lowering");
    expect((await execFileAsync(outPath)).stdout).toBe("one\n");

    await writeFile(entry, 'console.log("two");\n');
    expect((await build()).stderr).toContain("scriptc lowering");
    expect((await build()).stderr).not.toContain("scriptc lowering");
    expect((await execFileAsync(outPath)).stdout).toBe("two\n");
    expect(await readFile(join(dir, "main.ll"), "utf8")).toContain("two");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
