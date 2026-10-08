import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { IrModule } from "../ir/ir.js";
import {
  FrontendInputTracker,
  trackedAccessibleEntries,
  trackedDirectoryExists,
  trackedFileExists,
  trackedReadFile,
} from "../frontend/input-tracker.js";
import {
  publishEarlyLibraryCache,
  readEarlyLibraryCache,
  readSemanticLibraryCache,
  type EarlyLibraryCacheOptions,
} from "./library-cache.js";

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  options: EarlyLibraryCacheOptions;
  source: string;
  missing: string;
  llvmPath: string;
  irPath: string;
  sidecarPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-early-cache-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  const profilePath = join(dir, "profile.json");
  const llvmPath = join(dir, "entry.lib.ll");
  const irPath = join(dir, "entry.lib.ir.json");
  const sidecarPath = join(dir, "entry.lib.a.contract.json");
  await Promise.all([
    writeFile(source, "export function value(): number { return 1; }\n"),
    writeFile(profilePath, "{}\n"),
    writeFile(llvmPath, "; generated llvm\n"),
    writeFile(irPath, '{"irVersion":6}\n'),
    writeFile(sidecarPath, '{"contract":true}\n'),
  ]);
  return {
    root: join(dir, "cache"),
    source,
    missing: join(dir, "missing.ts"),
    llvmPath,
    irPath,
    sidecarPath,
    options: {
      profilePath,
      profileBytes: new TextEncoder().encode("{}\n"),
      entryPath: source,
      outDir: dir,
      emitIr: true,
      sanitize: false,
      target: "test",
      compiler: ["clang"],
      nodeVersion: "v24-test",
      implementation: "test-implementation",
    },
  };
}

test("early library cache restores generated artifacts and metadata", async () => {
  const f = await fixture();
  const tracker = new FrontendInputTracker();
  tracker.run(() => {
    trackedReadFile(f.source);
    trackedFileExists(f.missing);
  });
  const native = {
    backend: "llvm" as const,
    regex: false,
    assert: true,
    inspect: false,
    symbol: false,
    bigint: false,
    searchParams: false,
    emitter: false,
    zlib: false,
    copying: false,
    textDecoderLegacy: false,
    dynInvoke: false,
  };
  await publishEarlyLibraryCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    sidecarPath: f.sidecarPath,
    native,
    frontend: tracker.snapshot(),
  });
  await Promise.all([rm(f.llvmPath), rm(f.irPath), rm(f.sidecarPath)]);
  const alternateCPath = join(f.options.outDir, "entry.lib.c");
  await writeFile(alternateCPath, "/* saved c backend */\n");

  const hit = await readEarlyLibraryCache(f.root, f.options, null);
  expect(hit).not.toBeNull();
  expect(hit?.native).toEqual(native);
  expect(await readFile(f.llvmPath, "utf8")).toBe("; generated llvm\n");
  expect(await readFile(f.irPath, "utf8")).toContain("irVersion");
  expect(await readFile(f.sidecarPath, "utf8")).toContain("contract");
  expect(await readFile(alternateCPath, "utf8")).toBe("/* saved c backend */\n");
});

test("early library cache publishes after creating a fresh output directory", async () => {
  const f = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "scriptc-early-cache-root-"));
  scratch.push(cacheRoot);
  const outDir = join(f.options.outDir, "fresh-out");
  const llvmPath = join(outDir, "entry.lib.ll");
  const options = { ...f.options, outDir, emitIr: false };
  const tracker = new FrontendInputTracker();
  tracker.run(() => {
    trackedAccessibleEntries(f.options.outDir);
    trackedDirectoryExists(outDir);
    trackedAccessibleEntries(outDir);
    trackedReadFile(f.source);
  });

  await mkdir(outDir);
  await writeFile(llvmPath, "; generated llvm in fresh output\n");
  await publishEarlyLibraryCache(cacheRoot, options, {
    llvmPath,
    native: {
      backend: "llvm",
      regex: false,
      assert: false,
      inspect: false,
      symbol: false,
      bigint: false,
      searchParams: false,
      emitter: false,
      zlib: false,
      copying: false,
      textDecoderLegacy: false,
      dynInvoke: false,
    },
    frontend: tracker.snapshot(),
  });

  await rm(llvmPath);
  expect((await readEarlyLibraryCache(cacheRoot, options, undefined))?.llvmPath).toBe(llvmPath);
  expect(await readFile(llvmPath, "utf8")).toContain("fresh output");
});

