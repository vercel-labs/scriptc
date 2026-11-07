import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  LINUX_ARM64_GNU_TARGET,
  nativeCodegenTarget,
  WASM32_WASI_TARGET,
} from "../backend/targets.js";
import { runFrontend, type FrontendFactory } from "../frontend/pipeline.js";
import { loadProgram, loadProgramWithServices } from "../frontend/program-node.js";
import { FrontendServices } from "../frontend/services.js";
import { Ts7Api, ts7Executable } from "../frontend/ts7/rpc-api.js";
import { deserializeModule } from "../ir/serialize.js";
import { NativeCache, partsDigest } from "./cache.js";
import { prepareNativeExecutable } from "./prepare.js";
import type { NativeToolchain } from "./toolchain.js";

/** A prepared input with its LLVM parts joined: a cache hit reads the text
 * back as one part. */
function text(input: ReturnType<ReturnType<typeof fixture>["prepare"]>) {
  return input.ok ? { ...input, llvm: input.llvm.join("") } : input;
}

const scratch: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixtureToolchain(): NativeToolchain {
  const target = nativeCodegenTarget()!;
  return {
    compilerVersion: "test",
    target,
    helper: target.helper,
    helperExecutable: "unused",
    helperPackageRoot: "unused",
    runtimePackRoot: "unused",
    linker: "unused",
    linkerArgs: [],
    dsymutil: "unused",
    ts7Executable: ts7Executable(),
  };
}

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), "scriptc-native-frontend-"));
  scratch.push(temporary);
  const root = join(temporary, "project");
  mkdirSync(root);
  const entry = join(root, "main.ts");
  const dependency = join(root, "value.ts");
  writeFileSync(entry, 'import { value } from "./value.js"; console.log(value);\n');
  writeFileSync(dependency, 'export const value = "first";\n');
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, types: [], target: "esnext", module: "nodenext" },
    }),
  );
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  const toolchain = fixtureToolchain();
  const cache = new NativeCache(join(temporary, "cache"));
  const options = {
    outPath: join(root, ".scriptc", "main"),
    outDir: join(root, ".scriptc"),
    optimization: "release" as const,
  };
  let loads = 0;
  const frontend: FrontendFactory = (path, npmStatic, externalTypes) => {
    loads++;
    return runFrontend(path, loadProgram, npmStatic, externalTypes);
  };
  const prepare = (extra: { emitIr?: boolean; optimization?: "release" | "dev" } = {}) =>
    prepareNativeExecutable(entry, { ...options, ...extra }, null, toolchain, frontend, cache);
  return { root, entry, dependency, cache, options, prepare, loads: () => loads };
}

test("warm frontend reuse survives output creation and invalidates imported source edits", () => {
  const f = fixture();
  const first = f.prepare();
  expect(first.ok, JSON.stringify(first)).toBe(true);
  if (!first.ok) return;
  mkdirSync(f.options.outDir);
  writeFileSync(f.options.outPath, "binary placeholder");
  writeFileSync(join(f.options.outDir, "main.ll"), first.llvm.join(""));
  const warm = f.prepare();
  expect(text(warm)).toEqual(text(first));
  expect(f.loads()).toBe(1);
  writeFileSync(f.dependency, 'export const value = "second";\n');
  const edited = f.prepare();
  expect(edited.ok).toBe(true);
  if (edited.ok) expect(edited.llvm.join("")).not.toBe(first.llvm.join(""));
  expect(f.loads()).toBe(2);
});

