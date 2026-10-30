import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { nativeCodegenDiag } from "../diagnostics/diagnostic.js";
import { compilerReleaseVersion } from "../library/sidecar.js";
import type { NativeLinkFeatures } from "./native-link-info.js";
import { RUNTIME_ABI_MARKER, RUNTIME_ABI_VERSION } from "./runtime-abi.js";
import { RuntimePackError, type RuntimePackManifest } from "./runtime-pack-core.js";
import {
  runtimePackManifest,
  selectNativeRuntimePack,
  stageNativeRuntimeSelection,
  type NativeRuntimeSelection,
  type RuntimePackStore,
} from "./runtime-pack-native.js";
import { MACOS_ARM64_TARGET, WASM32_WASI_TARGET } from "./targets.js";

vi.mock("node:crypto", async (original) => {
  const crypto = await original<typeof import("node:crypto")>();
  return { ...crypto, createHash: vi.fn(crypto.createHash) };
});
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
);

test("a missing cross-target runtime pack names its package in the diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "scriptc-runtime-pack-native-"));
  dirs.push(root);
  let error: unknown;
  try {
    selectNativeRuntimePack(
      join(root, "runtime-wasm32-wasi"),
      WASM32_WASI_TARGET,
      "0.3.5",
      {} as NativeLinkFeatures,
      "release",
    );
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(RuntimePackError);
  const pack = error as RuntimePackError;
  expect(pack.code).toBe("missing");
  const diagnostic = nativeCodegenDiag("SC3003", pack.message, "main.ts", pack.hint);
  expect(diagnostic.message).toBe(
    "runtime pack for wasm32-wasi is not installed; install @scriptc/runtime-wasm32-wasi@0.3.5 in your project or set SCRIPTC_RUNTIME_PACK to its directory",
  );
  expect(diagnostic.hint).toBe(
    "scriptc includes the runtime pack for its own platform only; other targets need their runtime pack package in the project",
  );
});

test("a missing native helper keeps the reinstall hint", () => {
  expect(nativeCodegenDiag("SC3003", "helper missing", "main.ts").hint).toBe(
    "reinstall scriptc with optional dependencies enabled for this host",
  );
});

/** A runtime pack with one runtime object and a license, and a store that
 * keeps entries in memory. */
async function packFixture() {
  const root = await mkdtemp(join(tmpdir(), "scriptc-runtime-pack-store-"));
  dirs.push(root);
  const target = MACOS_ARM64_TARGET;
  const version = compilerReleaseVersion();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: target.runtimePackPackage, version }),
  );
  mkdirSync(join(root, "artifacts"));
  const object = join(root, "artifacts", "base.o");
  writeFileSync(object, "base object");
  writeFileSync(join(root, "license.txt"), "license");
  const unit = {
    source: "scr_base.c",
    predicate: true,
    variants: [
      {
        id: "default",
        when: {},
        defines: [],
        path: "artifacts/base.o",
        sha256: createHash("sha256").update("base object").digest("hex"),
        size: Buffer.byteLength("base object"),
      },
    ],
  };
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
    compiler: { command: "clang", identity: "fixture clang", target: target.llvmTriple },
    macros: {
      executable: [],
      excluded: ["SCR_LIB", "SCR_THREAD_INSTANCES", "SCR_RC_AUDIT"],
      sanitizer: "external-toolchain-required",
    },
    flavors: {
      release: { optimization: "-O2", runtime_units: [unit] },
      dev: { optimization: "-O0", runtime_units: [unit] },
    },
    archives: [],
    system_libraries: [{ name: "System", predicate: true }],
    licenses: [{ path: "license.txt", license: "fixture" }],
  };
  const manifestText = JSON.stringify(manifest);
  writeFileSync(join(root, "runtime-pack.json"), manifestText);
  const entries = new Map<string, string>();
  const store: RuntimePackStore = {
    read: (key) => entries.get(key) ?? null,
    write: (key, text) => void entries.set(key, text),
  };
  const select = () =>
    selectNativeRuntimePack(
      root,
      target,
      version,
      {} as NativeLinkFeatures,
      "release",
      "executable",
      store,
    );
  let stages = 0;
  const stage = (selection: NativeRuntimeSelection, with_: RuntimePackStore = store) => {
    const directory = join(tmpdir(), `scriptc-runtime-pack-stage-${process.pid}-${stages++}`);
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory);
    dirs.push(directory);
    return stageNativeRuntimeSelection(selection, directory, with_);
  };
  return { root, object, manifestText, entries, select, stage };
}