test("early library cache hits refresh every payload's LRU time", async () => {
  const f = await fixture();
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  await publishEarlyLibraryCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    sidecarPath: f.sidecarPath,
    native: {
      backend: "llvm",
      regex: false,
      assert: false,
      inspect: false,
      symbol: false,
      bigint: false,
      searchParams: false,
      emitter: false,
      zlib: false,
      copying: false,
      textDecoderLegacy: false,
      dynInvoke: false,
    },
    frontend: tracker.snapshot(),
  });
  const earlyRoot = join(f.root, "early-lib");
  const [key] = await readdir(earlyRoot);
  const entry = join(earlyRoot, key!);
  const cachePaths = [
    join(entry, "stamp.json"),
    join(entry, "program.tu"),
    join(entry, "program.ir.json"),
    join(entry, "contract.json"),
  ];
  const old = new Date("2000-01-01T00:00:00.000Z");
  await Promise.all(cachePaths.map((path) => utimes(path, old, old)));

  expect(await readEarlyLibraryCache(f.root, f.options, null)).not.toBeNull();
  for (const path of cachePaths) {
    expect((await stat(path)).mtimeMs).toBeGreaterThan(old.getTime());
  }
});

test("early library cache misses on source edits and newly-resolved candidates", async () => {
  const f = await fixture();
  const tracker = new FrontendInputTracker();
  tracker.run(() => {
    trackedReadFile(f.source);
    trackedFileExists(f.missing);
  });
  await publishEarlyLibraryCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    sidecarPath: f.sidecarPath,
    native: {
      backend: "llvm",
      regex: false,
      assert: false,
      inspect: false,
      symbol: false,
      bigint: false,
      searchParams: false,
      emitter: false,
      zlib: false,
      copying: false,
      textDecoderLegacy: false,
      dynInvoke: false,
    },
    frontend: tracker.snapshot(),
  });

  await writeFile(f.source, "export function value(): number { return 2; }\n");
  expect(await readEarlyLibraryCache(f.root, f.options, null)).toBeNull();
  await writeFile(f.llvmPath, "; generated llvm v2\n");
  const editedTracker = new FrontendInputTracker();
  editedTracker.run(() => {
    trackedReadFile(f.source);
    trackedFileExists(f.missing);
  });
  await publishEarlyLibraryCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    sidecarPath: f.sidecarPath,
    native: {
      backend: "llvm",
      regex: false,
      assert: false,
      inspect: false,
      symbol: false,
      bigint: false,
      searchParams: false,
      emitter: false,
      zlib: false,
      copying: false,
      textDecoderLegacy: false,
      dynInvoke: false,
    },
    frontend: editedTracker.snapshot(),
  });
  expect((await readEarlyLibraryCache(f.root, f.options, null))?.llvmPath).toBe(f.llvmPath);
  expect(await readFile(f.llvmPath, "utf8")).toBe("; generated llvm v2\n");

  await writeFile(f.source, "export function value(): number { return 1; }\n");
  await writeFile(f.missing, "export const appeared = true;\n");
  expect(await readEarlyLibraryCache(f.root, f.options, null)).toBeNull();
});

test("semantic library cache restores and rebases IR after a comment-only edit", async () => {
  const f = await fixture();
  const sourceBefore = await readFile(f.source, "utf8");
  const returnStart = sourceBefore.indexOf("return");
  const semanticMod = {
    irVersion: 15,
    sourceFile: f.source,
    functions: [
      {
        name: "__main",
        params: [],
        returnType: { kind: "void" },
        locals: [],
        body: [],
        loc: { file: f.source, start: returnStart, end: returnStart + 6 },
      },
    ],
    entry: "__main",
  } satisfies IrModule;
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  await publishEarlyLibraryCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    sidecarPath: f.sidecarPath,
    native: {
      backend: "llvm",
      regex: false,
      assert: false,
      inspect: false,
      symbol: false,
      bigint: false,
      searchParams: false,
      emitter: false,
      zlib: false,
      copying: false,
      textDecoderLegacy: false,
      dynInvoke: false,
    },
    frontend: tracker.snapshot(),
    semantic: { mod: semanticMod, sources: new Map([[f.source, sourceBefore]]) },
  });

  const sourceAfter = `// inserted comment\n${sourceBefore}`;
  await writeFile(f.source, sourceAfter);
  expect(await readEarlyLibraryCache(f.root, f.options, null)).toBeNull();
  const hit = await readSemanticLibraryCache(f.root, f.options, null);
  expect(hit).not.toBeNull();
  expect(hit?.changedSources).toEqual([f.source]);
  expect(hit?.translationUnit).toBe("; generated llvm\n");
  expect(hit?.mod.functions[0]!.loc.start).toBe(sourceAfter.indexOf("return"));
  expect(hit?.frontend.probes).toContainEqual(
    expect.objectContaining({
      op: "file",
      path: f.source,
    }),
  );

  const earlyRoot = join(f.root, "early-lib");
  const [key] = await readdir(earlyRoot);
  await writeFile(join(earlyRoot, key!, "program.tu"), "corrupt\n");
  expect(await readSemanticLibraryCache(f.root, f.options, null)).toBeNull();
});