test("comment and whitespace edits reuse the frontend output a fresh build reproduces", () => {
  const f = fixture();
  const first = f.prepare();
  expect(first.ok, JSON.stringify(first)).toBe(true);
  if (!first.ok) return;
  const commented = '// The exported value.\nexport const value = /* unchanged */ "first";\n';
  writeFileSync(f.dependency, commented);
  const reused = f.prepare();
  expect(f.loads()).toBe(1);
  expect(reused.ok).toBe(true);
  if (!reused.ok) return;
  expect(reused.llvm.join("")).toBe(first.llvm.join(""));
  expect(new Map(reused.sources).get(f.dependency)).toBe(commented);
  // The reused output is the one the edited sources lower to.
  const fresh = prepareNativeExecutable(
    f.entry,
    f.options,
    null,
    fixtureToolchain(),
    (path, npmStatic, externalTypes) => runFrontend(path, loadProgram, npmStatic, externalTypes),
    new NativeCache(join(f.root, "fresh-cache")),
  );
  expect(fresh.ok && fresh.llvm.join("")).toBe(first.llvm.join(""));
  // The refreshed entry still notices a later code edit.
  writeFileSync(f.dependency, 'export const value = "second";\n');
  const edited = f.prepare();
  expect(f.loads()).toBe(2);
  expect(edited.ok && edited.llvm.join("")).not.toBe(first.llvm.join(""));
});

test("a dev build reuses its frontend output after edits that keep every token's position", () => {
  const f = fixture();
  const dev = { optimization: "dev" as const };
  const first = f.prepare(dev);
  expect(first.ok, JSON.stringify(first)).toBe(true);
  if (!first.ok) return;
  // Debug information records lines and columns: a comment after the last
  // token and trailing whitespace keep them.
  const appended = 'export const value = "first";  \n// The exported value.\n';
  writeFileSync(f.dependency, appended);
  const reused = f.prepare(dev);
  expect(f.loads()).toBe(1);
  expect(reused.ok).toBe(true);
  if (!reused.ok) return;
  expect(reused.llvm.join("")).toBe(first.llvm.join(""));
  expect(new Map(reused.sources).get(f.dependency)).toBe(appended);
  const fresh = prepareNativeExecutable(
    f.entry,
    { ...f.options, ...dev },
    null,
    fixtureToolchain(),
    (path, npmStatic, externalTypes) => runFrontend(path, loadProgram, npmStatic, externalTypes),
    new NativeCache(join(f.root, "fresh-cache")),
  );
  expect(fresh.ok && fresh.llvm.join("")).toBe(first.llvm.join(""));
  // A comment that moves the token after it is rebuilt.
  writeFileSync(f.dependency, '// The exported value.\nexport const value = "first";\n');
  const moved = f.prepare(dev);
  expect(f.loads()).toBe(2);
  expect(moved.ok && moved.llvm.join("")).not.toBe(first.llvm.join(""));
});

test("a comment edit inside source text the output carries is rebuilt", () => {
  const f = fixture();
  // A failing assert(value) reports its call's source text.
  const source = (call: string) =>
    `import assert from "node:assert";\nexport const value = "first";\n${call};\n`;
  writeFileSync(f.dependency, source("assert(value.length > 0)"));
  const first = f.prepare();
  expect(first.ok, JSON.stringify(first)).toBe(true);
  if (!first.ok) return;
  writeFileSync(f.dependency, source("assert(value.length > 0 /* checked */)"));
  const edited = f.prepare();
  expect(f.loads()).toBe(2);
  expect(edited.ok && edited.llvm.join("")).not.toBe(first.llvm.join(""));
});

test("a whitespace edit that moves a reported source line is rebuilt", () => {
  const f = fixture();
  // node:test reports the file, line and column of each test.
  const source = (gap: string) =>
    `import { test } from "node:test";\nexport const value = "first";\n${gap}test("value", () => {});\n`;
  writeFileSync(f.dependency, source(""));
  const first = f.prepare();
  expect(first.ok, JSON.stringify(first)).toBe(true);
  if (!first.ok) return;
  writeFileSync(f.dependency, source("\n"));
  const edited = f.prepare();
  expect(f.loads()).toBe(2);
  expect(edited.ok && edited.llvm.join("")).not.toBe(first.llvm.join(""));
});

