import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  NATIVE_TARGETS,
  selectNativeTarget,
  type NativeTargetSpec,
  type NativeHelperSpec,
} from "../backend/targets.js";
import {
  checkerBackend,
  tscTsExecutable,
  tscTsPlatformPackage,
} from "../frontend/ts7/checker-backend.js";

export interface NativeToolchain {
  compilerVersion: string;
  ts7Executable: string;
  target: NativeTargetSpec;
  helper: NativeHelperSpec;
  helperExecutable: string;
  helperPackageRoot: string;
  runtimePackRoot: string;
  runtimeSourceRoot?: string;
  linker: string;
  linkerArgs: string[];
  dsymutil: string;
  archiver?: string;
  archiverArgs?: string[];
  relocatableLinker?: string;
  declarationsRoot?: string;
  comptimeExecutable?: string;
  wasiNodeRunner?: string;
  /** The prebuilt lib diagnostics the distribution ships, present while the
   * checker is the distribution's own tsc-ts (lib-diagnostics.ts). */
  prebuiltLibDiagnostics?: string;
}

/** Distribution paths are relative to this manifest, so moving an installed
 * compiler does not bake the seed machine's paths into the native binary. */
export interface NativeToolchainManifest {
  schema: "scriptc.native-toolchain.v1";
  compiler_version: string;
  target: string;
  ts7: string;
  /** The tsc-ts executable, the default checker; without it, an installed `tsc-ts` package's. */
  tsc_ts?: string;
  /** The LLVM helper package; without it, the host's helper package
   * installed beside the compiler (an npm platform package's dependency). */
  llvm_package?: string;
  /** The host runtime pack; without it, the host's runtime pack package
   * installed beside the compiler. */
  runtime_pack?: string;
  runtime_sources?: string;
  linker: string;
  linker_args: string[];
  dsymutil: string;
  declarations?: string;
  runtime_packs?: { target: string; path: string }[];
  archiver?: string;
  archiver_args?: string[];
  relocatable_linker?: string;
  comptime?: string;
  wasi_node_runner?: string;
  /** Answers for the supplied declaration files, computed with `tsc_ts`. */
  lib_diagnostics?: string;
}

function pathFrom(root: string, value: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

function commandFrom(root: string, value: string): string {
  return value.includes("/") || value.includes("\\") ? pathFrom(root, value) : value;
}

/** A package the npm platform package depends on, as Node resolves it from
 * the compiler's directory: nested in the platform package, beside it
 * (hoisted, or pnpm's virtual store), or higher up. The version must be the
 * compiler's. */
function compilerDependency(root: string, packageName: string, version: string): string {
  const directory = installedPackage(root, packageName);
  if (directory === undefined)
    throw new Error(
      `scriptc requires ${packageName}@${version}, which is not installed beside the native compiler; reinstall scriptc`,
    );
  const found = (
    JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
      version?: unknown;
    }
  ).version;
  if (found !== version)
    throw new Error(
      `scriptc requires ${packageName}@${version}, found ${String(found)}; reinstall scriptc`,
    );
  return directory;
}

/** Additional targets are ordinary project dependencies. Resolve them when
 * requested so adding a pack never requires reinstalling the compiler. */