test("semantic library cache refuses token and directive edits", async () => {
  const f = await fixture();
  const sourceBefore = await readFile(f.source, "utf8");
  const semanticMod = {
    irVersion: 15,
    sourceFile: f.source,
    functions: [
      {
        name: "__main",
        params: [],
        returnType: { kind: "void" },
        locals: [],
        body: [],
        loc: { file: f.source, start: 0, end: sourceBefore.length },
      },
    ],
    entry: "__main",
  } satisfies IrModule;
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  await publishEarlyLibraryCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    sidecarPath: f.sidecarPath,
    native: {
      backend: "llvm",
      regex: false,
      assert: false,
      inspect: false,
      symbol: false,
      bigint: false,
      searchParams: false,
      emitter: false,
      zlib: false,
      copying: false,
      textDecoderLegacy: false,
      dynInvoke: false,
    },
    frontend: tracker.snapshot(),
    semantic: { mod: semanticMod, sources: new Map([[f.source, sourceBefore]]) },
  });

  await writeFile(f.source, sourceBefore.replace("return 1", "return 2"));
  expect(await readSemanticLibraryCache(f.root, f.options, null)).toBeNull();
  await writeFile(f.source, `// @ts-expect-error\n${sourceBefore}`);
  expect(await readSemanticLibraryCache(f.root, f.options, null)).toBeNull();
});

test("semantic LLVM cache accepts comment edits that shift source lines", async () => {
  const f = await fixture();
  const sourceBefore = await readFile(f.source, "utf8");
  const semanticMod = {
    irVersion: 15,
    sourceFile: f.source,
    functions: [
      {
        name: "__main",
        params: [],
        returnType: { kind: "void" },
        locals: [],
        body: [],
        loc: { file: f.source, start: 0, end: sourceBefore.length },
      },
    ],
    entry: "__main",
  } satisfies IrModule;
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  await publishEarlyLibraryCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    sidecarPath: f.sidecarPath,
    native: {
      backend: "llvm",
      regex: false,
      assert: false,
      inspect: false,
      symbol: false,
      bigint: false,
      searchParams: false,
      emitter: false,
      zlib: false,
      copying: false,
      textDecoderLegacy: false,
      dynInvoke: false,
    },
    frontend: tracker.snapshot(),
    semantic: { mod: semanticMod, sources: new Map([[f.source, sourceBefore]]) },
  });

  await writeFile(f.source, `/* harmless */ ${sourceBefore}`);
  expect(await readSemanticLibraryCache(f.root, f.options, null)).not.toBeNull();
  await writeFile(f.source, `// inserted line\n${sourceBefore}`);
  expect(await readSemanticLibraryCache(f.root, f.options, null)).not.toBeNull();
});

test("semantic LLVM cache accepts line separator normalization", async () => {
  const f = await fixture();
  for (const separator of ["\r", "\u2028", "\u2029"]) {
    const sourceBefore = [
      "export function first(): number { return 1; }",
      "export function value(): number { return 2; }\n",
    ].join(separator);
    await writeFile(f.source, sourceBefore);
    const tracker = new FrontendInputTracker();
    tracker.run(() => trackedReadFile(f.source));
    await publishEarlyLibraryCache(f.root, f.options, {
      llvmPath: f.llvmPath,
      irPath: f.irPath,
      sidecarPath: f.sidecarPath,
      native: {
        backend: "llvm",
        regex: false,
        assert: false,
        inspect: false,
        symbol: false,
        bigint: false,
        searchParams: false,
        emitter: false,
        zlib: false,
        copying: false,
        textDecoderLegacy: false,
        dynInvoke: false,
      },
      frontend: tracker.snapshot(),
      semantic: {
        mod: {
          irVersion: 15,
          sourceFile: f.source,
          functions: [],
          entry: "__main",
        },
        sources: new Map([[f.source, sourceBefore]]),
      },
    });

    await writeFile(f.source, sourceBefore.replace(separator, "\n"));
    expect(await readSemanticLibraryCache(f.root, f.options, null)).not.toBeNull();
  }
});

