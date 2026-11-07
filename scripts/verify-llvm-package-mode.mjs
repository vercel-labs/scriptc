#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const [tarball, expectedName] = process.argv.slice(2);
if (!tarball || !expectedName) {
  throw new Error("usage: verify-llvm-package-mode.mjs <tarball> <package-name>");
}

const work = mkdtempSync("/tmp/scriptc-llvm-package-mode-");
try {
  execFileSync("tar", ["-xzf", tarball, "-C", work]);
  const root = join(work, "package");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (manifest.name !== expectedName) {
    throw new Error(`expected ${expectedName} in ${tarball}, found ${manifest.name}`);
  }
  // The compiler starts both executables directly: the LLVM helper and the
  // comptime evaluator.
  for (const tool of ["scriptc-llvm-codegen", "scriptc-comptime"]) {
    if (!Object.values(manifest.bin ?? {}).includes(`bin/${tool}`)) {
      throw new Error(`${expectedName} must declare ${tool} as an npm bin`);
    }
    const mode = statSync(join(root, "bin", tool)).mode & 0o777;
    if (mode !== 0o755) {
      throw new Error(
        `${expectedName} ${tool} has mode ${mode.toString(8)} in ${tarball}, expected 755`,
      );
    }
  }
  process.stdout.write(`verified ${expectedName} helper and evaluator tarball mode 755\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