test("structurally invalid cached features cause a rebuild even with a valid digest", () => {
  const f = fixture();
  expect(f.prepare().ok).toBe(true);
  const family = join(f.cache.root, "frontend");
  const key = readdirSync(family).find((name) => /^[0-9a-f]{64}$/.test(name))!;
  const payload = JSON.parse(readFileSync(join(family, key), "utf8"));
  payload.input.features = {};
  f.cache.write("frontend", key, JSON.stringify(payload));
  expect(f.prepare().ok).toBe(true);
  expect(f.loads()).toBe(2);
});

test("timing, cache placement and emission worker variables keep the frontend output", () => {
  for (const name of [
    "SCRIPTC_CACHE_DIR",
    "SCRIPTC_CACHE_MAX_MB",
    "SCRIPTC_EMIT_WORKERS",
    "SCRIPTC_EMIT_WORKER_FAIL",
    "SCRIPTC_EMIT_WORKER_FUNCTIONS",
    "SCRIPTC_TIMING",
    "SCRIPTC_TEST_FRONTEND_KEY",
  ])
    vi.stubEnv(name, undefined);
  const f = fixture();
  expect(f.prepare().ok).toBe(true);
  vi.stubEnv("SCRIPTC_CACHE_DIR", f.cache.root);
  vi.stubEnv("SCRIPTC_CACHE_MAX_MB", "8192");
  vi.stubEnv("SCRIPTC_EMIT_WORKERS", "1");
  vi.stubEnv("SCRIPTC_EMIT_WORKER_FAIL", "all");
  vi.stubEnv("SCRIPTC_EMIT_WORKER_FUNCTIONS", "100");
  vi.stubEnv("SCRIPTC_TIMING", "0");
  expect(f.prepare().ok).toBe(true);
  expect(f.loads()).toBe(1);
  vi.stubEnv("SCRIPTC_TEST_FRONTEND_KEY", "1");
  expect(f.prepare().ok).toBe(true);
  expect(f.loads()).toBe(2);
});

test("serialized IR travels as bounded parts through the frontend cache", () => {
  const f = fixture();
  const first = f.prepare({ emitIr: true });
  expect(first.ok, JSON.stringify(first)).toBe(true);
  if (!first.ok) return;
  expect(Array.isArray(first.ir)).toBe(true);
  const mod = deserializeModule(first.ir!.join(""));
  expect(mod.functions.length).toBeGreaterThan(0);
  const warm = f.prepare({ emitIr: true });
  expect(f.loads()).toBe(1);
  expect(text(warm)).toEqual(text(first));
  const family = join(f.cache.root, "frontend");
  const key = readdirSync(family).find((name) => /^[0-9a-f]{64}$/.test(name))!;
  const payload = JSON.parse(readFileSync(join(family, key), "utf8"));
  expect(payload.schema).toBe("scriptc.native-frontend.v4");
  // The placeholders keep NativeExecutableInput's member types: the native
  // compiler checks the parsed entry against them when it reads it back.
  expect(payload.input.llvm).toEqual([]);
  expect(payload.input.ir).toBeNull();
  expect(payload.input.llvmDigest).toBeUndefined();
  // The LLVM text is its own entry, named by its digest.
  expect(payload.llvm).toBe(partsDigest(first.llvm));
  expect(readFileSync(join(f.cache.root, "frontend-llvm", payload.llvm), "utf8")).toBe(
    first.llvm.join(""),
  );
  expect(payload.ir).toEqual(first.ir);
  expect(warm.ok && warm.llvmDigest).toBe(payload.llvm);
});

test("an LLVM text entry that is missing or does not match its digest causes a rebuild", () => {
  const f = fixture();
  const first = f.prepare();
  expect(first.ok, JSON.stringify(first)).toBe(true);
  if (!first.ok) return;
  const family = join(f.cache.root, "frontend-llvm");
  const digest = partsDigest(first.llvm);
  writeFileSync(join(family, digest), first.llvm.join("") + "\n");
  const rebuilt = f.prepare();
  expect(f.loads()).toBe(2);
  expect(text(rebuilt)).toEqual(text(first));
  rmSync(join(family, digest));
  expect(f.prepare().ok).toBe(true);
  expect(f.loads()).toBe(3);
});

