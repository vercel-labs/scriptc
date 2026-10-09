import { chmod, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  FrontendInputTracker,
  trackedFileExists,
  trackedReadFile,
} from "../frontend/input-tracker.js";
import {
  nativeArtifactDependenciesStillMatch,
  snapshotNativeArtifactDependencies,
} from "../backend/native-toolchain.js";
import { installDarwinDebugSymbols, readDarwinDebugSymbols } from "../backend/debug-symbols.js";
import {
  publishEarlyExecutableCache,
  readEarlyExecutableCache,
  readRoutedExecutableCache,
  type EarlyExecutableCacheOptions,
  type EarlyExecutableNativeFeatures,
} from "./executable-cache.js";

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const native: EarlyExecutableNativeFeatures = {
  backend: "llvm",
  dynamic: false,
  regex: false,
  copying: false,
  textDecoderLegacy: false,
  fileHandle: false,
  fetch: true,
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
      dynamic: false,
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
  expect(await readFile(f.llvmPath, "utf8")).toBe("; generated llvm\n");
  expect(await readFile(f.irPath, "utf8")).toContain("irVersion");
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

test("early executable keys isolate compile modes, paths, implementation, and FFI manifests", async () => {
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
    { ...f.options, dynamic: true },
    { ...f.options, optimization: "dev" },
    { ...f.options, optimization: "speed" },
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
