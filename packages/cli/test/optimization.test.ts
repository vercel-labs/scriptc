import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../../..");
const bootstrap = join(repoRoot, "packages/cli/dist/bootstrap.js");

test("--optimization accepts release, dev, and speed and names them when rejecting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cli-optimization-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, 'console.log("posture");\n');
    const env = { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache") };
    const help = await execFileAsync(process.execPath, [bootstrap, "--help"], { env });
    expect(help.stdout).toContain("--optimization <release|dev|speed>");
    for (const args of [
      ["build", entry, "--optimization=fast"],
      ["run", entry, "--optimization", "O3"],
      ["cache", "warm", "--optimization=fast"],
    ]) {
      await expect(
        execFileAsync(process.execPath, [bootstrap, ...args], { env }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("(supported: release, dev, speed)"),
      });
    }
    // Speed is an executable posture like release and dev.
    await expect(
      execFileAsync(
        process.execPath,
        [bootstrap, "build", entry, "--emit=llvm", "--optimization=speed"],
        { env },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--optimization is only meaningful with --emit=exe"),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
