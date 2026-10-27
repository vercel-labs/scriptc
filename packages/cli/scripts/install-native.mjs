import {
  constants,
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function nativeCliPackage(platform, architecture, libc) {
  const host = `${platform}-${architecture}`;
  if (host === "darwin-arm64" || host === "darwin-x64") return `@scriptc/cli-${host}`;
  if (host === "win32-x64") return "@scriptc/cli-win32-x64-msvc";
  if (host === "linux-x64" || host === "linux-arm64") {
    if (libc !== "glibc" && libc !== "musl")
      throw new Error("could not identify the Linux C library");
    return `@scriptc/cli-${host}-${libc === "musl" ? "musl" : "gnu"}`;
  }
  throw new Error(`scriptc has no native command for ${host}`);
}

function hostLibc() {
  if (process.platform !== "linux") return null;
  const report = process.report.getReport();
  if (report.header.glibcVersionRuntime) return "glibc";
  if (report.sharedObjects.some((path) => /(?:^|\/)ld-musl-|libc\.musl-/.test(path))) return "musl";
  // A statically linked Node has no loaded libc in its process report.
  // Only select musl when its loader is present for this architecture.
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return existsSync(`/lib/ld-musl-${arch}.so.1`) ? "musl" : null;
}

export function relocateToolchain(manifest, sourceDirectory, destinationDirectory) {
  const relocated = { ...manifest };
  const pathFrom = (value) => relative(destinationDirectory, resolve(sourceDirectory, value));
  for (const name of [
    "ts7",
    "tsc_ts",
    "llvm_package",
    "runtime_pack",
    "runtime_sources",
    "declarations",
    "comptime",
    "wasi_node_runner",
    "lib_diagnostics",
  ]) {
    if (typeof relocated[name] === "string") relocated[name] = pathFrom(relocated[name]);
  }
  for (const name of ["linker", "dsymutil", "archiver", "relocatable_linker"]) {
    const value = relocated[name];
    if (typeof value === "string" && !isAbsolute(value) && /[/\\]/.test(value))
      relocated[name] = pathFrom(value);
  }
  if (relocated.runtime_packs)
    relocated.runtime_packs = relocated.runtime_packs.map((pack) => ({
      ...pack,
      path: pathFrom(pack.path),
    }));
  return relocated;
}

export function installNativeCli(
  directory,
  packageName = nativeCliPackage(process.platform, process.arch, hostLibc()),
) {
  directory = realpathSync(directory);
  const require = createRequire(join(directory, "package.json"));
  const packageManifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const version = packageManifest.version;
  let platformManifest;
  try {
    platformManifest = require.resolve(`${packageName}/package.json`);
  } catch {
    throw new Error(
      `scriptc requires ${packageName}@${version}; reinstall with optional dependencies enabled`,
    );
  }
  const identity = JSON.parse(readFileSync(platformManifest, "utf8"));
  if (identity.name !== packageName || identity.version !== version)
    throw new Error(`scriptc requires ${packageName}@${version}, found ${identity.version}`);
  const sourceDirectory = join(dirname(platformManifest), "dist", "bin");
  const source = join(sourceDirectory, process.platform === "win32" ? "scriptc.exe" : "scriptc");
  const original = JSON.parse(readFileSync(source + ".json", "utf8"));
  if (original.schema !== "scriptc.native-toolchain.v1" || original.compiler_version !== version)
    throw new Error("native compiler toolchain version does not match this installation");
  const bin = join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  const manifest = relocateToolchain(original, sourceDirectory, bin);
  // A platform package depends on its LLVM helper and runtime pack packages
  // instead of bundling them. Record where the package manager put them.
  if (manifest.llvm_package === undefined || manifest.runtime_pack === undefined) {
    const dependencies = Object.keys(identity.dependencies ?? {});
    const installed = (prefix) => {
      const name = dependencies.find((dependency) => dependency.startsWith(prefix));
      if (name === undefined)
        throw new Error(`${packageName} does not depend on a ${prefix}* package`);
      let path, found;
      try {
        path = createRequire(platformManifest).resolve(`${name}/package.json`);
        found = JSON.parse(readFileSync(path, "utf8")).version;
      } catch {
        throw new Error(`scriptc requires ${name}@${version}; reinstall scriptc`);
      }
      if (found !== version)
        throw new Error(`scriptc requires ${name}@${version}, found ${found}; reinstall scriptc`);
      return relative(bin, dirname(path));
    };
    manifest.llvm_package ??= installed("@scriptc/llvm-");
    if (manifest.runtime_pack === undefined) {
      manifest.runtime_pack = installed("@scriptc/runtime-");
      manifest.runtime_packs = [
        { target: manifest.target, path: manifest.runtime_pack },
        ...(manifest.runtime_packs ?? []),
      ];
    }
  }
  // npm normalizes modes for payloads outside package bin entries. These
  // tools are launched directly by the compiler after installation.
  if (process.platform !== "win32") {
    for (const path of [
      manifest.ts7,
      ...(manifest.tsc_ts === undefined ? [] : [manifest.tsc_ts]),
      manifest.comptime,
      join(manifest.llvm_package, "bin/scriptc-llvm-codegen"),
    ]) {
      chmodSync(resolve(bin, path), 0o755);
    }
  }
  // The common filename lets npm's Windows shim invoke a native executable.
  // POSIX bin links also execute this file directly, without a JS launcher.
  const destination = join(bin, "scriptc.exe");
  const staged = destination + `.install-${process.pid}`;
  try {
    copyFileSync(source, staged, constants.COPYFILE_FICLONE);
    chmodSync(staged, 0o755);
    writeFileSync(staged + ".json", JSON.stringify(manifest, null, 2) + "\n");
    renameSync(staged + ".json", destination + ".json");
    renameSync(staged, destination);
  } finally {
    rmSync(staged, { force: true });
    rmSync(staged + ".json", { force: true });
  }
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    // A source checkout builds the native distribution separately. pnpm pack
    // replaces workspace ranges with release versions before publication.
    const workspace = Object.values(manifest.optionalDependencies ?? {}).some((value) =>
      String(value).startsWith("workspace:"),
    );
    if (!workspace) installNativeCli(directory);
  } catch (error) {
    process.stderr.write(`scriptc: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
