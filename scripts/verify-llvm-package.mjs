#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tarball = process.argv[2];
if (tarball === undefined) throw new Error("usage: verify-llvm-package.mjs <tarball>");
const work = mkdtempSync(join(tmpdir(), "scriptc-llvm-pack-"));
try {
  execFileSync("tar", ["-xzf", tarball, "-C", work]);
  const root = join(work, "package");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const notice of ["LICENSE", "SCRIPTC_LICENSE", "THIRD_PARTY_NOTICES"]) {
    if (statSync(join(root, notice)).size === 0) throw new Error(`${notice} is missing or empty`);
  }
  if (manifest.os?.join(",") !== "darwin" || manifest.cpu?.join(",") !== "arm64") {
    throw new Error("helper manifest must constrain os=darwin and cpu=arm64");
  }
  if (manifest.bin?.["scriptc-llvm-codegen"] !== "bin/scriptc-llvm-codegen") {
    throw new Error("helper manifest must expose the executable as an npm bin");
  }
  const binary = join(root, "bin", "scriptc-llvm-codegen");
  accessSync(binary, constants.X_OK);
  if (statSync(binary).size > 40 * 1024 * 1024) {
    throw new Error("stripped helper exceeds the 40 MiB installed-size budget");
  }
  if (statSync(tarball).size > 16 * 1024 * 1024) {
    throw new Error("helper tarball exceeds the 16 MiB compressed-size budget");
  }
  const version = JSON.parse(execFileSync(binary, ["version", "--format=json"], {
    encoding: "utf8",
  }));
  if (
    version.protocol_version !== "1" ||
    version.scriptc_package_version !== manifest.version ||
    version.llvm_version !== "22.1.8"
  ) throw new Error(`packed helper identity mismatch: ${JSON.stringify(version)}`);
  const dependencies = execFileSync("otool", ["-L", binary], { encoding: "utf8" });
  if (/\/opt\/homebrew|\/usr\/local|libLLVM|libzstd/.test(dependencies)) {
    throw new Error(`packed helper has a non-system runtime dependency:\n${dependencies}`);
  }
  const attributes = execFileSync("xattr", [binary], { encoding: "utf8" });
  if (attributes.split("\n").includes("com.apple.quarantine")) {
    throw new Error("packed helper carries a quarantine attribute");
  }
  execFileSync("codesign", ["--verify", "--strict", binary], { stdio: "inherit" });
  process.stdout.write(
    `verified ${manifest.name}@${manifest.version}: ${statSync(binary).size} bytes installed, ` +
    `${statSync(tarball).size} bytes packed\n`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
