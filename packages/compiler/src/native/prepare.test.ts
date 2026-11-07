import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

/* Every kind of edit, against a cold build. A project is built, edited and
 * built again with the same cache, and the second build's whole frontend
 * output (the LLVM text, the link features, the sources and the warnings:
 * everything the backend compiles the executable from) must be the one a
 * build of the edited project with an empty cache produces. `reuse` says
 * whether the rebuild may answer from the cache without running the
 * frontend; a build that reuses when it must not would fail the
 * comparison, and one that runs the frontend when it need not fails the
 * count. */
type Files = Record<string, string>;

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, types: [], target: "esnext", module: "nodenext" },
});

function project(files: Files) {
  const temporary = mkdtempSync(join(tmpdir(), "scriptc-native-edits-"));
  scratch.push(temporary);
  const root = join(temporary, "project");
  const write = (directory: string, entries: Files): void => {
    for (const [name, text] of Object.entries(entries)) {
      mkdirSync(dirname(join(directory, name)), { recursive: true });
      writeFileSync(join(directory, name), text);
    }
  };
  write(root, { "tsconfig.json": TSCONFIG, "package.json": '{"type":"module"}', ...files });
  const toolchain = fixtureToolchain();
  let loads = 0;
  const frontend: FrontendFactory = (path, npmStatic, externalTypes) => {
    loads++;
    return runFrontend(path, loadProgram, npmStatic, externalTypes);
  };
  let caches = 0;
  const build = (
    directory: string,
    cache: NativeCache,
    extra: { optimization?: "release" | "dev"; strip?: boolean } = {},
  ) => {
    const input = prepareNativeExecutable(
      join(directory, "main.ts"),
      {
        outPath: join(directory, ".scriptc", "main"),
        outDir: join(directory, ".scriptc"),
        optimization: "release" as const,
        ...extra,
      },
      null,
      toolchain,
      frontend,
      cache,
    );
    if (!input.ok) throw new Error(JSON.stringify(input.diagnostics));
    return {
      llvm: input.llvm.join(""),
      features: input.features,
      sources: input.sources,
      warnings: input.warnings ?? [],
    };
  };
  const cache = new NativeCache(join(temporary, "cache"));
  const cold = () => new NativeCache(join(temporary, `cold-${caches++}`));
  return { root, temporary, write, build, cache, cold, loads: () => loads };
}

/** Builds `files`, applies `edit`, rebuilds with the same cache and compares
 * the rebuild with a cold build of the edited project. */
function rebuilt(
  files: Files,
  edit: Files,
  extra: { optimization?: "release" | "dev"; strip?: boolean } = {},
) {
  const p = project(files);
  const first = p.build(p.root, p.cache, extra);
  p.write(p.root, edit);
  const before = p.loads();
  const again = p.build(p.root, p.cache, extra);
  const frontendRuns = p.loads() - before;
  const fresh = p.build(p.root, p.cold(), extra);
  expect(again).toEqual(fresh);
  return { frontendRuns, changed: again.llvm !== first.llvm };
}

const MAIN = 'import { value } from "./value.js";\nconsole.log(value);\n';
const VALUE = 'export const value = "first";\n';

test.each([
  ["a comment appended", { "value.ts": VALUE + "// The exported value.\n" }],
  ["a comment at the top", { "value.ts": "// The exported value.\n" + VALUE }],
  ["a comment between tokens", { "value.ts": 'export const value = /* text */ "first";\n' }],
  ["blank lines and indentation", { "value.ts": '\n\n  export  const  value  =  "first" ;\n\n' }],
  ["a comment in the entry", { "main.ts": "/* entry */\n" + MAIN + "// end\n" }],
])("%s is answered from the cache, as a cold build would answer", (_name, edit) => {
  expect(rebuilt({ "main.ts": MAIN, "value.ts": VALUE }, edit)).toEqual({
    frontendRuns: 0,
    changed: false,
  });
});

