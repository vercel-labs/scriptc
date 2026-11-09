import { chmod, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CLI_COMMANDS, CLI_OPTIONS } from "../cli/usage.js";
import {
  FrontendInputTracker,
  trackedFileExists,
  trackedReadFile,
} from "../frontend/input-tracker.js";
import { nativeProgramPartitions } from "../backend/native-codegen-core.js";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import {
  nativeArtifactDependenciesStillMatch,
  snapshotNativeArtifactDependencies,
} from "../backend/native-toolchain.js";
import { installDarwinDebugSymbols, readDarwinDebugSymbols } from "../backend/debug-symbols.js";
import {
  hasEarlyExecutableNativeBuild,
  publishEarlyExecutableCache,
  readEarlyExecutableCache,
  readRoutedExecutableCache,
  recordEarlyExecutableNativeBuild,
  earlyExecutableCacheKeys,
  type EarlyExecutableCacheOptions,
  type EarlyExecutableNativeFeatures,
} from "./executable-cache.js";

const scratch: string[] = [];

/** The host's threads, which size partitions (nativeProgramPartitions). */
const hostThreads = vi.hoisted(() => ({ count: 8 }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => hostThreads.count,
}));

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const native: EarlyExecutableNativeFeatures = {
  backend: "llvm",
  regex: false,
  copying: false,
  textDecoderLegacy: false,
  bigintBytes: false,
  mutableBuffers: false,
  fileHandle: false,
  fetch: true,
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
  watchFile: false,
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
};

async function fixture(): Promise<{
  root: string;
  options: EarlyExecutableCacheOptions;
  source: string;
  missing: string;
  llvmPath: string;
  irPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-early-executable-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  const llvmPath = join(dir, "entry.ll");
  const irPath = join(dir, "entry.ir.json");
  await Promise.all([
    writeFile(source, 'console.log("hello");\n'),
    writeFile(llvmPath, "; generated llvm\n"),
    writeFile(irPath, '{"irVersion":6}\n'),
  ]);
  return {
    root: join(dir, "cache"),
    source,
    missing: join(dir, "missing.ts"),
    llvmPath,
    irPath,
    options: {
      entryPath: source,
      outDir: dir,
      outPath: join(dir, "entry"),
      emitIr: true,
      sanitize: false,
      backend: "llvm",
      npmStatic: null,
      ffiProfile: null,
      target: "test",
      compiler: ["clang"],
      nativeEnvironment: "test-native-environment",
      nodeVersion: "v24-test",
      implementation: "a".repeat(64),
      implementationDependencies: [],
    },
  };
}

test("early executable cache restores the emitted TU, IR, and native feature gates", async () => {
  const f = await fixture();
  const tracker = new FrontendInputTracker();
  tracker.run(() => {
    trackedReadFile(f.source);
    trackedFileExists(f.missing);
  });
  await publishEarlyExecutableCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    native,
    executableRestored: false,
    frontend: tracker.snapshot(),
  });
  await Promise.all([rm(f.llvmPath), rm(f.irPath)]);
  const alternateC = join(f.options.outDir, "entry.c");
  await writeFile(alternateC, "/* user-owned native source */\n");

  const hit = await readEarlyExecutableCache(f.root, f.options);
  expect(hit?.native).toEqual(native);
  expect(hit?.executableRestored).toBe(false);
  // The build compiles private copies beside the shared names and installs
  // them there when it is done.
  expect(hit?.llvmPath).toBe(f.llvmPath);
  expect(hit?.irPath).toBe(f.irPath);
  expect(hit?.llvmSourcePath).toMatch(/[/\\]\.scriptc-llvm-[^/\\]*\.ll$/);
  expect(hit?.irSourcePath).toMatch(/[/\\]\.scriptc-ir-/);
  expect(await readFile(hit!.llvmSourcePath!, "utf8")).toBe("; generated llvm\n");
  expect(await readFile(hit!.irSourcePath!, "utf8")).toContain("irVersion");
  await expect(stat(f.llvmPath)).rejects.toThrow();
  expect(await readFile(alternateC, "utf8")).toBe("/* user-owned native source */\n");
});