test("a stored selection answers while the pack's files keep their identities", async () => {
  const f = await packFixture();
  const first = f.select();
  expect(first.selected.systemLibraries).toEqual(["System"]);
  expect(f.entries.size).toBe(1);
  // The next selection reads the stored answer instead of the manifest.
  const [key, text] = [...f.entries][0]!;
  const stored = JSON.parse(text);
  stored.selected.systemLibraries = ["Stored"];
  f.entries.set(key, JSON.stringify(stored));
  const second = f.select();
  expect(second.selected.systemLibraries).toEqual(["Stored"]);
  expect(second.licenses).toEqual(first.licenses);
  expect(second.manifest).toBeUndefined();
  expect(runtimePackManifest(second).flavors.release).toEqual(first.manifest!.flavors.release);
  // Writing the manifest again, with the same text, gives it a new identity.
  writeFileSync(join(f.root, "runtime-pack.json"), f.manifestText);
  expect(f.select().selected.systemLibraries).toEqual(["System"]);
});

test.each(["replaced", "rewritten in place"])(
  "staging hashes an artifact again when it is %s, even at the same size and mtime",
  async (change) => {
    const f = await packFixture();
    const selection = f.select();
    f.stage(selection);
    const before = statSync(f.object);
    const changed = change === "replaced" ? f.object + ".new" : f.object;
    writeFileSync(changed, "x".repeat(before.size));
    utimesSync(changed, before.atime, before.mtime);
    if (changed !== f.object) renameSync(changed, f.object);
    expect(() => f.stage(selection)).toThrow(
      "runtime pack artifact hash mismatch: artifacts/base.o",
    );
  },
);

test("staging does not hash an unchanged artifact again", async () => {
  const f = await packFixture();
  const selection = f.select();
  const hashes = () => vi.mocked(createHash).mock.calls.length;
  let start = hashes();
  f.stage(selection);
  const firstStage = hashes() - start;
  start = hashes();
  const staged = f.stage(selection);
  // Only the store key is hashed; the staged copy has the verified bytes.
  expect(hashes() - start).toBe(firstStage - 1);
  expect(readFileSync(staged.runtimeObjects[0]!, "utf8")).toBe("base object");
});

test.skipIf(process.platform === "win32")(
  "staging reads an artifact's bytes from the file whose identity it checks",
  async () => {
    const f = await packFixture();
    // The artifact path is a symbolic link to the verified file.
    const real = f.object + ".real";
    renameSync(f.object, real);
    symlinkSync(real, f.object);
    const selection = f.select();
    f.stage(selection);
    // During the next read the link names another file of the same size,
    // and it names the verified file again before the read ends.
    const other = f.object + ".other";
    writeFileSync(other, "x".repeat(statSync(real).size));
    const read = vi.mocked(readFileSync);
    const original = read.getMockImplementation()!;
    read.mockImplementation(((source: Parameters<typeof readFileSync>[0], ...rest: unknown[]) => {
      if (typeof source === "string" && !source.endsWith("base.o"))
        return (original as (...args: unknown[]) => unknown)(source, ...rest);
      read.mockImplementation(original);
      unlinkSync(f.object);
      symlinkSync(other, f.object);
      try {
        return (original as (...args: unknown[]) => unknown)(source, ...rest);
      } finally {
        unlinkSync(f.object);
        symlinkSync(real, f.object);
      }
    }) as typeof readFileSync);
    const staged = f.stage(selection);
    expect(read.getMockImplementation()).toBe(original);
    expect(readFileSync(staged.runtimeObjects[0]!, "utf8")).toBe("base object");
  },
);

/** A store that keeps nothing: a build with an empty cache. */
function emptyStore(): RuntimePackStore {
  const entries = new Map<string, string>();
  return {
    read: (key) => entries.get(key) ?? null,
    write: (key, text) => void entries.set(key, text),
  };
}

const packRecord = (root: string) => join(root, "runtime-pack.verified.json");
const hashes = () => vi.mocked(createHash).mock.calls.length;

test("a build with an empty cache trusts the record beside the pack", async () => {
  const f = await packFixture();
  const selection = f.select();
  let start = hashes();
  f.stage(selection);
  const firstStage = hashes() - start;
  const record = JSON.parse(readFileSync(packRecord(f.root), "utf8"));
  expect(record.schema).toBe(1);
  expect(record.artifacts.map((artifact: { path: string }) => artifact.path)).toEqual([
    "artifacts/base.o",
  ]);
  start = hashes();
  const staged = f.stage(selection, emptyStore());
  // Only the store key is hashed.
  expect(hashes() - start).toBe(firstStage - 1);
  expect(readFileSync(staged.runtimeObjects[0]!, "utf8")).toBe("base object");
});

test.each(["replaced", "rewritten in place", "resized"])(
  "the record beside the pack does not trust an artifact that was %s",
  async (change) => {
    const f = await packFixture();
    const selection = f.select();
    f.stage(selection);
    const before = statSync(f.object);
    const changed = change === "replaced" ? f.object + ".new" : f.object;
    writeFileSync(changed, "x".repeat(before.size + (change === "resized" ? 1 : 0)));
    utimesSync(changed, before.atime, before.mtime);
    if (changed !== f.object) renameSync(changed, f.object);
    expect(() => f.stage(selection, emptyStore())).toThrow(
      "runtime pack artifact hash mismatch: artifacts/base.o",
    );
  },
);