test.each([
  ["a string literal", { "value.ts": 'export const value = "second";\n' }],
  [
    "a string literal that looks like a comment",
    { "value.ts": 'export const value = "// first";\n' },
  ],
  ["a comment the checker reads", { "value.ts": "// @ts-nocheck\n" + VALUE }],
  [
    "an import added",
    {
      "main.ts": 'import { other } from "./other.js";\n' + MAIN + "console.log(other);\n",
      "other.ts": "export const other = 2;\n",
    },
  ],
  ["an import removed", { "main.ts": 'console.log("no import");\n' }],
  [
    "a compiler option in tsconfig.json",
    {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          noUnusedLocals: true,
          types: [],
          target: "esnext",
          module: "nodenext",
        },
      }),
    },
  ],
  ["a field of package.json", { "package.json": '{"type":"module","name":"renamed"}' }],
])("%s runs the frontend again, and matches a cold build", (_name, edit) => {
  expect(rebuilt({ "main.ts": MAIN, "value.ts": VALUE }, edit).frontendRuns).toBe(1);
});

test("a file added beside a source it could stand for matches a cold build", () => {
  // `./value.js` names value.ts while there is no value.js; whichever the
  // resolver picks afterwards, the rebuild picks the same.
  rebuilt(
    { "main.ts": MAIN, "value.ts": VALUE },
    { "value.js": 'export const value = "from js";\n' },
  );
});

/* Whole-file text scans. The frontend decides some program-wide facts from a
 * file's raw text, comments included, so a comment can change the output. */
const AWAITS =
  'const value: any = JSON.parse("1");\nasync function main(): Promise<void> {\n  console.log(await value);\n}\nvoid main();\n';

test("a comment that a whole-file text scan matches runs the frontend again", () => {
  // The await of an untyped value adopts thenables only in a program whose
  // text can define one, and the scan for that reads comments too.
  const result = rebuilt(
    { "main.ts": AWAITS },
    { "main.ts": AWAITS + "// then: the value settles\n" },
  );
  expect(result).toEqual({ frontendRuns: 1, changed: true });
});

test("a comment that no text scan matches keeps the cached output of a scanned file", () => {
  const result = rebuilt({ "main.ts": AWAITS }, { "main.ts": AWAITS + "// the value settles\n" });
  expect(result).toEqual({ frontendRuns: 0, changed: false });
});

test("a string literal that a text scan matches runs the frontend again", () => {
  const result = rebuilt(
    { "main.ts": AWAITS },
    { "main.ts": AWAITS.replace('JSON.parse("1")', "JSON.parse('{\"then\":1}')") },
  );
  expect(result.frontendRuns).toBe(1);
});

/* Source text and positions the output carries. */
const ASSERTS = (call: string, tail = "") =>
  `import assert from "node:assert";\nexport const value = "first";\n${call};\n${tail}`;

test("a comment outside a call whose text the output carries keeps the cached output", () => {
  // A failing assert(value) reports its call's source text; nothing else of
  // the file's raw text is in the output.
  const result = rebuilt(
    { "main.ts": MAIN, "value.ts": ASSERTS("assert(value.length > 0)") },
    { "value.ts": "// checked below\n" + ASSERTS("assert(value.length > 0)", "// done\n") },
  );
  expect(result).toEqual({ frontendRuns: 0, changed: false });
});

test("whitespace inside a call whose text the output carries runs the frontend again", () => {
  const result = rebuilt(
    { "main.ts": MAIN, "value.ts": ASSERTS("assert(value.length > 0)") },
    { "value.ts": ASSERTS("assert(value.length  >  0)") },
  );
  expect(result).toEqual({ frontendRuns: 1, changed: true });
});

const TESTS = (gap: string, tail = "") =>
  `import { test } from "node:test";\nexport const value = "first";\n${gap}test("value", () => {});\n${tail}`;

test("a comment after a reported source line keeps the cached output", () => {
  // node:test reports the file, line and column of each test.
  const result = rebuilt(
    { "main.ts": MAIN, "value.ts": TESTS("") },
    { "value.ts": TESTS("", "// more tests to come\n") },
  );
  expect(result).toEqual({ frontendRuns: 0, changed: false });
});