test("early dev cache restores the matching dSYM and rejects a missing payload", async () => {
  const f = await fixture();
  f.options.optimization = "dev";
  f.options.target = "native:darwin:arm64:runtime-pack";
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  await writeFile(f.options.outPath, "native binary");
  const symbols = Buffer.concat([
    Buffer.from("SCDSYM01"),
    Buffer.from([5, 0, 0, 0]),
    Buffer.from("plistDWARF"),
  ]);
  await installDarwinDebugSymbols(symbols, f.options.outPath);
  await publishEarlyExecutableCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    native: { ...native, optimization: "dev" },
    executableRestored: true,
    nativeDependencies: [],
    frontend: tracker.snapshot(),
  });
  await rm(`${f.options.outPath}.dSYM`, { recursive: true });
  expect((await readEarlyExecutableCache(f.root, f.options))?.executableRestored).toBe(true);
  expect(await readDarwinDebugSymbols(f.options.outPath)).toEqual(symbols);
  const files = await readdir(f.root, { recursive: true });
  const cachedSymbols = files.find((file) => file.endsWith("program.dsym"));
  expect(cachedSymbols).toBeDefined();
  await rm(join(f.root, cachedSymbols!));
  expect(await readEarlyExecutableCache(f.root, f.options)).toBeNull();
});

test("early executable cache replays every warning the build reported", async () => {
  const f = await fixture();
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  // Lowering runs on a cold build only; the entry carries the warnings so a
  // hit reports the same diagnostics (SC8001 is a Node island note, SC6101 a
  // performance warning, and neither may vanish behind a cache hit).
  const warnings: ScrDiagnostic[] = [
    {
      code: "SC8001",
      message: "module 'entry.ts' runs in a Node island: sloppy: undeclared write",
      loc: { file: f.source, start: 0, end: 1 },
      hint: "sloppy-mode code Node runs; --node-islands=off compiles this module natively instead",
    },
    {
      code: "SC6101",
      message: "likely-hot function 'add' uses untyped values",
      loc: { file: f.source, start: 4, end: 9 },
    },
  ];
  await publishEarlyExecutableCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    native,
    executableRestored: false,
    frontend: tracker.snapshot(),
    warnings,
  });
  expect((await readEarlyExecutableCache(f.root, f.options))?.warnings).toEqual(warnings);
});

test("early executable cache keeps the rewritten text its warnings were located in", async () => {
  const f = await fixture();
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  const warnings: ScrDiagnostic[] = [
    {
      code: "SC6101",
      message: "likely-hot function 'view' uses untyped values",
      loc: { file: f.source, start: 0, end: 4 },
    },
  ];
  // The frontend locates a rewritten JSX file's warnings in the rewritten
  // text, which no longer matches the file on disk: the entry keeps that text
  // so a hit frames the warning where the build did. A file the frontend did
  // not rewrite stays out of the entry and is re-read on a hit.
  const rewritten = 'const view = jsx("div");\n';
  await publishEarlyExecutableCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    native,
    executableRestored: false,
    frontend: tracker.snapshot(),
    warnings,
    warningTexts: new Map([
      [f.source, rewritten],
      [f.llvmPath, "; generated llvm\n"],
    ]),
  });
  const hit = await readEarlyExecutableCache(f.root, f.options);
  expect(hit?.warnings).toEqual(warnings);
  expect(hit?.warningSources).toEqual({ [f.source]: rewritten });
});

test("early executable cache preserves worker runtime selection when only frontend output restores", async () => {
  const f = await fixture();
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  await publishEarlyExecutableCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    native: { ...native, workers: true },
    executableRestored: false,
    frontend: tracker.snapshot(),
  });
  const restored = await readEarlyExecutableCache(f.root, f.options);
  expect(restored?.native.workers).toBe(true);
  expect(restored?.executableRestored).toBe(false);
});

test("early executable cache misses on source and resolution changes", async () => {
  const f = await fixture();
  const tracker = new FrontendInputTracker();
  tracker.run(() => {
    trackedReadFile(f.source);
    trackedFileExists(f.missing);
  });
  await publishEarlyExecutableCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    native,
    executableRestored: false,
    frontend: tracker.snapshot(),
  });

  await writeFile(f.source, 'console.log("edited");\n');
  expect(await readEarlyExecutableCache(f.root, f.options)).toBeNull();
  await writeFile(f.source, 'console.log("hello");\n');
  expect(await readEarlyExecutableCache(f.root, f.options)).not.toBeNull();
  await writeFile(f.missing, "export {};\n");
  expect(await readEarlyExecutableCache(f.root, f.options)).toBeNull();
});