/* Build-time require.resolve. The native compiler resolves with its own
 * resolver (cjs-resolve.ts), which reads the tracked filesystem and records
 * the host facts its global lookup locations come from; a Node host
 * supplies its resolver, whose reads are not reported. */

/** A frontend whose services carry no host module resolver, as the native
 * compiler's do. */
const ownResolverFrontend: FrontendFactory = (path, npmStatic, externalTypes) =>
  runFrontend(
    path,
    (entry, options) => {
      const services = new FrontendServices((apiOptions) => new Ts7Api(apiOptions));
      try {
        const load = loadProgramWithServices(entry, services, options);
        return {
          ...load,
          dispose: () => {
            try {
              load.dispose();
            } finally {
              services.close();
            }
          },
        };
      } catch (error) {
        services.close();
        throw error;
      }
    },
    npmStatic,
    externalTypes,
  );

function resolvingFixture(frontend: FrontendFactory) {
  const f = fixture();
  writeFileSync(
    f.entry,
    [
      'import { createRequire } from "node:module";',
      "const require = createRequire(import.meta.url);",
      'console.log(require.resolve("./cfg.json"));',
      'console.log(JSON.stringify(require.resolve.paths("some-package")));',
      "try {",
      '  console.log(require.resolve("./later.cjs"));',
      "} catch (error) {",
      '  console.log("missing", (error as { code?: string }).code);',
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(join(f.root, "cfg.json"), "{}\n");
  let loads = 0;
  const phases: [string, Record<string, unknown> | undefined][] = [];
  const prepare = (cache: NativeCache = f.cache) =>
    prepareNativeExecutable(
      f.entry,
      f.options,
      null,
      fixtureToolchain(),
      (path, npmStatic, externalTypes) => {
        loads++;
        return frontend(path, npmStatic, externalTypes);
      },
      cache,
      (phase, detail) => phases.push([phase, detail]),
    );
  return { ...f, prepare, loads: () => loads, phases };
}

test("a build that resolves modules with the compiler's own resolver is cached", () => {
  const f = resolvingFixture(ownResolverFrontend);
  const first = f.prepare();
  expect(first.ok, JSON.stringify(first)).toBe(true);
  expect(f.phases.find(([phase]) => phase === "frontend-cache-publish")?.[1]).toBeUndefined();
  const again = f.prepare();
  expect(f.loads()).toBe(1);
  expect(text(again)).toEqual(text(first));
  // A candidate the resolution probed and did not find appears: the entry
  // no longer answers, and the rebuild is a cold build's.
  writeFileSync(join(f.root, "later.cjs"), "module.exports = 1;\n");
  const later = f.prepare();
  expect(f.loads()).toBe(2);
  expect(later.ok && first.ok && later.llvm.join("")).not.toBe(first.ok && first.llvm.join(""));
  const cold = f.prepare(new NativeCache(join(f.root, "..", "cold-cache")));
  expect(text(later)).toEqual(text(cold));
});

test("the home directory, NODE_PATH and the compiler's location are inputs of such a build", () => {
  const f = resolvingFixture(ownResolverFrontend);
  expect(f.prepare().ok).toBe(true);
  const key = readdirSync(join(f.cache.root, "frontend")).find((name) =>
    /^[0-9a-f]{64}$/.test(name),
  )!;
  const entry = JSON.parse(readFileSync(join(f.cache.root, "frontend", key), "utf8"));
  const facts = entry.probes.probes
    .filter((probe: { op: string }) => probe.op === "host")
    .map((probe: { path: string }) => probe.path);
  expect([...facts].sort()).toEqual(
    [
      "env:NODE_PATH",
      process.platform === "win32" ? "env:USERPROFILE" : "env:HOME",
      "prefix",
    ].sort(),
  );
  expect(f.prepare().ok).toBe(true);
  expect(f.loads()).toBe(1);
  // The legacy lookup locations start from these; under another value the
  // entry's answer is not this build's.
  vi.stubEnv("NODE_PATH", join(f.root, "elsewhere"));
  expect(f.prepare().ok).toBe(true);
  expect(f.loads()).toBe(2);
});

test("a build that asks the host's module resolver is not cached, and says so", () => {
  const f = resolvingFixture((path, npmStatic, externalTypes) =>
    runFrontend(path, loadProgram, npmStatic, externalTypes),
  );
  expect(f.prepare().ok).toBe(true);
  expect(f.phases.find(([phase]) => phase === "frontend-cache-publish")?.[1]).toEqual({
    skipped:
      "a require.resolve call was answered by the host's module resolver, which does not report what it read",
  });
  expect(f.prepare().ok).toBe(true);
  expect(f.loads()).toBe(2);
});

test("a build without a cache key says why nothing was published", () => {
  const f = fixture();
  const phases: [string, Record<string, unknown> | undefined][] = [];
  const build = (toolchain: NativeToolchain) =>
    prepareNativeExecutable(
      f.entry,
      f.options,
      null,
      toolchain,
      (path, npmStatic, externalTypes) => runFrontend(path, loadProgram, npmStatic, externalTypes),
      f.cache,
      (phase, detail) => phases.push([phase, detail]),
    );
  // The checker's executable is part of the key: one that is not a file
  // leaves the build without a key.
  const result = build({ ...fixtureToolchain(), ts7Executable: join(f.root, "missing-checker") });
  expect(result.ok).toBe(true);
  expect(phases.find(([phase]) => phase === "frontend-cache-publish")?.[1]).toEqual({
    skipped: "the compiler's toolchain could not be identified",
  });
  // A build that has one and publishes says nothing.
  phases.length = 0;
  expect(build(fixtureToolchain()).ok).toBe(true);
  expect(phases.find(([phase]) => phase === "frontend-cache-publish")?.[1]).toBeUndefined();
});

test("an x86-64 level is refused for targets that are not x86-64 before the frontend runs", () => {
  const f = fixture();
  for (const target of [LINUX_ARM64_GNU_TARGET, WASM32_WASI_TARGET]) {
    const result = prepareNativeExecutable(
      f.entry,
      { ...f.options, targetCpu: "x86-64-v3" },
      null,
      { ...fixtureToolchain(), target },
      () => {
        throw new Error("the frontend ran");
      },
      null,
    );
    expect(result.ok).toBe(false);
    if (result.ok) continue;
    expect(result.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["SC3002", "--target-cpu=x86-64-v3 requires an x86-64 target"],
    ]);
  }
});

/** The fixture's project with the package `tiny` in a Node island, and a
 * frontend that passes the island set on (it reaches the frontend through
 * its options) and counts its loads. */
function islandFixture() {
  const f = fixture();
  const pkg = join(f.root, "node_modules", "tiny");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "tiny", version: "1.0.0", main: "index.js", types: "index.d.ts" }),
  );
  const moduleFile = join(pkg, "index.js");
  writeFileSync(moduleFile, 'exports.greet = (name) => "hello " + name;\n');
  writeFileSync(join(pkg, "index.d.ts"), "export declare function greet(name: string): string;\n");
  writeFileSync(
    join(f.root, "package.json"),
    JSON.stringify({ type: "module", scriptc: { packages: { tiny: "node" } } }),
  );
  writeFileSync(f.entry, 'import { greet } from "tiny"; console.log(greet("island"));\n');
  let loads = 0;
  const frontend: FrontendFactory = (path, npmStatic, externalTypes, libraryNpmStatic, options) => {
    loads++;
    return runFrontend(path, loadProgram, npmStatic, externalTypes, libraryNpmStatic, options);
  };
  const prepare = (extra: { outputKind?: "exe" | "ir" | "llvm"; libnode?: string } = {}) =>
    prepareNativeExecutable(
      f.entry,
      { ...f.options, ...extra },
      null,
      fixtureToolchain(),
      frontend,
      f.cache,
    );
  return { ...f, moduleFile, prepare, loads: () => loads };
}