test("a comment that moves a reported source line runs the frontend again", () => {
  const result = rebuilt(
    { "main.ts": MAIN, "value.ts": TESTS("") },
    { "value.ts": TESTS("// the only test\n") },
  );
  expect(result).toEqual({ frontendRuns: 1, changed: true });
});

test("a dev build is rebuilt when a comment moves a token, and matches a cold build", () => {
  const dev = { optimization: "dev" as const };
  expect(
    rebuilt({ "main.ts": MAIN, "value.ts": VALUE }, { "value.ts": "// lead\n" + VALUE }, dev)
      .frontendRuns,
  ).toBe(1);
  expect(
    rebuilt({ "main.ts": MAIN, "value.ts": VALUE }, { "value.ts": VALUE + "// trail\n" }, dev),
  ).toEqual({ frontendRuns: 0, changed: false });
});

test("a JavaScript dependency's comment is code, and its edit matches a cold build", () => {
  // JavaScript types come from JSDoc, so every comment of a .js file counts.
  const files = {
    "main.ts": 'import { twice } from "./twice.js";\nconsole.log(twice(2));\n',
    "twice.js": "/** @param {number} n */\nexport function twice(n) {\n  return n * 2;\n}\n",
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        types: [],
        target: "esnext",
        module: "nodenext",
        allowJs: true,
        checkJs: true,
      },
    }),
  };
  expect(
    rebuilt(files, {
      "twice.js":
        "/** @param {number} n */\nexport function twice(n) {\n  // doubled\n  return n * 2;\n}\n",
    }).frontendRuns,
  ).toBe(1);
  // Whitespace alone: reused or not, the output is a cold build's.
  rebuilt(files, {
    "twice.js": "/** @param {number} n */\nexport function twice(n) {\n    return n * 2;\n}\n",
  });
});

test("the same sources at another path are built for that path, as a cold build builds them", () => {
  const p = project({ "main.ts": MAIN, "value.ts": VALUE });
  const first = p.build(p.root, p.cache);
  const moved = join(p.temporary, "moved");
  cpSync(p.root, moved, { recursive: true });
  rmSync(join(moved, ".scriptc"), { recursive: true, force: true });
  const there = p.build(moved, p.cache);
  expect(p.loads()).toBe(2);
  expect(there).toEqual(p.build(moved, p.cold()));
  expect(there.sources.map(([path]) => path)).not.toEqual(first.sources.map(([path]) => path));
  // Each path keeps its own entry.
  expect(p.build(p.root, p.cache)).toEqual(first);
  expect(p.loads()).toBe(3);
});

test("an option or a variable that reaches the frontend selects another entry", () => {
  const p = project({ "main.ts": MAIN, "value.ts": VALUE });
  const release = p.build(p.root, p.cache);
  const dev = p.build(p.root, p.cache, { optimization: "dev" });
  expect(p.loads()).toBe(2);
  expect(dev).toEqual(p.build(p.root, p.cold(), { optimization: "dev" }));
  expect(dev.llvm).not.toBe(release.llvm);
  vi.stubEnv("SCRIPTC_TEST_FRONTEND_KEY", "1");
  expect(p.build(p.root, p.cache)).toEqual(release);
  expect(p.loads()).toBe(4);
  vi.stubEnv("SCRIPTC_TEST_FRONTEND_KEY", undefined);
  expect(p.build(p.root, p.cache)).toEqual(release);
  expect(p.loads()).toBe(4);
});

