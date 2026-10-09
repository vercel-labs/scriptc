import type { NativeOptimization } from "../backend/optimization.js";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { NativeCodegenError } from "../backend/native-codegen-core.js";
import { requireNativeArtifact, runNativeTool } from "../backend/native-tools.js";
import type { NativeRuntimePack, NativeRuntimeSelection } from "../backend/runtime-pack-native.js";
import { runtimePackFlavorKey, type RuntimePackMode } from "../backend/runtime-pack-core.js";
import { QJS_ENGINE_SOURCES, LRE_SOURCES, ZLIB_SOURCES } from "../backend/vendor-inputs.js";
import { contentDigest, type NativeCache } from "./cache.js";
import type { NativeToolchain } from "./toolchain.js";

/** Sanitizers retain the documented external Clang requirement. Normal
 * builds use the installed precompiled runtime pack without compiling C. */
export function sanitizerDriver(toolchain: NativeToolchain): string {
  if (
    toolchain.target.platform !== process.platform ||
    toolchain.target.architecture !== process.arch ||
    toolchain.target.name.startsWith("ios-") ||
    toolchain.target.name.startsWith("android-")
  ) {
    throw new NativeCodegenError("SC3002", "--sanitize requires a native host target");
  }
  return process.env["SCRIPTC_CC"] ?? "clang";
}

export function sanitizerFlags(
  toolchain: NativeToolchain,
  optimization: NativeOptimization,
): string[] {
  return [
    "-target",
    toolchain.target.llvmTriple,
    optimization === "dev" ? "-O0" : "-O1",
    "-g",
    "-fsanitize=address",
  ];
}

function sourceFingerprint(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(?:c|h|inc|def)$/.test(entry.name))
        hash.update(path).update("\0").update(readFileSync(path)).update("\0");
    }
  };
  visit(join(root, "src"));
  visit(join(root, "vendor"));
  return hash.digest("hex");
}

/** The installed pack's matrix also selects sanitizer source units and
 * feature defines, keeping native and seed runtime reachability aligned. */
