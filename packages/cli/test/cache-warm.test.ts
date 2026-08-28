import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../../..");
const bootstrap = join(repoRoot, "packages/cli/dist/bootstrap.js");
const runtimePackageRoot = join(repoRoot, "packages/runtime");

test("cache warm accepts focused profiles and rejects unknown ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cli-cache-warm-"));
  const cacheRoot = join(dir, "cache");
  try {
    const env = { ...process.env, SCRIPTC_CACHE_DIR: cacheRoot };
    const warmed = await execFileAsync(
      process.execPath,
      [bootstrap, "cache", "warm", "runtime"],
      { env, maxBuffer: 4 * 1024 * 1024 },
    );
    expect(warmed.stdout).toContain(`${cacheRoot}\n`);
    expect(warmed.stdout).toMatch(/runtime\t\d+ms/);
    expect(warmed.stdout).not.toContain("tls\t");
    expect((await readdir(join(cacheRoot, "obj"))).length).toBeGreaterThan(0);

    await expect(
      execFileAsync(process.execPath, [bootstrap, "cache", "warm", "unknown"], { env }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("unknown cache warm profile") });

    await expect(
      execFileAsync(process.execPath, [bootstrap, "cache", "warm", "runtime"], {
        env: { ...env, CPATH: dir },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("requires a persistently cacheable compiler environment"),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);

test("the runtime npm tarball excludes legacy package-local vendor caches", async () => {
  const fixture = join(runtimePackageRoot, "vendor", ".cache", "package-test-fixture");
  try {
    await mkdir(fixture, { recursive: true });
    await writeFile(join(fixture, "foreign-native-object.o"), "must not ship\n");
    const packed = await execFileAsync(
      "pnpm",
      ["pack", "--dry-run", "--json"],
      { cwd: runtimePackageRoot, maxBuffer: 16 * 1024 * 1024 },
    );
    const manifest = JSON.parse(packed.stdout) as { files: { path: string }[] };
    expect(manifest.files.some(({ path }) => path.startsWith("vendor/.cache/"))).toBe(false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