test("an edit after an equivalent edit is compared with the edited text", () => {
  // The entry an equivalent edit refreshes holds the new text, and the
  // reads recorded for the old one no longer describe it.
  const p = project({ "main.ts": MAIN, "value.ts": ASSERTS("assert(value.length > 0)") });
  p.build(p.root, p.cache);
  p.write(p.root, { "value.ts": "// lead\n" + ASSERTS("assert(value.length > 0)") });
  p.build(p.root, p.cache);
  expect(p.loads()).toBe(1);
  // Whitespace inside the call the output carries, in the moved text.
  p.write(p.root, { "value.ts": "// lead\n" + ASSERTS("assert(value.length  >  0)") });
  const again = p.build(p.root, p.cache);
  expect(p.loads()).toBe(2);
  expect(again).toEqual(p.build(p.root, p.cold()));
});

test("a rebuild that runs the frontend says why on its timing line", () => {
  const p = project({ "main.ts": AWAITS });
  p.build(p.root, p.cache);
  p.write(p.root, { "main.ts": AWAITS + "// then: the value settles\n" });
  const phases: [string, Record<string, unknown> | undefined][] = [];
  const input = prepareNativeExecutable(
    join(p.root, "main.ts"),
    {
      outPath: join(p.root, ".scriptc", "main"),
      outDir: join(p.root, ".scriptc"),
      optimization: "release",
    },
    null,
    fixtureToolchain(),
    (path, npmStatic, externalTypes) => runFrontend(path, loadProgram, npmStatic, externalTypes),
    p.cache,
    (phase, detail) => phases.push([phase, detail]),
  );
  expect(input.ok).toBe(true);
  const miss = phases.find(([phase]) => phase === "frontend-cache-miss");
  expect(miss?.[1]?.["reason"]).toMatch(
    /main\.ts: the frontend asked of the text whether \/.*then.*\/m matches it/,
  );
});

test("a line break added between two tokens runs the frontend again", () => {
  // Automatic semicolon insertion depends on line breaks between tokens.
  const result = rebuilt(
    { "main.ts": MAIN, "value.ts": VALUE },
    { "value.ts": 'export const value =\n  "first";\n' },
  );
  expect(result).toEqual({ frontendRuns: 1, changed: false });
});

/* Warnings. A cached build's warnings are reported again by a rebuild that
 * reuses it, and they point into source text. */
const HOT = [
  "export function total(values: any): number {",
  "  let sum = 0;",
  "  for (const value of values) sum += value;",
  "  return sum;",
  "}",
  "",
].join("\n");
const WARNED = {
  "main.ts":
    'import { total } from "./hot.js";\nimport { value } from "./value.js";\nconsole.log(total([1, 2, 3]), value);\n',
  "hot.ts": HOT,
  "value.ts": VALUE,
};

test("a build with warnings is reused after an edit of a file no warning names", () => {
  const p = project(WARNED);
  const first = p.build(p.root, p.cache);
  // The program must warn for this test to mean anything.
  expect(first.warnings.map((warning) => [warning.code, warning.loc.file])).toEqual([
    ["SC6101", join(p.root, "hot.ts")],
  ]);
  expect(rebuilt(WARNED, { "value.ts": "// The exported value.\n" + VALUE })).toEqual({
    frontendRuns: 0,
    changed: false,
  });
});

test("an edit of a file a warning names runs the frontend again", () => {
  // The warning's location is offsets into the file, which the comment moves.
  const result = rebuilt(WARNED, { "hot.ts": "// Sums untyped values.\n" + HOT });
  expect(result).toEqual({ frontendRuns: 1, changed: false });
});

/* Import elision. The project's tsconfig does not set `verbatimModuleSyntax`,
 * so an import no value use reaches is dropped as tsc drops it
 * (import-elision.ts) and the file is compiled in a rewritten form: the
 * dropped bindings blanked, type-only declarations after its last line. The
 * rewrite is a recorded read of the file, so an edit of comments or
 * whitespace is still answered from the cache, and an edit that changes
 * what is dropped is not. */
const SHAPES =
  "export interface Shape {\n  sides: number;\n}\nexport const square: Shape = { sides: 4 };\n";
