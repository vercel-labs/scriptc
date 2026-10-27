import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { RUNTIME_ABI_MARKER, RUNTIME_ABI_VERSION } from "../backend/runtime-abi.js";
import type { RuntimePackManifest } from "../backend/runtime-pack-core.js";
import { NATIVE_TARGETS } from "../backend/targets.js";
import { buildSanitizedRuntime } from "./sanitizer.js";

/** Every runtime feature off except regex. */
const features = {
  workers: false,
  youngNursery: false,
  eventTarget: false,
  wasm: false,
  dynTier: false,
  streamDyn: false,
  handleProps: false,
  declAdopt: false,
  typeOrigins: false,
  dynForAwait: false,
  eventsOnceSignal: false,
  mime: false,
  largePages: false,
  utilTiming: false,
  dynBuffer: false,
  builtinValues: false,
  computedRequire: false,
  warningReplace: false,
  stdioExtended: false,
  brotli: false,
  moduleNamespace: false,
  regex: true,
  copying: false,
  textDecoderLegacy: false,
  fileHandle: false,
  fetch: false,
  zlib: false,
  assert: false,
  inspect: false,
  dynInvoke: false,
  dc: false,
  dynAsync: false,
  events: false,
  emitter: false,
  symbol: false,
  bigint: false,
  searchParams: false,
  qs: false,
  utilPromisify: false,
  dynBuiltinClass: false,
  dynBuiltinStream: false,
  parseArgs: false,
  stream: false,
  net: false,
  http: false,
  http2: false,
  dgram: false,
  dnsPromises: false,
  dgramDyn: false,
  textCodecDyn: false,
  watch: false,
  foreignFfi: false,
  nodeTest: false,
  tls: false,
  tlsCa: false,
  cipher: false,
  ecdh: false,
  dh: false,
  pki: false,
  ed25519: false,
  x509: false,
  webcrypto: false,
  perfLoop: false,
  nativeFetch: false,
  netEffective: false,
  httpEffective: false,
  tlsEffective: false,
  tlsCaEffective: false,
  zlibEffective: false,
};

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "sanitized vendor archives compile with host libc declarations",
  () => {
    const target = NATIVE_TARGETS.find(
      (item) =>
        item.platform === process.platform &&
        item.architecture === process.arch &&
        !item.name.endsWith("-musl"),
    );
    if (target === undefined) throw new Error("unsupported sanitizer test host");
    const runtimeSourceRoot = fileURLToPath(new URL("../../../runtime", import.meta.url));
    const { version } = JSON.parse(
      readFileSync(join(runtimeSourceRoot, "package.json"), "utf8"),
    ) as { version: string };
    const directory = mkdtempSync("/tmp/scriptc-sanitized-vendor-");
    const artifact = { path: "libscriptc-libregexp.a", sha256: "0".repeat(64), size: 0 };
    const manifest: RuntimePackManifest = {
      schema: "scriptc.runtime-pack.v1",
      format: 1,
      package: target.runtimePackPackage,
      version,
      target: {
        name: target.name,
        llvm_triple: target.llvmTriple,
        architecture: target.architecture,
        object_format: target.objectFormat,
        minimum_os: target.minimumOs,
      },
      runtime_abi: { version: RUNTIME_ABI_VERSION, marker: RUNTIME_ABI_MARKER },
      compiler: { command: "clang", identity: "test", target: target.llvmTriple },
      macros: { executable: [], excluded: [], sanitizer: "external-toolchain-required" },
      flavors: { dev: { optimization: "-O0", runtime_units: [] } },
      archives: [{ ...artifact, id: "libregexp", predicate: true }],
      system_libraries: [],
      licenses: [],
    };
    try {
      // Exercise the actual strict-C11 vendor sources. On Linux, their shared
      // headers need the target feature defines to expose POSIX declarations.
      const built = buildSanitizedRuntime(
        {
          compilerVersion: version,
          target,
          helper: target.helper,
          runtimeSourceRoot,
          ts7Executable: "unused",
          helperExecutable: "unused",
          helperPackageRoot: "unused",
          runtimePackRoot: "unused",
          linker: "unused",
          linkerArgs: [],
          dsymutil: "unused",
        },
        {
          root: directory,
          manifest,
          licenses: manifest.licenses,
          packageText: "",
          manifestText: "",
          flavor: "dev",
          selected: {
            runtime: [],
            archives: [artifact],
            systemLibraries: [],
            features,
          },
        },
        directory,
        "executable",
        null,
      );
      expect(built.runtimeObjects).toEqual([]);
      const archive = join(directory, "libscriptc-libregexp.a");
      expect(built.archives).toEqual([archive]);
      expect(statSync(archive).size).toBeGreaterThan(0);
      expect(execFileSync("ar", ["t", archive], { encoding: "utf8" }).trim().split("\n")).toEqual(
        expect.arrayContaining(["libregexp-libregexp.o", "libregexp-libunicode.o"]),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "variants that share an artifact file compile once, as the selected variant",
  () => {
    const target = NATIVE_TARGETS.find(
      (item) =>
        item.platform === process.platform &&
        item.architecture === process.arch &&
        !item.name.endsWith("-musl"),
    );
    if (target === undefined) throw new Error("unsupported sanitizer test host");
    const runtimeSourceRoot = fileURLToPath(new URL("../../../runtime", import.meta.url));
    const { version } = JSON.parse(
      readFileSync(join(runtimeSourceRoot, "package.json"), "utf8"),
    ) as { version: string };
    const directory = mkdtempSync("/tmp/scriptc-sanitized-shared-");
    // The pack stores the identical objects of both variants once.
    const shared = {
      path: "artifacts/dev/runtime/default/scr_hash.o",
      sha256: "0".repeat(64),
      size: 0,
    };
    const variants = [
      { ...shared, id: "default", when: { workers: false }, defines: [] },
      { ...shared, id: "default-workers", when: { workers: true }, defines: ["SCR_WORKERS"] },
    ];
    const manifest: RuntimePackManifest = {
      schema: "scriptc.runtime-pack.v1",
      format: 1,
      package: target.runtimePackPackage,
      version,
      target: {
        name: target.name,
        llvm_triple: target.llvmTriple,
        architecture: target.architecture,
        object_format: target.objectFormat,
        minimum_os: target.minimumOs,
      },
      runtime_abi: { version: RUNTIME_ABI_VERSION, marker: RUNTIME_ABI_MARKER },
      compiler: { command: "clang", identity: "test", target: target.llvmTriple },
      macros: { executable: [], excluded: [], sanitizer: "external-toolchain-required" },
      flavors: {
        dev: {
          optimization: "-O0",
          runtime_units: [{ source: "scr_hash.c", predicate: true, variants }],
        },
      },
      archives: [],
      system_libraries: [],
      licenses: [],
    };
    try {
      const built = buildSanitizedRuntime(
        {
          compilerVersion: version,
          target,
          helper: target.helper,
          runtimeSourceRoot,
          ts7Executable: "unused",
          helperExecutable: "unused",
          helperPackageRoot: "unused",
          runtimePackRoot: "unused",
          linker: "unused",
          linkerArgs: [],
          dsymutil: "unused",
        },
        {
          root: directory,
          manifest,
          licenses: manifest.licenses,
          packageText: "",
          manifestText: "",
          flavor: "dev",
          selected: { runtime: [variants[0]!], archives: [], systemLibraries: [], features },
        },
        directory,
        "executable",
        null,
      );
      expect(built.runtimeObjects).toEqual([join(directory, "scr_hash.o")]);
      expect(statSync(join(directory, "scr_hash.o")).size).toBeGreaterThan(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