/** The island module data an LLVM text carries: the length the install call
 * passes and the length of the constant it names. */
function islandModuleData(llvm: string): { passed: number; constant: number } | null {
  const call =
    /call void @scr_node_island_install_modules\(ptr [^,]+, i64 \d+, ptr (@sc_node_island_modules|null), i64 (\d+), /.exec(
      llvm,
    );
  const constant = /@sc_node_island_modules = private unnamed_addr constant \[(\d+) x i8\]/.exec(
    llvm,
  );
  if (call === null) return null;
  return { passed: Number(call[2]), constant: constant === null ? 0 : Number(constant[1]) };
}

test("a program with a Node island carries its island modules and loads them eagerly without a pack", () => {
  const f = islandFixture();
  // LLVM text needs no libnode pack: the module tree's bytes are in the
  // text, and the install call passes them.
  const llvm = f.prepare({ outputKind: "llvm" });
  expect(llvm.ok).toBe(true);
  if (!llvm.ok) return;
  const data = islandModuleData(llvm.llvm.join(""));
  expect(data).not.toBeNull();
  expect(data!.passed).toBeGreaterThanOrEqual(readFileSync(f.moduleFile).length);
  expect(data!.constant).toBe(data!.passed);
  expect(llvm.features.nodeIsland).toBe(true);
  expect(llvm.islands).toEqual({ packages: ["tiny"], modules: [] });
  // IR: without a pack to probe in, every island load is the eager one.
  const ir = f.prepare({ outputKind: "ir" });
  expect(ir.ok).toBe(true);
  if (!ir.ok) return;
  const text = ir.ir!.join("");
  expect(text).toContain('"nodeIsland.require"');
  expect(text).not.toContain('"nodeIsland.defer"');
});

test("an executable with a Node island needs a libnode pack", () => {
  vi.stubEnv("SCRIPTC_LIBNODE", "");
  const f = islandFixture();
  const result = f.prepare({ outputKind: "exe" });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((d) => d.code)).toEqual(["SC8005"]);
});

