#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const [mode, infoArg, outputArg] = process.argv.slice(2);
if ((mode !== "cc" && mode !== "ld") || !infoArg || !outputArg) {
  console.error("usage: node link.mjs <cc|ld> <native-link-info.json> <output>");
  process.exitCode = 2;
} else {
  const info = JSON.parse(readFileSync(infoArg, "utf8"));
  if (info.schema !== "scriptc.native-link-info.v1") {
    throw new Error(`unsupported native link info schema: ${info.schema}`);
  }
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { stdio: "inherit", ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
  };
  const capture = (command, args) => {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || `${command} exited ${result.status}`);
    return result.stdout.trim();
  };

  const infoPath = resolve(infoArg);
  const output = resolve(outputArg);
  const buildDir = join(dirname(infoPath), `.native-link-${mode}`);
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  const runtimeObjects = [];
  const vendorArchives = [];
  for (const set of info.runtime_pack.source_sets) {
    const setDir = join(buildDir, set.name);
    mkdirSync(setDir, { recursive: true });
    const objects = [];
    for (const source of set.sources) {
      const object = join(setDir, `${source.replace(/[^A-Za-z0-9]+/g, "_")}.o`);
      run("clang", [
        ...set.c_flags,
        ...set.defines.map((define) => `-D${define}`),
        ...set.include_directories.flatMap((path) => [
          "-I", join(info.runtime_pack.root, path),
        ]),
        "-c", join(info.runtime_pack.root, source), "-o", object,
      ]);
      objects.push(object);
    }
    if (set.output === "objects") {
      runtimeObjects.push(...objects);
    } else {
      const archive = join(buildDir, basename(set.suggested_output));
      run("ar", ["rcs", archive, ...objects]);
      vendorArchives.push(archive);
    }
  }

  const inputs = [
    info.program.object,
    ...info.ffi.libraries,
    ...runtimeObjects,
    ...vendorArchives,
  ];
  const libraries = info.link.system_libraries.map((name) => `-l${name}`);
  const frameworks = info.link.frameworks.flatMap((name) => ["-framework", name]);
  if (mode === "cc") {
    // Darwin compiler drivers add libSystem themselves. It remains explicit
    // in the document because a direct ld invocation must name it.
    const driverLibraries = info.link.system_libraries
      .filter((name) => name !== "System")
      .map((name) => `-l${name}`);
    run("clang", [
      ...info.link.driver_flags,
      ...inputs,
      ...driverLibraries,
      ...frameworks,
      "-o", output,
    ]);
  } else {
    const sdk = capture("xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
    const sdkVersion = capture("xcrun", ["--sdk", "macosx", "--show-sdk-version"]);
    const linker = capture("xcrun", ["--sdk", "macosx", "--find", "ld"]);
    run(linker, [
      "-arch", info.target.architecture,
      "-platform_version", "macos", info.target.minimum_os, sdkVersion,
      "-syslibroot", sdk,
      ...(info.link.driver_flags.includes("-Wl,-dead_strip") ? ["-dead_strip"] : []),
      ...inputs,
      ...libraries,
      ...frameworks,
      "-o", output,
    ]);
  }
}
