import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { installBytes } from "../library/cache-primitives.js";
import { emitNativeArtifact } from "./native-codegen.js";
import { linkNativeExecutable } from "./linker.js";
import type { NativeLinkFeatures } from "./native-link-info.js";
import { isZigDriver, type CcDriver } from "./native/driver.js";
import { localizeLibraryObjects } from "./native/object-merge.js";
import { type LibArchiveOptions } from "./native/contracts.js";
import { loadRuntimePack, RuntimePackError, stageRuntimePackArtifacts } from "./runtime-pack.js";
import { executableOptimizationLinkerArgs, type NativeTargetSpec } from "./targets.js";

const run = promisify(execFile);

/** Assemble a library from LLVM program objects and verified runtime objects.
 * The runtime's library and per-thread modes are compiled when packaging. */
export async function compilePackedLibrary(
  options: LibArchiveOptions,
  target: NativeTargetSpec,
  wasmExports?: readonly string[],
): Promise<void> {
  const optimization = options.optimization ?? "release";
  const features: NativeLinkFeatures = {
    regex: options.regex ?? false,
    copying: options.copying ?? false,
    textDecoderLegacy: options.textDecoderLegacy ?? false,
    fileHandle: false,
    fetch: false,
    zlib: options.zlib ?? false,
    assert: options.assert ?? false,
    inspect: options.inspect ?? false,
    dynInvoke: options.dynInvoke ?? false,
    ...(options.dynBuffer === true ? { dynBuffer: true } : {}),
    ...(options.dynTier === true ? { dynTier: true } : {}),
    dc: false,
    dynAsync: false,
    events: false,
    emitter: options.emitter ?? false,
    symbol: options.symbol ?? false,
    bigint: options.bigint ?? false,
    searchParams: options.searchParams ?? false,
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
    x509: options.x509 ?? false,
    webcrypto: false,
    perfLoop: false,
    tlsCa: false,
  };
  const selection = await loadRuntimePack({
    target,
    features,
    optimization,
    mode: options.threadInstances ? "library-thread" : "library",
  });
  if (target.platform === "wasi") {
    if (wasmExports === undefined)
      throw new Error("Wasm library linking requires explicit exports");
    const buildDir = await mkdtemp(join(tmpdir(), "scriptc-wasm-library-"));
    try {
      const program = join(buildDir, "program.o");
      await emitNativeArtifact({
        outputPath: program,
        llvm: await readFile(options.cPath, "utf8"),
        sourcePath: options.cPath,
        outputKind: "obj",
        optimization: optimization === "dev" ? "0" : "2",
        target,
      });
      await mkdir(dirname(options.outPath), { recursive: true });
      await linkNativeExecutable({
        target,
        outputPath: options.outPath,
        inputs: [program, ...selection.runtimeObjects, ...selection.archives],
        systemLibraries: selection.systemLibraries,
        driverFlags: [
          "-target",
          target.linkerTargetTriple,
          "-mexec-model=reactor",
          ...executableOptimizationLinkerArgs(target.platform, optimization),
          ...wasmExports.map((name) => `-Wl,--export=${name}`),
        ],
        dependencyPaths: selection.dependencyPaths,
        programObjectDependencies: [],
        runtimePack: selection,
      });
    } finally {
      await rm(buildDir, { recursive: true, force: true });
    }
    return;
  }
  const stage = await stageRuntimePackArtifacts(selection);
  try {
    const buildDir = await mkdtemp(join(tmpdir(), "scriptc-library-pack-"));
    try {
      const driver: CcDriver = {
        argv: [target.defaultLinker, ...target.defaultLinkerArgs],
        target:
          target.defaultLinker === "clang" &&
          target.platform === "linux" &&
          process.platform === "linux" &&
          target.architecture === process.arch
            ? null
            : target.llvmTriple,
        zigTarget: target.linkerTargetTriple,
        targetArgs: ["-target", target.linkerTargetTriple],
        linkArgs: [],
      };
      const archiver = isZigDriver(driver) ? [driver.argv[0]!, "ar"] : ["ar"];
      const stem = basename(options.cPath).replace(/\.ll$/, "");
      const emit = async (source: string, name: string): Promise<string> => {
        const outputPath = join(buildDir, name);
        await emitNativeArtifact({
          outputPath,
          llvm: source,
          sourcePath: options.cPath,
          outputKind: "obj",
          optimization: optimization === "dev" ? "0" : "2",
          target,
        });
        return outputPath;
      };
      let program: string;
      const shards = options.programShards;
      if (shards !== undefined && shards.length > 1 && options.programPublicSymbols !== undefined) {
        const objects: string[] = [];
        // Limit active helper processes: large compiler libraries otherwise
        // multiply LLVM's peak memory by the number of shards.
        for (let start = 0; start < shards.length; start += 4) {
          objects.push(
            ...(await Promise.all(
              shards
                .slice(start, start + 4)
                .map((shard, offset) => emit(shard.source, `shard-${start + offset}.o`)),
            )),
          );
        }
        program = await localizeLibraryObjects(
          driver,
          archiver,
          buildDir,
          objects,
          [],
          options.programPublicSymbols,
          stem,
          target.platform,
        );
      } else {
        program = await emit(
          options.programSource ?? (await readFile(options.cPath, "utf8")),
          `${stem}.o`,
        );
      }
      const roots = [program];
      if (options.identityLlvmSource !== undefined)
        roots.push(await emit(options.identityLlvmSource, `${stem}.identity.o`));
      const support = selection.runtimeObjects.map((path) => stage.replacements.get(path)!);
      for (const [index, archive] of selection.archives.entries()) {
        const input = stage.replacements.get(archive)!;
        const listing = await run(archiver[0]!, [...archiver.slice(1), "t", input]);
        const names = listing.stdout
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
        const directory = join(buildDir, `vendor-${index}`);
        await mkdir(directory);
        await run(archiver[0]!, [...archiver.slice(1), "x", input, ...names], { cwd: directory });
        support.push(...names.map((name) => join(directory, name)));
      }
      const members =
        options.localizeSymbols === undefined
          ? [...roots, ...support]
          : [
              await localizeLibraryObjects(
                driver,
                archiver,
                buildDir,
                roots,
                support,
                options.localizeSymbols,
                `${stem}.runtime`,
                target.platform,
              ),
            ];
      const archive = join(buildDir, "library.a");
      await run(archiver[0]!, [...archiver.slice(1), "rcs", archive, ...members], {
        env: { ...process.env, ZERO_AR_DATE: "1" },
      });
      await mkdir(dirname(options.outPath), { recursive: true });
      await installBytes(await readFile(archive), options.outPath);
    } finally {
      await rm(buildDir, { recursive: true, force: true });
    }
  } finally {
    await rm(stage.root, { recursive: true, force: true });
  }
}
