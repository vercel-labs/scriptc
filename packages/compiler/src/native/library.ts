import type { NativeOptimization } from "../backend/optimization.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { requireNativeArtifact, runNativeTool } from "../backend/native-tools.js";
import { localizeElfObject, mergeAndLocalizeCoffObjects } from "../backend/object-localize.js";
import { RuntimePackError } from "../backend/runtime-pack-core.js";
import type { NativeRuntimePack } from "../backend/runtime-pack-native.js";
import { executableOptimizationLinkerArgs } from "../backend/targets.js";
import type { NativeToolchain } from "./toolchain.js";

function archiver(toolchain: NativeToolchain): { executable: string; args: string[] } {
  if (toolchain.archiver !== undefined)
    return { executable: toolchain.archiver, args: toolchain.archiverArgs ?? [] };
  const zig = /(?:^|[\\/])zig(?:\.exe)?$/.test(toolchain.linker);
  return zig ? { executable: toolchain.linker, args: ["ar"] } : { executable: "ar", args: [] };
}

/** Archive member names are untrusted package data, even after digest verification. */
export function runtimeArchiveMembers(listing: string): string[] {
  const names = listing
    .trim()
    .split(/\r?\n/)
    .filter((name) => name !== "" && name !== "__.SYMDEF" && name !== "__.SYMDEF SORTED");
  if (
    new Set(names).size !== names.length ||
    names.some((name) => !/^[A-Za-z0-9_.-]+\.o$/.test(name))
  ) {
    throw new RuntimePackError(
      "runtime vendor archive has invalid or duplicate object members",
      "invalid",
    );
  }
  return names;
}

/** Localize the runtime without changing the library's declared C ABI. */
export function localizeNativeLibrary(
  toolchain: NativeToolchain,
  stage: string,
  roots: string[],
  support: string[],
  keep: string[],
): string {
  const combined = join(stage, "library.localized.o");
  const platform = toolchain.target.platform;
  if (platform === "win32") {
    writeFileSync(
      combined,
      mergeAndLocalizeCoffObjects(
        roots.map((path) => readFileSync(path)),
        support.map((path) => readFileSync(path)),
        new Set(keep),
        {
          roots: roots.map((path) => basename(path)),
          support: support.map((path) => basename(path)),
        },
      ),
    );
    return combined;
  }
  const ar = archiver(toolchain);
  const supportArgs: string[] = [];
  if (support.length > 0) {
    const archive = join(stage, "support.a");
    runNativeTool(ar.executable, [...ar.args, "rcs", archive, ...support], undefined, {
      ...process.env,
      ZERO_AR_DATE: "1",
    });
    supportArgs.push(archive);
  }
  if (platform === "darwin") {
    if (process.platform !== "darwin")
      throw new Error("Mach-O library localization requires a macOS host");
    const symbols = join(stage, "public.syms");
    writeFileSync(symbols, keep.map((name) => `_${name}\n`).join(""));
    runNativeTool(toolchain.relocatableLinker ?? "ld", [
      "-r",
      ...roots,
      ...supportArgs,
      "-o",
      combined,
      "-exported_symbols_list",
      symbols,
    ]);
  } else if (platform === "linux") {
    runNativeTool(toolchain.linker, [
      ...toolchain.linkerArgs,
      "-target",
      toolchain.target.linkerTargetTriple,
      "-nostdlib",
      "-r",
      ...roots,
      ...supportArgs,
      "-o",
      combined,
    ]);
    writeFileSync(combined, localizeElfObject(readFileSync(combined), new Set(keep)));
  } else throw new Error(`library localization is unavailable for ${toolchain.target.name}`);
  requireNativeArtifact(combined);
  return combined;
}

export function archiveNativeLibrary(options: {
  toolchain: NativeToolchain;
  programObject: string;
  outputPath: string;
  stage: string;
  runtime: NativeRuntimePack;
  localizeSymbols?: string[];
}): void {
  const { toolchain, stage } = options;
  const ar = archiver(toolchain);
  const program = options.programObject;
  const support = [...options.runtime.runtimeObjects];
  for (let index = 0; index < options.runtime.archives.length; index++) {
    const archive = options.runtime.archives[index]!;
    const members = runtimeArchiveMembers(runNativeTool(ar.executable, [...ar.args, "t", archive]));
    const directory = join(stage, `vendor-${index}`);
    mkdirSync(directory);
    if (members.length > 0)
      runNativeTool(ar.executable, [...ar.args, "x", archive, ...members], directory);
    support.push(...members.map((name) => join(directory, name)));
  }
  const objects =
    options.localizeSymbols === undefined
      ? [program, ...support]
      : [localizeNativeLibrary(toolchain, stage, [program], support, options.localizeSymbols)];
  runNativeTool(ar.executable, [...ar.args, "rcs", options.outputPath, ...objects], undefined, {
    ...process.env,
    ZERO_AR_DATE: "1",
  });
  requireNativeArtifact(options.outputPath);
}

export function linkNativeWasmLibrary(options: {
  toolchain: NativeToolchain;
  programObject: string;
  outputPath: string;
  runtime: NativeRuntimePack;
  optimization: NativeOptimization;
  exports: string[];
}): void {
  const { toolchain, runtime } = options;
  runNativeTool(toolchain.linker, [
    ...toolchain.linkerArgs,
    "-target",
    toolchain.target.linkerTargetTriple,
    "-mexec-model=reactor",
    ...executableOptimizationLinkerArgs("wasi", options.optimization),
    ...options.exports.map((name) => `-Wl,--export=${name}`),
    options.programObject,
    ...runtime.runtimeObjects,
    ...runtime.archives,
    ...runtime.systemLibraries.map((name) => `-l${name}`),
    "-o",
    options.outputPath,
  ]);
  requireNativeArtifact(options.outputPath);
}