test("early executable keys isolate compile modes, paths, implementation, checker, function layouts, shape inference, and FFI manifests", async () => {
  const f = await fixture();
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  await publishEarlyExecutableCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    native,
    executableRestored: false,
    frontend: tracker.snapshot(),
  });
  const variants: EarlyExecutableCacheOptions[] = [
    { ...f.options, emitIr: false },
    { ...f.options, sanitize: true },
    { ...f.options, optimization: "dev" },
    { ...f.options, optimization: "speed" },
    { ...f.options, detachedExit: true },
    { ...f.options, largePages: true },
    { ...f.options, targetCpu: "x86-64-v3" },
    { ...f.options, targetCpu: "x86-64-v4" },
    { ...f.options, cpuDispatch: true },
    { ...f.options, profile: "profile-generate:/tmp/%p.profraw" },
    { ...f.options, profile: "profile-use:digest" },
    { ...f.options, functionLayout: "layout-digest" },
    { ...f.options, checker: "tsc-ts-executable-identity" },
    { ...f.options, shapeOverlay: true },
    { ...f.options, jsInference: true },
    { ...f.options, jsIcWays: 0 },
    { ...f.options, jsIcWays: 1 },
    { ...f.options, jsIcWays: 2 },
    { ...f.options, npmStatic: "auto" },
    { ...f.options, npmStatic: ["commander"] },
    { ...f.options, outPath: join(f.options.outDir, "other") },
    { ...f.options, target: "other" },
    { ...f.options, compiler: ["zig", "cc"] },
    { ...f.options, nativeEnvironment: "other-native-environment" },
    { ...f.options, nodeVersion: "v24-other" },
    { ...f.options, implementation: "other-implementation" },
    {
      ...f.options,
      ffiProfile: { path: join(f.options.outDir, "ffi.json"), bytes: Buffer.from("one") },
    },
  ];
  for (const options of variants) {
    expect(await readEarlyExecutableCache(f.root, options)).toBeNull();
  }
});

test("an attribution build's inline cache way count is part of the build key", async () => {
  const f = await fixture();
  const nativeDependency = join(f.options.outDir, "native-tool");
  await Promise.all([
    writeFile(f.options.outPath, "native-v1\n"),
    writeFile(nativeDependency, "tool-v1\n"),
  ]);
  const nativeInfo = await stat(nativeDependency);
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  const publish = (options: EarlyExecutableCacheOptions) =>
    publishEarlyExecutableCache(f.root, options, {
      llvmPath: f.llvmPath,
      irPath: f.irPath,
      native,
      executableRestored: true,
      nativeDependencies: [
        {
          path: nativeDependency,
          kind: "file",
          dev: nativeInfo.dev,
          ino: nativeInfo.ino,
          size: nativeInfo.size,
          mtimeMs: nativeInfo.mtimeMs,
          ctimeMs: nativeInfo.ctimeMs,
        },
      ],
      frontend: tracker.snapshot(),
    });
  const route = (options: EarlyExecutableCacheOptions) => {
    const plain = { ...options };
    delete (plain as Partial<EarlyExecutableCacheOptions>).implementation;
    delete (plain as Partial<EarlyExecutableCacheOptions>).implementationDependencies;
    return plain;
  };
  await publish(f.options);
  expect(await readEarlyExecutableCache(f.root, f.options)).not.toBeNull();
  expect(await readEarlyExecutableCache(f.root, { ...f.options, jsIcWays: 0 })).toBeNull();
  expect(await readEarlyExecutableCache(f.root, { ...f.options, jsIcWays: 1 })).toBeNull();
  expect(await readRoutedExecutableCache(f.root, route(f.options))).not.toBeNull();
  expect(await readRoutedExecutableCache(f.root, route({ ...f.options, jsIcWays: 0 }))).toBeNull();
  // The attribution build is a separate entry, and it stays one.
  await publish({ ...f.options, jsIcWays: 0 });
  expect(await readEarlyExecutableCache(f.root, { ...f.options, jsIcWays: 0 })).not.toBeNull();
});

test("speed entries round-trip their posture and stay isolated from release and dev", async () => {
  const f = await fixture();
  const speedOptions: EarlyExecutableCacheOptions = { ...f.options, optimization: "speed" };
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  await publishEarlyExecutableCache(f.root, speedOptions, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    native: { ...native, optimization: "speed" },
    executableRestored: false,
    frontend: tracker.snapshot(),
  });
  expect((await readEarlyExecutableCache(f.root, speedOptions))?.native).toEqual({
    ...native,
    optimization: "speed",
  });
  expect(await readEarlyExecutableCache(f.root, f.options)).toBeNull();
  expect(await readEarlyExecutableCache(f.root, { ...f.options, optimization: "dev" })).toBeNull();
});