export function buildSanitizedRuntime(
  toolchain: NativeToolchain,
  selection: NativeRuntimeSelection,
  stage: string,
  mode: RuntimePackMode,
  cache: NativeCache | null,
): NativeRuntimePack {
  const driver = sanitizerDriver(toolchain);
  const sourceRoot = toolchain.runtimeSourceRoot;
  if (sourceRoot === undefined)
    throw new NativeCodegenError(
      "SC3003",
      "runtime development sources are missing from this installation",
    );
  const identity = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
  };
  if (identity.name !== "@scriptc/runtime" || identity.version !== toolchain.compilerVersion) {
    throw new NativeCodegenError(
      "SC3003",
      "runtime development source version does not match this compiler",
    );
  }
  const sourceIdentity = sourceFingerprint(sourceRoot);
  const compilerIdentity = runNativeTool(driver, ["--version"]);
  // Runtime allocation and tracing are hot even when the caller skips
  // program optimization. Preserve ASan while keeping these small C units fast.
  const flags = [
    ...sanitizerFlags(toolchain, "release"),
    ...toolchain.target.runtimeCompileDefines.map((define) => "-D" + define),
  ];
  const src = join(sourceRoot, "src");
  const vendor = join(sourceRoot, "vendor");
  const quickjs = join(vendor, "quickjs-ng");
  const zlib = join(vendor, "zlib");
  const mbedtls = join(vendor, "mbedtls");
  const cacheIdentity = contentDigest(
    JSON.stringify({
      schema: 1,
      sourceIdentity,
      compilerIdentity,
      driver,
      target: toolchain.target,
      environment: process.env,
    }),
  );
  mkdirSync(stage, { recursive: true });
  const pending: { key: string; output: string }[] = [];
  const compile = (source: string, name: string, args: string[]): string => {
    const output = join(stage, name);
    const key = contentDigest(JSON.stringify({ cacheIdentity, source, args: [...flags, ...args] }));
    const cached = cache?.read("sanitizer", key);
    if (cached !== null && cached !== undefined) writeFileSync(output, cached);
    else {
      runNativeTool(driver, [...flags, ...args, "-c", source, "-o", output]);
      requireNativeArtifact(output);
      pending.push({ key, output });
    }
    return output;
  };
  const key = runtimePackFlavorKey(selection.manifest, selection.flavor, mode);
  const flavor = selection.manifest.flavors[key];
  if (flavor === undefined) throw new NativeCodegenError("SC3003", `runtime pack lacks ${key}`);
  const wanted = new Set(selection.selected.runtime.map((artifact) => artifact.path));
  const common = [
    "-std=c11",
    "-pthread",
    "-DSCR_RC_AUDIT",
    "-fno-math-errno",
    "-fno-strict-aliasing",
    "-Wno-deprecated-declarations",
    "-I",
    src,
    "-I",
    quickjs,
    "-I",
    zlib,
    "-I",
    join(mbedtls, "include"),
    ...(toolchain.target.platform === "linux" ? ["-ffunction-sections", "-fdata-sections"] : []),
  ];
  const runtimeObjects: string[] = [];
  for (const unit of flavor.runtime_units) {
    for (const variant of unit.variants) {
      if (wanted.has(variant.path))
        runtimeObjects.push(
          compile(join(src, unit.source), unit.source.replace(/\.c$/, ".o"), [
            ...common,
            ...variant.defines.map((define) => "-D" + define),
          ]),
        );
    }
  }
  const archives: string[] = [];
  for (const archive of selection.selected.archives) {
    const name = basename(archive.path)
      .replace(/^libscriptc-/, "")
      .replace(/\.a$/, "");
    let sources: readonly string[];
    let directory: string;
    let args: string[];
    if (name === "quickjs") {
      sources = QJS_ENGINE_SOURCES;
      directory = quickjs;
      args = [
        "-std=gnu11",
        "-fvisibility=hidden",
        "-funsigned-char",
        "-DQUICKJS_NG_BUILD",
        "-D_GNU_SOURCE",
        "-DNDEBUG",
        "-I",
        quickjs,
      ];
    } else if (name === "libregexp") {
      sources = LRE_SOURCES;
      directory = quickjs;
      args = ["-std=c11", "-I", quickjs];
    } else if (name === "zlib") {
      sources = ZLIB_SOURCES;
      directory = zlib;
      args = ["-std=c11", "-I", zlib];
    } else if (name === "mbedtls") {
      directory = join(mbedtls, "library");
      sources = readdirSync(directory)
        .filter((file) => file.endsWith(".c") && !file.startsWith("."))
        .sort();
      args = ["-std=c11", "-I", join(mbedtls, "include"), "-I", directory];
    } else throw new NativeCodegenError("SC3003", `unsupported runtime vendor archive: ${name}`);
    const objects = sources.map((source) =>
      compile(join(directory, source), name + "-" + source.replace(/\.c$/, ".o"), args),
    );
    const output = join(stage, "libscriptc-" + name + ".a");
    runNativeTool(
      toolchain.archiver ?? "ar",
      [...(toolchain.archiverArgs ?? []), "rcs", output, ...objects],
      undefined,
      { ...process.env, ZERO_AR_DATE: "1" },
    );
    requireNativeArtifact(output);
    archives.push(output);
  }
  if (
    sourceFingerprint(sourceRoot) !== sourceIdentity ||
    runNativeTool(driver, ["--version"]) !== compilerIdentity
  ) {
    throw new NativeCodegenError(
      "SC3004",
      "runtime sources or sanitizer compiler changed during the build; retry",
    );
  }
  for (const item of pending) cache?.write("sanitizer", item.key, readFileSync(item.output));
  return { runtimeObjects, archives, systemLibraries: selection.selected.systemLibraries };
}
