import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { RUNTIME_ABI_MARKER, RUNTIME_ABI_VERSION } from "../backend/runtime-abi.js";
import type { RuntimePackManifest } from "../backend/runtime-pack-core.js";
import { NATIVE_TARGETS } from "../backend/targets.js";
import { buildSanitizedRuntime } from "./sanitizer.js";

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
          packageText: "",
          manifestText: "",
          flavor: "dev",
          selected: {
            runtime: [],
            archives: [artifact],
            systemLibraries: [],
            features: {
              workers: false,
              dynamic: false,
              regex: true,
              copying: false,
              textDecoderLegacy: false,
              fileHandle: false,
              fetch: false,
              netIsland: false,
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
              parseArgs: false,
              stream: false,
              net: false,
              http: false,
              http2: false,
              dgram: false,
              watch: false,
              foreignFfi: false,
              nodeTest: false,
              tls: false,
              tlsCa: false,
              nativeFetch: false,
              netIslandEffective: false,
              netEffective: false,
              httpEffective: false,
              tlsEffective: false,
              tlsCaEffective: false,
              zlibEffective: false,
            },
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