test("an artifact whose mtime changed is hashed again and recorded again", async () => {
  const f = await packFixture();
  const selection = f.select();
  f.stage(selection);
  const before = statSync(f.object);
  utimesSync(f.object, before.atime, new Date(before.mtimeMs + 5000));
  const start = hashes();
  f.stage(selection, emptyStore());
  // The store key and the artifact.
  expect(hashes() - start).toBe(2);
  const [entry] = JSON.parse(readFileSync(packRecord(f.root), "utf8")).artifacts;
  expect(entry.mtime).toBe(statSync(f.object).mtimeMs);
  const again = hashes();
  f.stage(selection, emptyStore());
  expect(hashes() - again).toBe(1);
});

test.each([
  ["truncated", () => "{"],
  ["null", () => "null"],
  ["another schema", (text: string) => text.replace('"schema":1', '"schema":2')],
  [
    "an entry with a string ctime",
    (text: string) => text.replace(/"ctime":([\d.]+)/, '"ctime":"$1"'),
  ],
  ["an entry without an inode", (text: string) => text.replace(/"ino":[\d.]+,/, "")],
  [
    "another digest",
    (text: string) => text.replace(/"sha256":"[0-9a-f]+"/, `"sha256":"${"0".repeat(64)}"`),
  ],
])("a record beside the pack that is %s is not trusted", async (_name, rewrite) => {
  const f = await packFixture();
  const selection = f.select();
  f.stage(selection);
  const text = readFileSync(packRecord(f.root), "utf8");
  const rewritten = rewrite(text);
  expect(rewritten).not.toBe(text);
  writeFileSync(packRecord(f.root), rewritten);
  const start = hashes();
  const staged = f.stage(selection, emptyStore());
  expect(hashes() - start).toBe(2);
  expect(readFileSync(staged.runtimeObjects[0]!, "utf8")).toBe("base object");
  // The record is written again, whole.
  const [entry] = JSON.parse(readFileSync(packRecord(f.root), "utf8")).artifacts;
  expect(entry.ino).toBe(statSync(f.object).ino);
});

test("an unreadable record beside the pack is not trusted, and staging still succeeds", async () => {
  const f = await packFixture();
  const selection = f.select();
  // A directory where the record would be: it can be neither read nor replaced.
  mkdirSync(packRecord(f.root));
  const start = hashes();
  f.stage(selection, emptyStore());
  f.stage(selection, emptyStore());
  expect(hashes() - start).toBe(4);
  expect(readdirSync(f.root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test.skipIf(process.platform === "win32")(
  "a pack directory that cannot be written keeps the record in the cache only",
  async (context) => {
    const f = await packFixture();
    const selection = f.select();
    chmodSync(f.root, 0o555);
    try {
      // A process that may write any directory cannot run this case.
      try {
        writeFileSync(join(f.root, "probe"), "");
        rmSync(join(f.root, "probe"));
        context.skip();
      } catch {
        /* The directory is read-only for this process. */
      }
      const store = emptyStore();
      let start = hashes();
      f.stage(selection, store);
      expect(hashes() - start).toBe(2);
      expect(existsSync(packRecord(f.root))).toBe(false);
      expect(readdirSync(f.root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      // The cache's record still answers the next build with that cache.
      start = hashes();
      f.stage(selection, store);
      expect(hashes() - start).toBe(1);
    } finally {
      chmodSync(f.root, 0o755);
    }
  },
);

test("writing the record beside the pack keeps the entries another build wrote", async () => {
  const f = await packFixture();
  const selection = f.select();
  const other = {
    path: "artifacts/other.o",
    sha256: "1".repeat(64),
    dev: 1,
    ino: 2,
    size: 3,
    mtime: 4,
    ctime: 5,
  };
  writeFileSync(packRecord(f.root), JSON.stringify({ schema: 1, artifacts: [other] }));
  f.stage(selection, emptyStore());
  const record = JSON.parse(readFileSync(packRecord(f.root), "utf8"));
  expect(record.artifacts.map((artifact: { path: string }) => artifact.path).sort()).toEqual([
    "artifacts/base.o",
    "artifacts/other.o",
  ]);
  expect(
    record.artifacts.find((artifact: { path: string }) => artifact.path === other.path),
  ).toEqual(other);
  expect(readdirSync(f.root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("a cache that already trusts the artifacts writes the record beside the pack", async () => {
  const f = await packFixture();
  const selection = f.select();
  f.stage(selection);
  rmSync(packRecord(f.root));
  const start = hashes();
  f.stage(selection);
  // The cache's record answers; only the store key is hashed.
  expect(hashes() - start).toBe(1);
  expect(existsSync(packRecord(f.root))).toBe(true);
  const empty = hashes();
  f.stage(selection, emptyStore());
  expect(hashes() - empty).toBe(1);
});
