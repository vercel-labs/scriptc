import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { FrontendInputTracker, trackedFileExists, trackedReadFile } from "../frontend/input-tracker.js";
import {
  publishEarlyLibraryCache,
  readEarlyLibraryCache,
  type EarlyLibraryCacheOptions,
} from "./early-cache.js";

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  options: EarlyLibraryCacheOptions;
  source: string;
  missing: string;
  cPath: string;
  irPath: string;
  sidecarPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-early-cache-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  const profilePath = join(dir, "profile.json");
  const cPath = join(dir, "entry.lib.ll");
  const irPath = join(dir, "entry.lib.ir.json");
  const sidecarPath = join(dir, "entry.lib.a.contract.json");
  await Promise.all([
    writeFile(source, "export function value(): number { return 1; }\n"),
    writeFile(profilePath, "{}\n"),
    writeFile(cPath, "; generated llvm\n"),
    writeFile(irPath, "{\"irVersion\":6}\n"),
    writeFile(sidecarPath, "{\"contract\":true}\n"),
  ]);
  return {
    root: join(dir, "cache"),
    source,
    missing: join(dir, "missing.ts"),
    cPath,
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
    searchParams: false,
    emitter: false,
    zlib: false,
    copying: false,
    textDecoderLegacy: false,
  };
  await publishEarlyLibraryCache(f.root, f.options, {
    cPath: f.cPath,
    irPath: f.irPath,
    sidecarPath: f.sidecarPath,
    native,
    frontend: tracker.snapshot(),
  });
  await Promise.all([rm(f.cPath), rm(f.irPath), rm(f.sidecarPath)]);
  const staleCPath = join(f.options.outDir, "entry.lib.c");
  await writeFile(staleCPath, "/* stale c backend */\n");

  const hit = await readEarlyLibraryCache(f.root, f.options, null);
  expect(hit).not.toBeNull();
  expect(hit?.native).toEqual(native);
  expect(await readFile(f.cPath, "utf8")).toBe("; generated llvm\n");
  expect(await readFile(f.irPath, "utf8")).toContain("irVersion");
  expect(await readFile(f.sidecarPath, "utf8")).toContain("contract");
  await expect(readFile(staleCPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("early library cache misses on source edits and newly-resolved candidates", async () => {
  const f = await fixture();
  const tracker = new FrontendInputTracker();
  tracker.run(() => {
    trackedReadFile(f.source);
    trackedFileExists(f.missing);
  });
  await publishEarlyLibraryCache(f.root, f.options, {
    cPath: f.cPath,
    irPath: f.irPath,
    sidecarPath: f.sidecarPath,
    native: {
      backend: "llvm",
      regex: false,
      assert: false,
      inspect: false,
      symbol: false,
      searchParams: false,
      emitter: false,
      zlib: false,
      copying: false,
      textDecoderLegacy: false,
    },
    frontend: tracker.snapshot(),
  });

  await writeFile(f.source, "export function value(): number { return 2; }\n");
  expect(await readEarlyLibraryCache(f.root, f.options, null)).toBeNull();
  await writeFile(f.cPath, "; generated llvm v2\n");
  const editedTracker = new FrontendInputTracker();
  editedTracker.run(() => {
    trackedReadFile(f.source);
    trackedFileExists(f.missing);
  });
  await publishEarlyLibraryCache(f.root, f.options, {
    cPath: f.cPath,
    irPath: f.irPath,
    sidecarPath: f.sidecarPath,
    native: {
      backend: "llvm",
      regex: false,
      assert: false,
      inspect: false,
      symbol: false,
      searchParams: false,
      emitter: false,
      zlib: false,
      copying: false,
      textDecoderLegacy: false,
    },
    frontend: editedTracker.snapshot(),
  });
  expect((await readEarlyLibraryCache(f.root, f.options, null))?.cPath).toBe(f.cPath);
  expect(await readFile(f.cPath, "utf8")).toBe("; generated llvm v2\n");

  await writeFile(f.source, "export function value(): number { return 1; }\n");
  await writeFile(f.missing, "export const appeared = true;\n");
  expect(await readEarlyLibraryCache(f.root, f.options, null)).toBeNull();
});

test("early library cache rejects corrupted artifacts and metadata", async () => {
  const f = await fixture();
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  await publishEarlyLibraryCache(f.root, f.options, {
    cPath: f.cPath,
    irPath: f.irPath,
    sidecarPath: f.sidecarPath,
    native: {
      backend: "llvm",
      regex: false,
      assert: false,
      inspect: false,
      symbol: false,
      searchParams: false,
      emitter: false,
      zlib: false,
      copying: false,
      textDecoderLegacy: false,
    },
    frontend: tracker.snapshot(),
  });
  const earlyRoot = join(f.root, "early-lib");
  const [key] = await readdir(earlyRoot);
  await writeFile(join(earlyRoot, key!, "program.tu"), "corrupt\n");
  expect(await readEarlyLibraryCache(f.root, f.options, null)).toBeNull();

  const stamp = join(earlyRoot, key!, "stamp.json");
  await writeFile(stamp, "{\"version\":1}\n");
  expect(await readEarlyLibraryCache(f.root, f.options, null)).toBeNull();
});

test("disabled early library cache performs no reads or writes", async () => {
  const f = await fixture();
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(f.source));
  const publish = {
    cPath: f.cPath,
    irPath: f.irPath,
    sidecarPath: f.sidecarPath,
    native: {
      backend: "llvm" as const,
      regex: false,
      assert: false,
      inspect: false,
      symbol: false,
      searchParams: false,
      emitter: false,
      zlib: false,
      copying: false,
      textDecoderLegacy: false,
    },
    frontend: tracker.snapshot(),
  };
  await publishEarlyLibraryCache(null, f.options, publish);
  await expect(readdir(f.root)).rejects.toThrow();
  expect(await readEarlyLibraryCache(null, f.options, null)).toBeNull();
});