test("early executable cache rejects corruption and refreshes payload LRU times", async () => {
  const f = await fixture();
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  await publishEarlyExecutableCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    native,
    executableRestored: false,
    frontend: tracker.snapshot(),
  });
  const [key] = await readdir(join(f.root, "early-exe"));
  const directory = join(f.root, "early-exe", key!);
  const paths = [
    join(directory, "stamp.json"),
    join(directory, "program.tu"),
    join(directory, "program.ir.json"),
  ];
  const old = new Date("2000-01-01T00:00:00.000Z");
  await Promise.all(paths.map((path) => utimes(path, old, old)));
  expect(await readEarlyExecutableCache(f.root, f.options)).not.toBeNull();
  for (const path of paths) expect((await stat(path)).mtimeMs).toBeGreaterThan(old.getTime());

  await writeFile(join(directory, "program.tu"), "; poisoned\n");
  expect(await readEarlyExecutableCache(f.root, f.options)).toBeNull();
});

test("an entry whose feature record misspells a key every record carries is a miss", async () => {
  // The record spells each required link feature and mutableBuffers as a
  // boolean. A stamp without one of them, or with another type there, was
  // not written by this compiler, whatever its digest says.
  const without = (key: string): unknown =>
    Object.fromEntries(Object.entries(native).filter(([name]) => name !== key));
  const records: [unknown, boolean][] = [
    [native, true],
    [without("fetch"), false],
    [without("perfLoop"), false],
    [without("mutableBuffers"), false],
    [{ ...native, webcrypto: "yes" }, false],
  ];
  for (const [record, hit] of records) {
    const f = await fixture();
    const tracker = new FrontendInputTracker();
    tracker.run(() => trackedReadFile(f.source));
    await publishEarlyExecutableCache(f.root, f.options, {
      llvmPath: f.llvmPath,
      irPath: f.irPath,
      native: record as EarlyExecutableNativeFeatures,
      executableRestored: false,
      frontend: tracker.snapshot(),
    });
    expect(
      (await readEarlyExecutableCache(f.root, f.options)) !== null,
      JSON.stringify(record),
    ).toBe(hit);
  }
});

test("early executable cache restores a validated final binary", async () => {
  const f = await fixture();
  const dependency = join(f.options.outDir, "native-tool");
  await writeFile(dependency, "tool-v1\n");
  const info = await stat(dependency);
  const outMode = 0o777 & ~process.umask();
  await writeFile(f.options.outPath, "native-v1\n", { mode: outMode });
  await chmod(f.options.outPath, outMode);
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  await publishEarlyExecutableCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    native,
    executableRestored: true,
    nativeDependencies: [
      {
        path: dependency,
        kind: "file",
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
      },
    ],
    frontend: tracker.snapshot(),
  });
  await writeFile(f.options.outPath, "caller-modified\n");

  const hit = await readEarlyExecutableCache(f.root, f.options);
  expect(hit?.executableRestored).toBe(true);
  expect(await readFile(f.options.outPath, "utf8")).toBe("native-v1\n");

  await writeFile(dependency, "tool-v2\n");
  await writeFile(f.options.outPath, "keep-current\n");
  const staleNative = await readEarlyExecutableCache(f.root, f.options);
  expect(staleNative?.executableRestored).toBe(false);
  expect(await readFile(f.options.outPath, "utf8")).toBe("keep-current\n");
});

test("a divided module's executable cache entry depends on the host's threads", async () => {
  const f = await fixture();
  f.options.emitIr = false;
  // 8 MiB of LLVM text: two partitions per thread of an 8-thread host (16),
  // eight for a host of two or four threads.
  await writeFile(f.llvmPath, `;${"x".repeat(8 * 1024 * 1024)}\n`);
  await writeFile(f.options.outPath, "native binary");
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  hostThreads.count = 8;
  await publishEarlyExecutableCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    native,
    executableRestored: true,
    nativeDependencies: [],
    frontend: tracker.snapshot(),
    partitions: 16,
  });
  expect((await readEarlyExecutableCache(f.root, f.options))?.executableRestored).toBe(true);
  hostThreads.count = 2;
  expect(await readEarlyExecutableCache(f.root, f.options)).toBeNull();
  hostThreads.count = 8;
  expect((await readEarlyExecutableCache(f.root, f.options))?.executableRestored).toBe(true);
});

test("an undivided module's executable cache entry ignores the host's threads", async () => {
  const f = await fixture();
  await writeFile(f.options.outPath, "native binary");
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  hostThreads.count = 8;
  await publishEarlyExecutableCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    native,
    executableRestored: true,
    nativeDependencies: [],
    frontend: tracker.snapshot(),
  });
  hostThreads.count = 1;
  expect((await readEarlyExecutableCache(f.root, f.options))?.executableRestored).toBe(true);
  hostThreads.count = 8;
});

