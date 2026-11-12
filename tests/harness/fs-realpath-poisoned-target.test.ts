/* The plain callback realpath form runs the walk, not realpath(3). The walk
 * caches a link's target under the identity (device and inode) its lstat
 * saw; whoever can write the directory can rename a different link over the
 * name between that lstat and the readlink, so the substitute's target is
 * cached under the first link's identity. If that target leads back through
 * the same inode — the fixture hard-links one symlink at every level of a
 * directory chain — every restart of the walk resolves one level deeper, and
 * a path that keeps growing never repeats, so the full-path repetition guard
 * never fires. The walk now reads a target only when the identity still
 * matches afterwards, and it allows the kernel's MAXSYMLINKS substitutions
 * before answering ELOOP, so the expansion is bounded when the attacker
 * stops renaming. Node's walk has neither limit, so this is not a
 * differential program. The shim supplies the raced target the fixture's
 * real link cannot store (a link that really pointed at "sub/l" would be an
 * immediate cycle for stat(2)). */
import { execFile, execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");

const source = `import * as fs from "node:fs";

const dir: string = process.argv[2]!;
fs.realpath(dir + "/l", (error, resolved) => {
  if (error) {
    console.log("error", (error as NodeJS.ErrnoException).code);
    return;
  }
  console.log("resolved", resolved.length - dir.length);
});
`;

test.runIf(process.platform === "linux")(
  "a poisoned realpath target cannot grow the walk past the symlink budget",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-realpath-poisoned-"));
    // One symlink inode with a short, resolvable target, hard-linked at
    // every level so the walk reaches the same cached identity each time.
    symlinkSync("sub", join(dir, "l"));
    let level = dir;
    for (let depth = 0; depth < 60; depth++) {
      level = join(level, "sub");
      mkdirSync(level);
      linkSync(join(dir, "l"), join(level, "l"));
    }

    const outDir = mkdtempSync(join(tmpdir(), "scriptc-realpath-poisoned-build-"));
    const entry = join(outDir, "main.ts");
    writeFileSync(entry, source);
    const result = await compile(entry, {
      backend: "llvm",
      sanitize: process.env["SCRIPTC_SAN"] === "1",
      outDir,
      outPath: join(outDir, "program"),
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;

    const shim = join(outDir, "poisoned.so");
    execFileSync("clang", [
      "-shared",
      "-fPIC",
      join(repoRoot, "tests/fixtures/fs-realpath-poisoned-target.c"),
      "-o",
      shim,
      "-ldl",
    ]);
    const { stdout } = await execFileAsync(result.binaryPath, [dir], {
      encoding: "utf8",
      env: { ...process.env, LD_PRELOAD: shim, SCRIPTC_REALPATH_POISON: join(dir, "l") },
      timeout: 20_000,
    });
    expect(stdout).toBe("error ELOOP\n");
  },
);
