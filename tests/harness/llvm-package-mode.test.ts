import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "vitest";

const repoRoot = join(import.meta.dirname, "../..");
const posixHelpers = [
  "llvm-darwin-arm64",
  "llvm-darwin-x64",
  "llvm-linux-x64-gnu",
  "llvm-linux-x64-musl",
  "llvm-linux-arm64-gnu",
  "llvm-linux-arm64-musl",
] as const;

if (process.platform === "win32") {
  test.skip("POSIX helper tarball modes", () => {});
} else {
  for (const name of posixHelpers) {
    test(`${name} retains an executable helper after pnpm pack`, () => {
      const work = mkdtempSync("/tmp/scriptc-llvm-pack-mode-");
      try {
        const pkg = join(work, "source");
        const bin = join(pkg, "bin");
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(pkg, "package.json"), readFileSync(join(repoRoot, "packages", name, "package.json")));
        for (const notice of ["LICENSE", "SCRIPTC_LICENSE", "THIRD_PARTY_NOTICES"]) {
          writeFileSync(join(pkg, notice), "test notice\n");
        }
        const executable = join(bin, "scriptc-llvm-codegen");
        writeFileSync(executable, "#!/bin/sh\nexit 0\n");
        chmodSync(executable, 0o755);

        execFileSync("pnpm", ["pack", "--pack-destination", work, "--silent"], { cwd: pkg });
        const tarball = readdirSync(work).find((file) => file.endsWith(".tgz"));
        expect(tarball).toBeDefined();
        execFileSync(process.execPath, [join(repoRoot, "scripts", "verify-llvm-package-mode.mjs"), join(work, tarball!), `@scriptc/${name}`]);
        execFileSync("tar", ["-xzf", join(work, tarball!), "-C", work]);
        const mode = statSync(join(work, "package", "bin", "scriptc-llvm-codegen")).mode & 0o777;
        expect(mode.toString(8)).toBe("755");
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  }
}