test("a module small enough to stay whole records one partition and hits on every host", async () => {
  const f = await fixture();
  // What a runtime-pack build records for a module whose text stays one
  // partition: the helper compiled a single partition, not a divided module.
  const bytes = (await readFile(f.llvmPath)).length;
  expect(nativeProgramPartitions(bytes, false)).toBe(1);
  await writeFile(f.options.outPath, "native binary");
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  hostThreads.count = 8;
  await publishEarlyExecutableCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    native,
    executableRestored: true,
    nativeDependencies: [],
    frontend: tracker.snapshot(),
    partitions: 1,
  });
  for (const threads of [1, 4, 8]) {
    hostThreads.count = threads;
    expect((await readEarlyExecutableCache(f.root, f.options))?.executableRestored).toBe(true);
  }
  hostThreads.count = 8;
});

test("routed executable hits require an unchanged compiler implementation proof", async () => {
  const f = await fixture();
  const dependency = join(f.options.outDir, "compiler-file.js");
  const nativeDependency = join(f.options.outDir, "native-tool");
  await Promise.all([
    writeFile(dependency, "compiler-v1\n"),
    writeFile(nativeDependency, "tool-v1\n"),
    writeFile(f.options.outPath, "native-v1\n"),
  ]);
  const [implementationInfo, nativeInfo] = await Promise.all([
    stat(dependency),
    stat(nativeDependency),
  ]);
  f.options.implementationDependencies = [
    {
      path: dependency,
      kind: "file",
      dev: implementationInfo.dev,
      ino: implementationInfo.ino,
      size: implementationInfo.size,
      mtimeMs: implementationInfo.mtimeMs,
      ctimeMs: implementationInfo.ctimeMs,
    },
  ];
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  await publishEarlyExecutableCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    native,
    executableRestored: true,
    nativeDependencies: [
      {
        path: nativeDependency,
        kind: "file",
        dev: nativeInfo.dev,
        ino: nativeInfo.ino,
        size: nativeInfo.size,
        mtimeMs: nativeInfo.mtimeMs,
        ctimeMs: nativeInfo.ctimeMs,
      },
    ],
    frontend: tracker.snapshot(),
  });
  const route = { ...f.options };
  delete (route as Partial<EarlyExecutableCacheOptions>).implementation;
  delete (route as Partial<EarlyExecutableCacheOptions>).implementationDependencies;
  const routeDirectory = join(f.root, "early-exe-route");
  const [routeName] = await readdir(routeDirectory);
  const routePath = join(routeDirectory, routeName!);
  const proofInstallDirectory = join(f.root, "early-exe-implementation");
  const [proofInstall] = await readdir(proofInstallDirectory);
  const proofPath = join(proofInstallDirectory, proofInstall!, f.options.implementation);
  const old = new Date("2000-01-01T00:00:00.000Z");
  await Promise.all([routePath, proofPath].map((path) => utimes(path, old, old)));
  expect(await readRoutedExecutableCache(f.root, route)).not.toBeNull();
  for (const path of [routePath, proofPath]) {
    expect((await stat(path)).mtimeMs).toBeGreaterThan(old.getTime());
  }

  // Publishing the same route again must replace its metadata on every
  // platform (notably Windows, whose rename does not overwrite files).
  await publishEarlyExecutableCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    native,
    executableRestored: true,
    nativeDependencies: [
      {
        path: nativeDependency,
        kind: "file",
        dev: nativeInfo.dev,
        ino: nativeInfo.ino,
        size: nativeInfo.size,
        mtimeMs: nativeInfo.mtimeMs,
        ctimeMs: nativeInfo.ctimeMs,
      },
    ],
    frontend: tracker.snapshot(),
  });
  expect(await readRoutedExecutableCache(f.root, route)).not.toBeNull();
  await writeFile(dependency, "compiler-v2\n");
  expect(await readRoutedExecutableCache(f.root, route)).toBeNull();
});

test("native dependency validation rejects malformed cache data", async () => {
  expect(
    await nativeArtifactDependenciesStillMatch([
      { path: "/tmp/not-enough-fields", kind: "file" },
    ] as never),
  ).toBe(false);
});

async function routedFixture(executableRestored = true) {
  const f = await fixture();
  const implementation = join(f.options.outDir, "compiler-file.js");
  const nativeDependency = join(f.options.outDir, "native-tool");
  const declarations = join(f.options.outDir, "dependency.d.ts");
  await Promise.all([
    writeFile(implementation, "compiler-v1\n"),
    writeFile(nativeDependency, "native-v1\n"),
    writeFile(declarations, "export const value: number;\n"),
    writeFile(f.options.outPath, "cached executable\n"),
  ]);
  const info = await stat(implementation);
  f.options.implementationDependencies = [
    {
      path: implementation,
      kind: "file",
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
    },
  ];
  const tracker = new FrontendInputTracker();
  tracker.run(() => {
    trackedReadFile(f.source);
    trackedReadFile(declarations);
    trackedFileExists(f.missing);
  });
  await publishEarlyExecutableCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    native,
    executableRestored,
    ...(executableRestored
      ? { nativeDependencies: await snapshotNativeArtifactDependencies([nativeDependency]) }
      : {}),
    frontend: tracker.snapshot(),
  });
  await Promise.all([
    writeFile(f.options.outPath, "current executable\n"),
    writeFile(f.llvmPath, "; current LLVM\n"),
    writeFile(f.irPath, "current IR\n"),
  ]);
  return { ...f, implementation, nativeDependency, declarations };
}