const LABELS = 'export class Label {\n  text = "plain";\n}\nconsole.log("labels loaded");\n';
const DRAW = [
  'import { Shape, square } from "./shapes.js";',
  'import { Label } from "./labels.js";',
  "export function draw(label: Label | null): string {",
  "  const shape: Shape = square;",
  '  return `${label === null ? "none" : label.text} ${shape.sides}`;',
  "}",
  "",
].join("\n");
const ELIDED = {
  "main.ts": 'import { draw } from "./draw.js";\nconsole.log(draw(null));\n',
  "draw.ts": DRAW,
  "shapes.ts": SHAPES,
  "labels.ts": LABELS,
};

test("the edit cases below are of a program with elided imports", () => {
  const p = project(ELIDED);
  // The module imported only for its type is not part of the program, and
  // the build's record of draw.ts is the file as written.
  const first = p.build(p.root, p.cache);
  expect(first.llvm).not.toContain("labels loaded");
  expect(new Map(first.sources).get(join(p.root, "draw.ts"))).toBe(DRAW);
  // Under Node's rule the same import loads the module.
  const verbatim = project({
    ...ELIDED,
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        types: [],
        target: "esnext",
        module: "nodenext",
        verbatimModuleSyntax: true,
      },
    }),
    "draw.ts": DRAW.replace("{ Shape, square }", "{ type Shape, square }"),
  });
  expect(verbatim.build(verbatim.root, verbatim.cache).llvm).toContain("labels loaded");
});

test.each([
  ["a comment appended", { "draw.ts": DRAW + "// Draws one shape.\n" }],
  ["a comment at the top", { "draw.ts": "// Draws one shape.\n" + DRAW }],
  [
    "a comment inside a dropped import",
    { "draw.ts": DRAW.replace("{ Label }", "{ /* a class */ Label }") },
  ],
  [
    "a comment beside a dropped binding",
    { "draw.ts": DRAW.replace("{ Shape, square }", "{ Shape /* a type */, square }") },
  ],
  [
    "a comment between a dropped import and a kept one",
    { "draw.ts": DRAW.replace("\nimport { Label }", "\n/* labels */\nimport { Label }") },
  ],
  ["blank lines and indentation", { "draw.ts": "\n\n" + DRAW.replaceAll("\n", "\n  ") + "\n" }],
  ["a final line break removed", { "draw.ts": DRAW.slice(0, -1) }],
  ["a comment in the module imported for its type", { "labels.ts": "// Labels.\n" + LABELS }],
  ["a comment in the entry", { "main.ts": "/* entry */\n" + ELIDED["main.ts"] + "// end\n" }],
])(
  "%s of a program with elided imports is answered from the cache, as a cold build would answer",
  (_name, edit) => {
    expect(rebuilt(ELIDED, edit)).toEqual({ frontendRuns: 0, changed: false });
  },
);

test.each([
  [
    "a value use of a binding that was dropped",
    {
      "draw.ts": DRAW.replace('"none"', "new Label().text"),
    },
    true,
  ],
  [
    "a `type` modifier added to a dropped binding",
    { "draw.ts": DRAW.replace("{ Shape, square }", "{ type Shape, square }") },
    false,
  ],
  [
    "`import type` written for a dropped import",
    { "draw.ts": DRAW.replace("import { Label }", "import type { Label }") },
    false,
  ],
  [
    "a side-effect import of the module that was dropped",
    { "draw.ts": 'import "./labels.js";\n' + DRAW },
    true,
  ],
  [
    "a comment the checker reads",
    { "draw.ts": DRAW.replace("  const shape", "  // @ts-ignore\n  const shape") },
    false,
  ],
  ["a comment that turns the checker off", { "draw.ts": "// @ts-nocheck\n" + DRAW }, false],
  ["a reference directive", { "draw.ts": '/// <reference path="./shapes.ts" />\n' + DRAW }, false],
  [
    "verbatimModuleSyntax set in tsconfig.json",
    {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          types: [],
          target: "esnext",
          module: "nodenext",
          verbatimModuleSyntax: true,
        },
      }),
      "draw.ts": DRAW.replace("{ Shape, square }", "{ type Shape, square }"),
    },
    true,
  ],
])(
  "%s runs the frontend again in a program with elided imports, and matches a cold build",
  (_name, edit, changed) => {
    expect(rebuilt(ELIDED, edit)).toEqual({ frontendRuns: 1, changed });
  },
);