test("a cached island build is reused only while its libnode pack is unchanged", () => {
  const f = islandFixture();
  const pack = join(f.root, "..", "pack");
  mkdirSync(pack);
  writeFileSync(join(pack, "manifest.json"), '{"nodeVersion":"24.22.1","bridgeAbi":10}');
  vi.stubEnv("SCRIPTC_LIBNODE", pack);
  const first = f.prepare({ outputKind: "llvm" });
  expect(first.ok).toBe(true);
  const lowered = f.loads();
  const again = f.prepare({ outputKind: "llvm" });
  expect(f.loads()).toBe(lowered);
  expect(text(again)).toEqual(text(first));
  // The pack is replaced in place: same directory, another manifest.
  writeFileSync(join(pack, "manifest.json"), '{"nodeVersion":"24.22.2","bridgeAbi":10}');
  expect(f.prepare({ outputKind: "llvm" }).ok).toBe(true);
  expect(f.loads()).toBeGreaterThan(lowered);
  // An edit to an island module is an edit to the executable's contents.
  const before = f.loads();
  writeFileSync(f.moduleFile, 'exports.greet = (name) => "hi " + name; // edited\n');
  const edited = f.prepare({ outputKind: "llvm" });
  expect(f.loads()).toBeGreaterThan(before);
  expect(edited.ok && first.ok && edited.llvm.join("") !== first.llvm.join("")).toBe(true);
});