test("missing and disabled routes skip deferred native driver discovery", async () => {
  const f = await fixture();
  const discover = vi.fn(async () => f.options.nativeEnvironment);
  expect(
    await readRoutedExecutableCache(null, { ...f.options, nativeEnvironment: discover }),
  ).toBeNull();
  expect(
    await readRoutedExecutableCache(f.root, { ...f.options, nativeEnvironment: discover }),
  ).toBeNull();
  expect(discover).not.toHaveBeenCalled();
});

test.each(["source", "payload", "frontend-only"])(
  "%s misses skip deferred driver discovery and preserve caller outputs",
  async (miss) => {
    const f = await routedFixture(miss !== "frontend-only");
    if (miss === "source") await writeFile(f.source, 'console.log("edited");\n');
    if (miss === "payload") {
      const [key] = await readdir(join(f.root, "early-exe"));
      await writeFile(join(f.root, "early-exe", key!, "program.bin"), "corrupt executable\n");
    }
    const discover = vi.fn(async () => f.options.nativeEnvironment);
    expect(
      await readRoutedExecutableCache(f.root, { ...f.options, nativeEnvironment: discover }),
    ).toBeNull();
    expect(discover).not.toHaveBeenCalled();
    expect(await readFile(f.options.outPath, "utf8")).toBe("current executable\n");
    expect(await readFile(f.llvmPath, "utf8")).toBe("; current LLVM\n");
    expect(await readFile(f.irPath, "utf8")).toBe("current IR\n");
  },
);

test("a deferred driver fingerprint is checked once before restoring a routed hit", async () => {
  const f = await routedFixture();
  const discover = vi.fn(async () => f.options.nativeEnvironment);
  expect(
    (await readRoutedExecutableCache(f.root, { ...f.options, nativeEnvironment: discover }))
      ?.executableRestored,
  ).toBe(true);
  expect(discover).toHaveBeenCalledTimes(1);
  expect(await readFile(f.options.outPath, "utf8")).toBe("cached executable\n");
  expect(await readFile(f.llvmPath, "utf8")).toBe("; generated llvm\n");
  expect(await readFile(f.irPath, "utf8")).toContain("irVersion");
});

test.each(["environment", "failure", "source", "declarations", "implementation", "native"])(
  "%s changes during deferred discovery refuse restoration",
  async (change) => {
    const f = await routedFixture();
    const discover = vi.fn(async () => {
      if (change === "failure") throw new Error("driver discovery failed");
      if (change === "source") await writeFile(f.source, 'console.log("edited");\n');
      if (change === "declarations")
        await writeFile(f.declarations, "export const value: string;\n");
      if (change === "implementation") await writeFile(f.implementation, "compiler-v2\n");
      if (change === "native") await writeFile(f.nativeDependency, "native-v2\n");
      return change === "environment" ? "another driver" : f.options.nativeEnvironment;
    });
    expect(
      await readRoutedExecutableCache(f.root, { ...f.options, nativeEnvironment: discover }),
    ).toBeNull();
    expect(discover).toHaveBeenCalledTimes(1);
    expect(await readFile(f.options.outPath, "utf8")).toBe("current executable\n");
    expect(await readFile(f.llvmPath, "utf8")).toBe("; current LLVM\n");
    expect(await readFile(f.irPath, "utf8")).toBe("current IR\n");
  },
);

test.each(["implementation", "native", "declarations", "resolution"])(
  "a stale %s proof refuses a deferred routed hit",
  async (change) => {
    const f = await routedFixture();
    const path = {
      implementation: f.implementation,
      native: f.nativeDependency,
      declarations: f.declarations,
      resolution: f.missing,
    }[change]!;
    await writeFile(path, "changed before discovery\n");
    expect(
      await readRoutedExecutableCache(f.root, {
        ...f.options,
        nativeEnvironment: async () => f.options.nativeEnvironment,
      }),
    ).toBeNull();
    expect(await readFile(f.options.outPath, "utf8")).toBe("current executable\n");
    expect(await readFile(f.llvmPath, "utf8")).toBe("; current LLVM\n");
    expect(await readFile(f.irPath, "utf8")).toBe("current IR\n");
  },
);