test("a `type` modifier removed from an import runs the frontend again", () => {
  const written = {
    ...ELIDED,
    "draw.ts": DRAW.replace("import { Label }", "import type { Label }"),
  };
  expect(rebuilt(written, { "draw.ts": DRAW })).toEqual({ frontendRuns: 1, changed: false });
});

test("a dev build of a program with elided imports keeps its output while every token stays in place", () => {
  const dev = { optimization: "dev" as const };
  // A comment's text within its line.
  const noted = DRAW.replace("  const shape", "  /* one */ const shape");
  expect(
    rebuilt(
      { ...ELIDED, "draw.ts": noted },
      { "draw.ts": noted.replace("/* one */", "/* two */") },
      dev,
    ),
  ).toEqual({ frontendRuns: 0, changed: false });
  // A line after the last token moves the declarations the elision adds
  // after the text, and they have positions too.
  expect(rebuilt(ELIDED, { "draw.ts": DRAW + "// Draws one shape.\n" }, dev).frontendRuns).toBe(1);
  expect(rebuilt(ELIDED, { "draw.ts": "// lead\n" + DRAW }, dev).frontendRuns).toBe(1);
});

test("an edit after an equivalent edit of a file with elided imports is compared with the edited text", () => {
  const p = project(ELIDED);
  const first = p.build(p.root, p.cache);
  const moved = "// lead\n\n" + DRAW.replace("{ Label }", "{ /* a class */ Label }");
  p.write(p.root, { "draw.ts": moved });
  const again = p.build(p.root, p.cache);
  expect(p.loads()).toBe(1);
  expect(again.llvm).toBe(first.llvm);
  expect(new Map(again.sources).get(join(p.root, "draw.ts"))).toBe(moved);
  // A second comment edit of the moved text is still answered.
  p.write(p.root, { "draw.ts": moved + "// end\n" });
  p.build(p.root, p.cache);
  expect(p.loads()).toBe(1);
  // And a value use of the dropped binding in it is not.
  p.write(p.root, { "draw.ts": moved.replace('"none"', "new Label().text") });
  const used = p.build(p.root, p.cache);
  expect(p.loads()).toBe(2);
  expect(used).toEqual(p.build(p.root, p.cold()));
  expect(used.llvm).toContain("labels loaded");
});

/* An enum another file can name is looked for in every file of the program
 * (enum-objects.ts): whether a file's text names it is a question the entry
 * records and asks again, not a read of the whole text. */
const COLORS = {
  "main.ts":
    'import { Color, keys } from "./color.js";\nimport { value } from "./value.js";\nconsole.log(keys(Color), Color.Green, value);\n',
  "color.ts":
    'export enum Color {\n  Red,\n  Green,\n}\nexport function keys(colors: object): string {\n  return Object.keys(colors).join(",");\n}\n',
  "value.ts": VALUE,
};

test("a comment edit is answered from the cache in a program that declares an exported enum", () => {
  // In a file that does not name the enum, and in the files that do.
  for (const edit of [
    { "value.ts": "// The exported value.\n" + VALUE },
    { "main.ts": "/* entry */\n" + COLORS["main.ts"] + "// end\n" },
    { "color.ts": COLORS["color.ts"] + "// The colors.\n" },
  ])
    expect(rebuilt(COLORS, edit)).toEqual({ frontendRuns: 0, changed: false });
});

test("a comment that names an exported enum in a file that did not runs the frontend again", () => {
  // The text now names the enum, and the lookup goes on to its identifiers:
  // there is none, and the output is the same.
  expect(rebuilt(COLORS, { "value.ts": "// Not a Color.\n" + VALUE })).toEqual({
    frontendRuns: 1,
    changed: false,
  });
});