test("semantic LLVM cache rebases comment edits in multi-source graphs", async () => {
  const f = await fixture();
  const imported = join(dirname(f.source), "helper.ts");
  const entrySource = await readFile(f.source, "utf8");
  const importedSource = "export function helper(): number { return 1; }\n";
  await writeFile(imported, importedSource);
  const semanticMod = {
    irVersion: 15,
    sourceFile: f.source,
    functions: [
      {
        name: "__main",
        params: [],
        returnType: { kind: "void" },
        locals: [],
        body: [],
        loc: { file: f.source, start: 0, end: entrySource.length },
      },
    ],
    entry: "__main",
  } satisfies IrModule;
  const tracker = new FrontendInputTracker();
  tracker.run(() => {
    trackedReadFile(f.source);
    trackedReadFile(imported);
  });
  await publishEarlyLibraryCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    sidecarPath: f.sidecarPath,
    native: {
      backend: "llvm",
      regex: false,
      assert: false,
      inspect: false,
      symbol: false,
      bigint: false,
      searchParams: false,
      emitter: false,
      zlib: false,
      copying: false,
      textDecoderLegacy: false,
      dynInvoke: false,
    },
    frontend: tracker.snapshot(),
    semantic: {
      mod: semanticMod,
      sources: new Map([
        [f.source, entrySource],
        [imported, importedSource],
      ]),
    },
  });

  await writeFile(f.source, `// inserted entry comment\n${entrySource}`);
  expect(await readSemanticLibraryCache(f.root, f.options, null)).not.toBeNull();
  await writeFile(f.source, entrySource);
  await writeFile(imported, `// inserted imported comment\n${importedSource}`);
  expect(await readSemanticLibraryCache(f.root, f.options, null)).not.toBeNull();
});

test("early library cache is separated by the host Node version", async () => {
  const f = await fixture();
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  await publishEarlyLibraryCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    sidecarPath: f.sidecarPath,
    native: {
      backend: "llvm",
      regex: false,
      assert: false,
      inspect: false,
      symbol: false,
      bigint: false,
      searchParams: false,
      emitter: false,
      zlib: false,
      copying: false,
      textDecoderLegacy: false,
      dynInvoke: false,
    },
    frontend: tracker.snapshot(),
  });

  expect(await readEarlyLibraryCache(f.root, f.options, null)).not.toBeNull();
  expect(
    await readEarlyLibraryCache(f.root, { ...f.options, nodeVersion: "v25-test" }, null),
  ).toBeNull();
});

test("early library cache rejects corrupted artifacts and metadata", async () => {
  const f = await fixture();
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  await publishEarlyLibraryCache(f.root, f.options, {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    sidecarPath: f.sidecarPath,
    native: {
      backend: "llvm",
      regex: false,
      assert: false,
      inspect: false,
      symbol: false,
      bigint: false,
      searchParams: false,
      emitter: false,
      zlib: false,
      copying: false,
      textDecoderLegacy: false,
      dynInvoke: false,
    },
    frontend: tracker.snapshot(),
  });
  const earlyRoot = join(f.root, "early-lib");
  const [key] = await readdir(earlyRoot);
  await writeFile(join(earlyRoot, key!, "program.tu"), "corrupt\n");
  expect(await readEarlyLibraryCache(f.root, f.options, null)).toBeNull();

  const stamp = join(earlyRoot, key!, "stamp.json");
  await writeFile(stamp, '{"version":1}\n');
  expect(await readEarlyLibraryCache(f.root, f.options, null)).toBeNull();
});

test("disabled early library cache performs no reads or writes", async () => {
  const f = await fixture();
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  const publish = {
    llvmPath: f.llvmPath,
    irPath: f.irPath,
    sidecarPath: f.sidecarPath,
    native: {
      backend: "llvm" as const,
      regex: false,
      assert: false,
      inspect: false,
      symbol: false,
      bigint: false,
      searchParams: false,
      emitter: false,
      zlib: false,
      copying: false,
      textDecoderLegacy: false,
      dynInvoke: false,
    },
    frontend: tracker.snapshot(),
  };
  await publishEarlyLibraryCache(null, f.options, publish);
  await expect(readdir(f.root)).rejects.toThrow();
  expect(await readEarlyLibraryCache(null, f.options, null)).toBeNull();
});