test("the route index still isolates eager and deferred native environments", async () => {
  const f = await routedFixture();
  expect(
    await readRoutedExecutableCache(f.root, { ...f.options, nativeEnvironment: "another driver" }),
  ).toBeNull();
  await publishEarlyExecutableCache(
    f.root,
    { ...f.options, nativeEnvironment: "another driver" },
    {
      llvmPath: f.llvmPath,
      irPath: f.irPath,
      native,
      executableRestored: true,
      nativeDependencies: await snapshotNativeArtifactDependencies([f.nativeDependency]),
      frontend: (await readEarlyExecutableCache(f.root, f.options))!.frontend,
    },
  );
  expect(await readRoutedExecutableCache(f.root, f.options)).toBeNull();
  expect(
    await readRoutedExecutableCache(f.root, {
      ...f.options,
      nativeEnvironment: async () => f.options.nativeEnvironment,
    }),
  ).toBeNull();
  expect(
    (
      await readRoutedExecutableCache(f.root, {
        ...f.options,
        nativeEnvironment: async () => "another driver",
      })
    )?.executableRestored,
  ).toBe(true);
});

test("a recorded native build is found by its invocation", async () => {
  const f = await fixture();
  expect(await hasEarlyExecutableNativeBuild(null, f.options)).toBe(false);
  expect(await hasEarlyExecutableNativeBuild(f.root, f.options)).toBe(false);
  await recordEarlyExecutableNativeBuild(null, f.options);
  await recordEarlyExecutableNativeBuild(f.root, f.options);
  expect(await hasEarlyExecutableNativeBuild(f.root, f.options)).toBe(true);
  // The record does not depend on the compiler implementation or the native environment.
  const rebuilt: EarlyExecutableCacheOptions = {
    ...f.options,
    implementation: "b".repeat(64),
    nativeEnvironment: "another driver",
  };
  expect(await hasEarlyExecutableNativeBuild(f.root, rebuilt)).toBe(true);
  expect(
    await hasEarlyExecutableNativeBuild(f.root, {
      ...f.options,
      outPath: join(f.options.outDir, "other"),
    }),
  ).toBe(false);
  expect(await hasEarlyExecutableNativeBuild(f.root, { ...f.options, sanitize: true })).toBe(false);
  // Publishing an executable does not record a native build.
  const other = { ...f.options, outPath: join(f.options.outDir, "published") };
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  await publishEarlyExecutableCache(f.root, other, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    native,
    executableRestored: false,
    frontend: tracker.snapshot(),
  });
  expect(await hasEarlyExecutableNativeBuild(f.root, other)).toBe(false);
});

/* What the keys cover. Every option `scriptc build` and `scriptc run` take
 * can change what the build produces or whether it succeeds, so each one
 * either changes both cache keys or is listed with the reason an entry
 * built without it still answers a build with it. A new option fails this
 * test until it is given one or the other. */
type KeyRule =
  /** The option reaches the key through this change of the cache options. */
  | { keyed: (options: EarlyExecutableCacheOptions) => EarlyExecutableCacheOptions }
  /** Why the key need not hold the option. */
  | { unkeyed: string };

