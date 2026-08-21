import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../../..");
const bootstrap = join(repoRoot, "packages/cli/dist/bootstrap.js");

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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
