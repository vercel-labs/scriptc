#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tarball = process.argv[2];
if (tarball === undefined) throw new Error("usage: verify-llvm-package.mjs <tarball>");
// Homebrew's arm64 LLVM 22 bottles are not byte-identical across supported
// macOS runner images: clean builds have produced stripped helpers ranging
// from roughly 26 MiB to 53 MiB despite identical protocol, LLVM version,
// target set, and dynamic dependencies. Keep a hard package-size regression
// fence with enough room for both observed bottle layouts.
const installedBudget = 64 * 1024 * 1024;
const packedBudget = 32 * 1024 * 1024;
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
  const installedSize = statSync(binary).size;
  const packedSize = statSync(tarball).size;
  const sizeFailures = [
    ...(installedSize > installedBudget
      ? [`stripped helper is ${installedSize} bytes, exceeding the ${installedBudget}-byte installed-size budget`]
      : []),
    ...(packedSize > packedBudget
      ? [`helper tarball is ${packedSize} bytes, exceeding the ${packedBudget}-byte compressed-size budget`]
      : []),
  ];
  if (sizeFailures.length > 0) throw new Error(sizeFailures.join("; "));
  const version = JSON.parse(execFileSync(binary, ["version", "--format=json"], {
    encoding: "utf8",
  }));
  if (
    version.protocol_version !== "1" ||
    version.scriptc_package_version !== manifest.version ||
    version.llvm_version !== "22.1.8" ||
    version.default_target !== "arm64-apple-macosx14.0.0"
  ) throw new Error(`packed helper identity mismatch: ${JSON.stringify(version)}`);
  const dependencies = execFileSync("otool", ["-L", binary], { encoding: "utf8" });
  if (/\/opt\/homebrew|\/usr\/local|libLLVM|libzstd/.test(dependencies)) {
    throw new Error(`packed helper has a non-system runtime dependency:\n${dependencies}`);
  }
  const exportedSymbols = execFileSync("nm", ["-gU", binary], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean)
    .map((line) => line.trim().split(/\s+/).at(-1));
  if (exportedSymbols.length !== 1 || exportedSymbols[0] !== "_main") {
    throw new Error(
      `packed helper must export only _main, found: ${exportedSymbols.join(", ")}`,
    );
  }
  const loadCommands = execFileSync("otool", ["-l", binary], { encoding: "utf8" });
  if (!/LC_BUILD_VERSION[\s\S]*?platform 1[\s\S]*?minos 15\.0(?:\s|$)/.test(loadCommands)) {
    throw new Error("packed helper must declare its macOS 15.0 minimum host version");
  }
  const probeInput = join(work, "probe.ll");
  const probeObject = join(work, "probe.o");
  writeFileSync(probeInput, "define i32 @answer() { ret i32 42 }\n");
  execFileSync(binary, [
    "emit", "--input", probeInput, "--output", probeObject,
    "--filetype", "obj", "--target", version.default_target,
    "--opt-level", "2", "--relocation-model", "pic",
    "--diagnostic-format", "json", "--source-path", "/src/probe.ts",
  ]);
  const objectLoadCommands = execFileSync("otool", ["-l", probeObject], { encoding: "utf8" });
  if (!/LC_BUILD_VERSION[\s\S]*?platform 1[\s\S]*?minos 14\.0(?:\s|$)/.test(objectLoadCommands)) {
    throw new Error("packed helper must emit objects with the macOS 14.0 deployment target");
  }
  const attributes = execFileSync("xattr", [binary], { encoding: "utf8" });
  if (attributes.split("\n").includes("com.apple.quarantine")) {
    throw new Error("packed helper carries a quarantine attribute");
  }
  execFileSync("codesign", ["--verify", "--strict", binary], { stdio: "inherit" });
  process.stdout.write(
    `verified ${manifest.name}@${manifest.version}: ${installedSize} bytes installed, ` +
    `${packedSize} bytes packed\n`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