const OPTION_KEY_RULES: Record<string, KeyRule> = {
  out: { keyed: (o) => ({ ...o, outPath: `${o.outPath}-elsewhere` }) },
  emit: {
    unkeyed:
      "only executables are cached: a build of another kind neither reads nor writes an entry (compileTracked's cacheRoot)",
  },
  print: {
    unkeyed:
      "--print selects what the command prints (diagnostics as JSON, or the link info of an object build, which is not cached); the build is the same",
  },
  backend: {
    unkeyed: "llvm is the only backend, and the key holds its name: another value is refused",
  },
  optimization: { keyed: (o) => ({ ...o, optimization: "dev" }) },
  strip: { keyed: (o) => ({ ...o, strip: true }) },
  static: { keyed: (o) => ({ ...o, staticLink: true }) },
  "windows-subsystem": { keyed: (o) => ({ ...o, windowsSubsystem: "gui" }) },
  "detached-exit": { keyed: (o) => ({ ...o, detachedExit: true }) },
  "stdout-buffering": { keyed: (o) => ({ ...o, stdoutBuffering: true }) },
  libnode: {
    unkeyed:
      "an entry of a program that calls into Node records the pack's identity, and a hit requires it unchanged (libnodeIdentity); other programs do not depend on it",
  },
  "large-pages": { keyed: (o) => ({ ...o, largePages: true }) },
  exceptions: { keyed: (o) => ({ ...o, exceptions: "rare" }) },
  "target-cpu": { keyed: (o) => ({ ...o, targetCpu: "x86-64-v3" }) },
  "cpu-dispatch": { keyed: (o) => ({ ...o, cpuDispatch: true }) },
  "profile-generate": { keyed: (o) => ({ ...o, profile: "generate:/tmp/profile-%p" }) },
  "profile-use": { keyed: (o) => ({ ...o, profile: "use:0123abcd" }) },
  "keep-llvm": {
    unkeyed:
      "the command removes the kept LLVM text after the build, cached or not; the build is the same",
  },
  "emit-ir": { keyed: (o) => ({ ...o, emitIr: !o.emitIr }) },
  sanitize: { keyed: (o) => ({ ...o, sanitize: !o.sanitize }) },
  ffi: {
    keyed: (o) => ({
      ...o,
      ffiProfile: { path: join(o.outDir, "ffi.json"), bytes: new Uint8Array([1]) },
    }),
  },
  "npm-static": { keyed: (o) => ({ ...o, npmStatic: ["a-package"] }) },
  "shape-overlay": { keyed: (o) => ({ ...o, shapeOverlay: true }) },
  "provenance-sources": {
    unkeyed: "a build that rewrites its sources for provenance uses no cache (cacheRoot is null)",
  },
  "emit-lowered": {
    unkeyed:
      "a build that writes a lowered program reads no entry (usesLoweredProgram), so it always runs the frontend and writes the file, and it builds the executable the same build without the option builds",
  },
  "from-lowered": {
    unkeyed:
      "a build from a lowered program reads no entry (usesLoweredProgram) and marks its frontend inputs unstable, so it publishes none (fromLoweredProgram)",
  },
  "from-lowered-accept": {
    unkeyed:
      "the option is refused without --from-lowered, whose builds neither read nor write an entry",
  },
  tier: { keyed: (o) => ({ ...o, tier: "static-only" }) },
  "dynamic-tier-warning": {
    unkeyed:
      "the command leaves SC6101 out when it prints; the build, and the warnings its entry stores, are the same",
  },
  "copy-warning": {
    unkeyed:
      "the command leaves SC6001 out when it prints; the build, and the warnings its entry stores, are the same",
  },
  "key-order-warning": {
    unkeyed:
      "the command leaves SC6014 out when it prints; the build, and the warnings its entry stores, are the same",
  },
  "node-islands": { keyed: (o) => ({ ...o, nodeIslands: "auto" }) },
  "node-island": { keyed: (o) => ({ ...o, nodeIslands: "node:a-package" }) },
  native: { keyed: (o) => ({ ...o, nodeIslands: "native:a-package" }) },
  node: { keyed: (o) => ({ ...o, nodeIslands: "node:another-package" }) },
  define: {
    keyed: (o) => ({ ...o, define: JSON.stringify({ "process.env.NODE_ENV": '"production"' }) }),
  },
};

test("every build and run option is in the cache keys or says why it need not be", async () => {
  const f = await fixture();
  const taken = new Set<string>(
    CLI_COMMANDS.filter((command) => command.name === "build" || command.name === "run").flatMap(
      (command) => [...command.options],
    ),
  );
  expect(taken.size).toBeGreaterThan(20);
  for (const option of taken) expect(Object.keys(CLI_OPTIONS)).toContain(option);
  const unruled = [...taken].filter((option) => OPTION_KEY_RULES[option] === undefined);
  expect(
    unruled,
    "options without a rule: add each to OPTION_KEY_RULES, keyed (and to cacheKey and routeKey) or unkeyed with the reason",
  ).toEqual([]);
  // A rule for an option the commands no longer take is stale.
  expect(Object.keys(OPTION_KEY_RULES).filter((option) => !taken.has(option))).toEqual([]);
  const base = earlyExecutableCacheKeys(f.options);
  const keys = new Map<string, string>();
  for (const [option, rule] of Object.entries(OPTION_KEY_RULES)) {
    if ("unkeyed" in rule) {
      expect(rule.unkeyed.length, option).toBeGreaterThan(20);
      continue;
    }
    const changed = earlyExecutableCacheKeys(rule.keyed(f.options));
    expect(changed.entry, `--${option} must change the entry key`).not.toBe(base.entry);
    expect(changed.route, `--${option} must change the route key`).not.toBe(base.route);
    keys.set(option, changed.entry);
  }
  // The tier's own key: `static-only` refuses programs `auto` compiles.
  expect(keys.get("tier")).not.toBe(keys.get("strip"));
  expect(earlyExecutableCacheKeys({ ...f.options }).entry).toBe(base.entry);
});
