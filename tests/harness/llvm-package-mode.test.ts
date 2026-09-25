import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const packagesRoot = join(import.meta.dirname, "../../packages");

// The release packs helpers with `pnpm pack`, which normalizes file modes and
// keeps the executable bit only on files a manifest names in `bin`. A helper
// packed without it installs as 0644 and every native build on that platform
// fails before code generation. Windows helpers carry `.exe` and need no mode.
const posixHelpers = (await readdir(packagesRoot))
  .filter((name) => name.startsWith("llvm-") && !name.startsWith("llvm-win32-"))
  .sort();

test("every POSIX LLVM helper package is discovered", () => {
  expect(posixHelpers).toEqual([
    "llvm-darwin-arm64",
    "llvm-darwin-x64",
    "llvm-linux-arm64-gnu",
    "llvm-linux-arm64-musl",
    "llvm-linux-x64-gnu",
    "llvm-linux-x64-musl",
  ]);
});

test.each(posixHelpers)("%s packs its helper as an executable", async (name) => {
  const work = await mkdtemp(join(tmpdir(), `scriptc-${name}-pack-`));
  try {
    const packageDir = join(work, "package");
    await mkdir(join(packageDir, "bin"), { recursive: true });
    for (const file of ["package.json", "LICENSE", "SCRIPTC_LICENSE", "THIRD_PARTY_NOTICES"]) {
      await copyFile(join(packagesRoot, name, file), join(packageDir, file));
    }
    // A stand-in with the mode the native build leaves behind.
    const helper = join(packageDir, "bin", "scriptc-llvm-codegen");
    await writeFile(helper, "#!/bin/sh\n");
    await chmod(helper, 0o755);

    await execFileAsync("pnpm", ["pack", "--pack-destination", work], { cwd: packageDir });
    const tarball = (await readdir(work)).find((file) => file.endsWith(".tgz"));
    expect(tarball).toBeDefined();

    const listing = await execFileAsync("tar", ["-tvzf", join(work, tarball!)]);
    const entry = listing.stdout
      .split("\n")
      .find((line) => line.endsWith(" package/bin/scriptc-llvm-codegen"));
    expect(entry).toBeDefined();
    expect(entry!.slice(0, 10)).toBe("-rwxr-xr-x");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}, 60_000);
