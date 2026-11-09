import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import type { SourceFile } from "./ast-types.js";
import { Ts7SourceCache, type Ts7SnapshotChanges } from "./session-cache.js";

const require = createRequire(import.meta.url);
const { SourceFileCache } = require(
  join(dirname(require.resolve("typescript/package.json")), "dist/api/sourceFileCache.js"),
) as {
  SourceFileCache: new () => {
    getRetained(path: string, snapshot: number, project: string): SourceFile | undefined;
    set(file: SourceFile, snapshot: number, project: string): SourceFile;
    retainForSnapshot(snapshot: number, previous: number, changes?: Ts7SnapshotChanges): void;
    releaseSnapshot(snapshot: number): void;
    clear(): void;
    size: number;
  };
};

// Cache tests need identity and the two wire keys, not a parser response.
// The live native session test supplies real immutable AstFile instances.
function source(hash: string, options = "0"): SourceFile {
  return { file: { wire: { contentHash: hash, parseOptionsKey: options } } } as SourceFile;
}

test("the cache separates content, parser options, paths and retention owners", () => {
  const cache = new Ts7SourceCache();
  const original = source("one");
  expect(cache.set("/file.ts", original, 1, "/a")).toBe(original);
  expect(cache.set("/file.ts", source("one"), 1, "/b")).toBe(original);
  const changed = source("two");
  expect(cache.set("/file.ts", changed, 2, "/a")).toBe(changed);
  const options = source("two", "different");
  expect(cache.set("/file.ts", options, 2, "/b")).toBe(options);
  const other = source("one");
  expect(cache.set("/other.ts", other, 2, "/a")).toBe(other);
  expect(cache.get("/file.ts", 1, "/b")).toBe(original);
  expect(cache.get("/file.ts", 2, "/b")).toBe(options);
  cache.release(1);
  expect(cache.get("/file.ts", 1, "/b")).toBeUndefined();
  expect(cache.get("/file.ts", 2, "/a")).toBe(changed);
  expect(cache.size).toBe(2);
  cache.release(2);
  cache.release(2);
  expect(cache.size).toBe(0);
});

test("project-specific edits and removals preserve other projects and old snapshots", () => {
  const cache = new Ts7SourceCache();
  for (const project of ["/a", "/b", "/removed"])
    for (const path of ["/changed", "/deleted", "/stable"])
      cache.set(path, source(path), 1, project);
  cache.retain(2, 1, {
    changedProjects: { "/a": { changedFiles: ["/changed"], deletedFiles: ["/deleted"] } },
    removedProjects: ["/removed"],
  });
  expect(cache.get("/changed", 2, "/a")).toBeUndefined();
  expect(cache.get("/deleted", 2, "/a")).toBeUndefined();
  expect(cache.get("/stable", 2, "/a")).toBe(cache.get("/stable", 1, "/a"));
  expect(cache.get("/changed", 2, "/b")).toBe(cache.get("/changed", 1, "/b"));
  expect(cache.get("/stable", 2, "/removed")).toBeUndefined();
  expect(cache.get("/stable", 1, "/removed")).toBeDefined();
  cache.release(1);
  expect(cache.get("/changed", 2, "/b")).toBeDefined();
  cache.clear();
  expect(cache.size).toBe(0);
  expect(cache.get("/stable", 2, "/a")).toBeUndefined();
});

test("one project lineage retains unchanged files across its rebuilds", () => {
  const cache = new Ts7SourceCache();
  // One load shares one synthesized config, so every rebuild is the SAME
  // project in a new snapshot (the lineage program-host.ts creates).
  const project = "/load/__scriptc-ts7-0.tsconfig.json";
  const a = source("a1");
  const b = source("b1");
  cache.set("/a.ts", a, 1, project);
  cache.set("/b.ts", b, 1, project);

  // The next pass adds a root: the config changed, no source file did.
  cache.retain(2, 1, { changedProjects: { [project]: { changedFiles: [] } } });
  expect(cache.get("/a.ts", 2, project)).toBe(a);
  expect(cache.get("/b.ts", 2, project)).toBe(b);

  // A source edit keeps every other file and drops the edited one only.
  cache.retain(3, 2, {
    changedProjects: { [project]: { changedFiles: ["/b.ts"], deletedFiles: ["/c.ts"] } },
  });
  expect(cache.get("/a.ts", 3, project)).toBe(a);
  expect(cache.get("/b.ts", 3, project)).toBeUndefined();
  const b2 = source("b2");
  expect(cache.set("/b.ts", b2, 3, project)).toBe(b2);

  // Older snapshots of the same project still answer for their content.
  expect(cache.get("/b.ts", 2, project)).toBe(b);
  expect(cache.get("/b.ts", 3, project)).toBe(b2);

  // Parse options changed: the server does not list the re-parsed files, so
  // none of that project's trees carry forward.
  cache.retain(4, 3, { changedProjects: { [project]: { changedFiles: [] } } }, new Set([project]));
  expect(cache.get("/a.ts", 4, project)).toBeUndefined();
  expect(cache.get("/b.ts", 4, project)).toBeUndefined();
  expect(cache.get("/a.ts", 3, project)).toBe(a);

  cache.release(3);
  expect(cache.get("/b.ts", 4, project)).toBeUndefined();
  cache.release(4);
  cache.release(2);
  cache.release(1);
  expect(cache.size).toBe(0);
});

test("retention and eviction agree with the pinned SDK through interleaved snapshots", () => {
  const cache = new Ts7SourceCache();
  const sdk = new SourceFileCache();
  const projects = ["/one.json", "/two.json", "/three.json"];
  const paths = ["/a.ts", "/b.ts", "/c.ts"];
  /** The SDK's cache reads the identity fields off the source file itself. */
  const sdkSource = (path: string, file: SourceFile) =>
    ({
      ...file,
      path,
      fileName: path,
      contentHash: file.file.wire.contentHash,
      parseOptionsKey: file.file.wire.parseOptionsKey,
      scriptKind: 0,
    }) as unknown as SourceFile;
  let seed = 117;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed;
  };
  for (let snapshot = 1; snapshot <= 15; snapshot++) {
    const changes: Ts7SnapshotChanges = {
      changedProjects: { "/one.json": { changedFiles: [paths[random() % 3]!] } },
      removedProjects: snapshot % 4 === 0 ? ["/three.json"] : [],
    };
    cache.retain(snapshot, snapshot - 1, changes);
    sdk.retainForSnapshot(snapshot, snapshot - 1, changes);
    for (const project of projects)
      for (const path of paths) {
        if (cache.get(path, snapshot, project) !== undefined) continue;
        const file = source(String(random() % 4), String(random() % 2));
        const sdkFile = sdkSource(path, file);
        expect(cache.set(path, file, snapshot, project) === file).toBe(
          sdk.set(sdkFile, snapshot, project) === sdkFile,
        );
      }
    if (snapshot > 2) {
      const release = (random() % (snapshot - 1)) + 1;
      cache.release(release);
      sdk.releaseSnapshot(release);
    }
    for (let id = 1; id <= snapshot; id++)
      for (const project of projects)
        for (const path of paths)
          expect(cache.get(path, id, project) !== undefined).toBe(
            sdk.getRetained(path, id, project) !== undefined,
          );
    expect(cache.size).toBe(sdk.size);
  }
  for (let id = 1; id <= 15; id++) {
    cache.release(id);
    sdk.releaseSnapshot(id);
  }
  expect(cache.size).toBe(sdk.size);
  expect(cache.size).toBe(0);
});