function installedPackage(start: string, packageName: string): string | undefined {
  let directory = resolve(start);
  for (;;) {
    const candidate = join(directory, "node_modules", packageName);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function loadNativeToolchain(
  path: string,
  env: NodeJS.ProcessEnv = {},
  cwd: string = process.cwd(),
): NativeToolchain {
  // Package managers can launch the compiler through a directory junction.
  // Installed asset paths are relative to the physical manifest location.
  const manifestPath = realpathSync(path);
  const raw: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("invalid native toolchain manifest");
  const value = raw as Record<string, unknown>;
  if (value.schema !== "scriptc.native-toolchain.v1")
    throw new Error("unsupported native toolchain manifest schema");
  for (const name of ["compiler_version", "target", "ts7", "linker", "dsymutil"]) {
    if (typeof value[name] !== "string" || value[name] === "")
      throw new Error(`native toolchain requires ${name}`);
  }
  for (const name of ["linker_args"]) {
    if (
      !Array.isArray(value[name]) ||
      !(value[name] as unknown[]).every((arg) => typeof arg === "string")
    ) {
      throw new Error(`native toolchain requires a string array for ${name}`);
    }
  }
  const manifest = raw as NativeToolchainManifest;
  for (const name of [
    "tsc_ts",
    "llvm_package",
    "runtime_pack",
    "runtime_sources",
    "declarations",
    "archiver",
    "relocatable_linker",
    "comptime",
    "wasi_node_runner",
    "lib_diagnostics",
  ]) {
    if (value[name] !== undefined && (typeof value[name] !== "string" || value[name] === ""))
      throw new Error(`native toolchain requires a nonempty string for ${name}`);
  }
  const archiverArgs: unknown = value.archiver_args;
  const runtimePacks: unknown = value.runtime_packs;
  if (
    archiverArgs !== undefined &&
    (!Array.isArray(archiverArgs) || !archiverArgs.every((arg) => typeof arg === "string"))
  ) {
    throw new Error("native toolchain requires a string array for archiver_args");
  }
  if (
    runtimePacks !== undefined &&
    (!Array.isArray(runtimePacks) ||
      !runtimePacks.every((item) => {
        if (item === null || typeof item !== "object") return false;
        const pack = item as Record<string, unknown>;
        return typeof pack.target === "string" && typeof pack.path === "string" && pack.path !== "";
      }))
  ) {
    throw new Error("native toolchain requires target/path entries for runtime_packs");
  }
  const targets: readonly NativeTargetSpec[] = NATIVE_TARGETS;
  const host = targets.find((item) => item.name === manifest.target);
  if (host === undefined || host.platform === "wasi")
    throw new Error(`unsupported native compiler target: ${manifest.target}`);
  const target = selectNativeTarget(env["SCRIPTC_TARGET"] ?? "", host, host.platform);
  if (target === null)
    throw new Error(`unsupported native compiler target: ${env["SCRIPTC_TARGET"]}`);
  const root = dirname(manifestPath);
  const llvmPackage =
    env["SCRIPTC_LLVM_PACKAGE"] ??
    manifest.llvm_package ??
    compilerDependency(root, host.helper.packageName, manifest.compiler_version);
  const helperPackageRoot = pathFrom(root, llvmPackage);
  // The host pack of an npm platform package is its dependency; a
  // distribution archive bundles it beside the compiler.
  const hostRuntimePack =
    manifest.runtime_pack ??
    (target.name === host.name && env["SCRIPTC_RUNTIME_PACK"] === undefined
      ? compilerDependency(root, host.runtimePackPackage, manifest.compiler_version)
      : undefined);
  let runtimePath =
    manifest.runtime_packs?.find((pack) => pack.target === target.name)?.path ??
    (target.name === host.name
      ? hostRuntimePack
      : hostRuntimePack === undefined
        ? undefined
        : join(dirname(hostRuntimePack), target.runtimePackPackage.replace("@scriptc/", "")));
  if (
    target.name !== host.name &&
    env["SCRIPTC_RUNTIME_PACK"] === undefined &&
    (runtimePath === undefined || !existsSync(pathFrom(root, runtimePath)))
  ) {
    runtimePath =
      installedPackage(cwd, target.runtimePackPackage) ??
      installedPackage(root, target.runtimePackPackage) ??
      runtimePath ??
      join(root, "node_modules", target.runtimePackPackage);
  }
  const hostLinker = target.name === host.name && target.defaultLinker === host.defaultLinker;
  const linker = env["SCRIPTC_LINKER"] ?? (hostLinker ? manifest.linker : target.defaultLinker);
  const linkerArgs =
    env["SCRIPTC_LINKER"] !== undefined
      ? []
      : hostLinker
        ? manifest.linker_args
        : [...target.defaultLinkerArgs];
  return {
    compilerVersion: manifest.compiler_version,
    // tsc-ts, the default checker, comes with the distribution; a development
    // build takes it from the tsc-ts package installed with the compiler or for
    // the working directory. SCRIPTC_CHECKER selects a checker.
    ts7Executable:
      checkerBackend(env) === "tsgo"
        ? pathFrom(root, manifest.ts7)
        : manifest.tsc_ts !== undefined
          ? pathFrom(root, manifest.tsc_ts)
          : tscTsExecutable(
              [root, cwd],
              tscTsPlatformPackage(host.platform, host.architecture, host.name.endsWith("-musl")),
              host.platform,
            ),
    target,
    helper: host.helper,
    helperPackageRoot,
    helperExecutable:
      env["SCRIPTC_LLVM_HELPER"] ??
      join(
        helperPackageRoot,
        "bin",
        host.platform === "win32" ? "scriptc-llvm-codegen.exe" : "scriptc-llvm-codegen",
      ),
    runtimePackRoot: pathFrom(root, env["SCRIPTC_RUNTIME_PACK"] ?? runtimePath!),
    ...(manifest.runtime_sources === undefined
      ? {}
      : { runtimeSourceRoot: pathFrom(root, manifest.runtime_sources) }),
    linker: commandFrom(root, linker),
    linkerArgs,
    dsymutil: commandFrom(root, env["SCRIPTC_DSYMUTIL"] ?? manifest.dsymutil),
    ...(manifest.declarations === undefined
      ? {}
      : { declarationsRoot: pathFrom(root, manifest.declarations) }),
    ...(manifest.archiver === undefined ? {} : { archiver: commandFrom(root, manifest.archiver) }),
    ...(manifest.archiver === undefined ? {} : { archiverArgs: manifest.archiver_args ?? [] }),
    ...(manifest.relocatable_linker === undefined
      ? {}
      : { relocatableLinker: commandFrom(root, manifest.relocatable_linker) }),
    ...(manifest.comptime === undefined
      ? {}
      : { comptimeExecutable: pathFrom(root, manifest.comptime) }),
    ...(manifest.wasi_node_runner === undefined
      ? {}
      : { wasiNodeRunner: pathFrom(root, manifest.wasi_node_runner) }),
    // The prebuilt answers are the distribution's tsc-ts's.
    ...(manifest.lib_diagnostics === undefined ||
    manifest.tsc_ts === undefined ||
    checkerBackend(env) === "tsgo"
      ? {}
      : { prebuiltLibDiagnostics: pathFrom(root, manifest.lib_diagnostics) }),
  };
}
