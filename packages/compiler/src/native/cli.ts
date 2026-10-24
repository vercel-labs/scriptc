import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../cli/command.js";
import type { NativeCacheWarmProfile } from "../cli/host.js";
import {
  selectNativeRuntimePack,
  stageNativeRuntimeSelection,
} from "../backend/runtime-pack-native.js";
import { mergeNativeProfiles } from "../backend/native-tools.js";
import { setDeclarationRoot } from "../frontend/dts-paths.js";
import { setFrontendDisposedHook } from "../frontend/dispose-hook.js";
import { FrontendServices } from "../frontend/services.js";
import { createNativeTs7Api } from "../frontend/ts7/native-api.js";
import { resolveProvenanceSourcesWithParser } from "../frontend/provenance-core.js";
import { setCompilerReleaseVersion } from "../library/sidecar.js";
import { NativeCompiler } from "./compiler.js";
import { NATIVE_STRING_BYTES, openNativeCache } from "./cache.js";
import {
  checkerExecutableIdentity,
  setLibDiagnosticsStore,
} from "../frontend/ts7/lib-diagnostics.js";
import { loadNativeToolchain } from "./toolchain.js";
import { buildSanitizedRuntime } from "./sanitizer.js";
import { runCompilerTask } from "./task.js";
import { processFork } from "../frontend/process-fork.js";

declare function compilerNativePrivateDirectory(path: string, harden: boolean): boolean;
declare function compilerNativeCollectCycles(): void;
declare function compilerNativeFork(): number;
declare function compilerNativeExit(code: number): void;
declare function compilerNativeWait(pid: number): number;
declare function compilerNativeLockOpen(path: string): boolean;
declare function compilerNativeLock(): void;
declare function compilerNativeUnlock(): void;
declare function compilerNativeBoundCycleGrowth(): void;

async function main(): Promise<number> {
  compilerNativeBoundCycleGrowth();
  setFrontendDisposedHook(() => compilerNativeCollectCycles());
  if (process.platform !== "win32")
    processFork.primitives = {
      fork: () => compilerNativeFork(),
      exit: (code) => compilerNativeExit(code),
      wait: (pid) => compilerNativeWait(pid),
      openLock: (path) => compilerNativeLockOpen(path),
      lock: () => compilerNativeLock(),
      unlock: () => compilerNativeUnlock(),
    };
  const manifestPath = process.env["SCRIPTC_TOOLCHAIN"] ?? process.execPath + ".json";
  let compiler: NativeCompiler | null = null;
  let cache: ReturnType<typeof openNativeCache> = null;
  const getCompiler = (): NativeCompiler => {
    if (compiler !== null) return compiler;
    const toolchain = loadNativeToolchain(manifestPath, process.env);
    if (toolchain.declarationsRoot !== undefined) setDeclarationRoot(toolchain.declarationsRoot);
    setCompilerReleaseVersion(toolchain.compilerVersion);
    cache = openNativeCache((path, harden) => compilerNativePrivateDirectory(path, harden));
    if (cache !== null) {
      const store = cache;
      setLibDiagnosticsStore(
        {
          read: (key) =>
            store.read("lib-diagnostics", key, NATIVE_STRING_BYTES)?.toString("utf8") ?? null,
          write: (key, text) => store.write("lib-diagnostics", key, text),
        },
        checkerExecutableIdentity(toolchain.ts7Executable),
      );
    }
    compiler = new NativeCompiler(toolchain, cache);
    return compiler;
  };
  return runCli(process.argv.slice(2), {
    version: () => loadNativeToolchain(manifestPath).compilerVersion,
    sourceTargetPlatform: () => getCompiler().toolchain.target.platform,
    analyze: (entry, options) => runCompilerTask(() => getCompiler().analyzeCached(entry, options)),
    compile: (entry, options) => runCompilerTask(() => getCompiler().compile(entry, options)),
    compileLibrary: (options) => runCompilerTask(() => getCompiler().compileLibrary(options)),
    resolveProvenanceSources: async (entry) => {
      const toolchain = getCompiler().toolchain;
      const services = new FrontendServices((options) =>
        createNativeTs7Api({ ...options, executable: toolchain.ts7Executable }),
      );
      try {
        return await resolveProvenanceSourcesWithParser(entry, (path, source, kind) =>
          services.parse(path, source, kind),
        );
      } finally {
        services.close();
      }
    },
    warmNativeCaches: async (options) => {
      const toolchain = getCompiler().toolchain;
      if (cache === null) throw new Error("the native build cache is disabled or unavailable");
      if (!toolchain.target.supports.exe)
        throw new Error(
          `native cache warming requires an executable target; ${toolchain.target.name} supports library archives`,
        );
      const profiles: { profile: NativeCacheWarmProfile; elapsedMs: number }[] = [];
      for (const profile of [
        ...new Set(options.profiles ?? (["runtime", "tls", "dynamic"] as NativeCacheWarmProfile[])),
      ]) {
        const start = performance.now();
        const stage = mkdtempSync(join(tmpdir(), "scriptc-warm-"));
        try {
          const pack = selectNativeRuntimePack(
            toolchain.runtimePackRoot,
            toolchain.target,
            toolchain.compilerVersion,
            {
              fetch: profile === "tls",
              regex: false,
              copying: false,
              textDecoderLegacy: false,
              fileHandle: false,
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
              cipher: false,
              ecdh: false,
              dh: false,
              pki: false,
              ed25519: false,
              x509: false,
              webcrypto: false,
              perfLoop: false,
              tlsCa: false,
            },
            options.optimization ?? "release",
          );
          if (options.sanitize) buildSanitizedRuntime(toolchain, pack, stage, "executable", cache);
          else stageNativeRuntimeSelection(pack, stage);
        } finally {
          rmSync(stage, { recursive: true, force: true });
        }
        profiles.push({ profile, elapsedMs: performance.now() - start });
      }
      return { cacheRoot: cache.root, profiles };
    },
    mergeProfiles: async (outputPath, inputPaths, sparse) => {
      const toolchain = getCompiler().toolchain;
      mergeNativeProfiles({
        executable: toolchain.helperExecutable,
        packageRoot: toolchain.helperPackageRoot,
        compilerVersion: toolchain.compilerVersion,
        target: toolchain.target,
        helper: toolchain.helper,
        outputPath,
        inputPaths,
        sparse,
      });
    },
    run: async (binary) => {
      const toolchain = getCompiler().toolchain;
      let executable = binary;
      const args: string[] = [];
      if (toolchain.target.platform === "wasi") {
        if (toolchain.wasiNodeRunner === undefined)
          throw new Error("the WASI runner is missing from this installation");
        executable = "node";
        args.push("--no-warnings", toolchain.wasiNodeRunner, binary);
      }
      const result = spawnSync(executable, args, { stdio: "inherit" });
      if (result.error) {
        if (toolchain.target.platform === "wasi") {
          throw new Error(
            `could not start the Node.js WASI host: ${result.error.message}; running WASI modules requires Node.js 24 or newer on PATH; use scriptc build to compile without Node`,
          );
        }
        throw new Error(result.error.message);
      }
      if (result.signal) {
        process.stderr.write(`scriptc: program killed by ${result.signal}\n`);
        return 1;
      }
      return result.status ?? 0;
    },
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`scriptc: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
