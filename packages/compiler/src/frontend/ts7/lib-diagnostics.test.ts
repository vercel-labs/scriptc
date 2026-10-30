import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";
import type { SourceFile } from "./ast-types.js";
import {
  prebuiltLibDiagnosticsText,
  readPrebuiltLibDiagnostics,
  recordPrebuiltLibDiagnostics,
  reusedKeptLibDiagnostics,
  reusedLibDiagnostics,
  setLibDiagnosticsStore,
  type LibDiagnosticsStore,
  type PrebuiltLibDiagnostics,
  type SuppliedKind,
} from "./lib-diagnostics.js";
import { hostTscTsExecutable } from "./checker-backend.js";
import type { Ts7DiagnosticData } from "./session-schema.generated.js";
import type { Ts7CheckedFileDiagnosticData, Ts7SessionProgram } from "./session.js";
import { closeSourceParser, parseSourceFile } from "./source-parser-node.js";

const dir = mkdtempSync(join(tmpdir(), "scriptc-lib-diagnostics-"));
const lib = join(dir, "lib.es5.d.ts");
const fallback = join(dir, "scriptc-node-fallback.d.ts");
const libText = "declare var NaN: number;\ninterface Array<T> { length: number }\n";
const fallbackText = "export {};\ndeclare global {\n  var process: { argv: string[] };\n}\n";
writeFileSync(lib, libText);
writeFileSync(fallback, fallbackText);
const main = join(dir, "main.ts");
const util = join(dir, "\u{1F600}.ts");
const other = join(dir, "�.ts");

afterEach(() => {
  setLibDiagnosticsStore(null);
  recordPrebuiltLibDiagnostics(null);
});
afterAll(() => {
  closeSourceParser();
  rmSync(dir, { recursive: true, force: true });
});

function memoryStore(): LibDiagnosticsStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    read: (key) => entries.get(key) ?? null,
    write: (key, text) => void entries.set(key, text),
  };
}

function diagnostic(fileName: string | undefined, pos: number, code = 2322): Ts7DiagnosticData {
  return { fileName, pos, end: pos + 1, code, category: 1, text: `at ${pos}` };
}

/** A session program whose full-check and checked-file answers are given; it
 * records which requests it was asked. */
function sessionProgram(answers: {
  semantic: Map<string, Ts7DiagnosticData[]>;
  global?: Ts7DiagnosticData[];
  checked?: boolean;
  options?: Record<string, unknown>;
}): Ts7SessionProgram & { asked: string[] } {
  const asked: string[] = [];
  const all = [...answers.semantic.values()].flat();
  return {
    asked,
    getCompilerOptions: () => answers.options ?? { strict: true },
    diagnosticData: (method: string, file?: string) => {
      asked.push(file === undefined ? method : `${method} ${file}`);
      if (method === "getGlobalDiagnostics") return answers.global ?? [];
      return file === undefined ? all : (answers.semantic.get(file) ?? []);
    },
    checkedFileDiagnosticData: (files: readonly string[]): Ts7CheckedFileDiagnosticData | null => {
      asked.push(`checked ${files.join(",")}`);
      if (answers.checked === false) return null;
      return { files: files.map((file) => answers.semantic.get(file) ?? []), global: [] };
    },
  } as unknown as Ts7SessionProgram & { asked: string[] };
}

/** The program's files, parsed: the supplied two and the given others. */
function files(texts: Record<string, string>): (name: string) => SourceFile | undefined {
  const parsed = new Map<string, SourceFile>([
    [lib, parseSourceFile(lib, libText, "ts")],
    [fallback, parseSourceFile(fallback, fallbackText, "ts")],
  ]);
  for (const [name, text] of Object.entries(texts))
    parsed.set(name, parseSourceFile(name, text, "ts"));
  return (name) => parsed.get(name);
}

const names = [lib, fallback, main];
const supplied = (name: string): boolean => name === lib || name === fallback;
const moduleFile = files({ [main]: "export const n: number = 'x';\n" });

test("without a store the full check answers", () => {
  const program = sessionProgram({ semantic: new Map() });
  expect(reusedLibDiagnostics(program, names, supplied, moduleFile)).toBeNull();
  expect(program.asked).toEqual([]);
});

test("a stored answer stands in for checking the supplied files, merged by file name", () => {
  const store = memoryStore();
  setLibDiagnosticsStore(store, "checker");
  const semantic = new Map([
    [lib, [diagnostic(lib, 1)]],
    [fallback, []],
    [main, [diagnostic(main, 5), diagnostic(main, 9)]],
  ]);
  const first = sessionProgram({ semantic });
  const full = reusedLibDiagnostics(first, names, supplied, moduleFile);
  // The first build runs the full check and stores the supplied files' answers.
  expect(first.asked).toEqual([
    "getGlobalDiagnostics",
    "getSemanticDiagnostics",
    "checked ",
    `getSemanticDiagnostics ${lib}`,
    `getSemanticDiagnostics ${fallback}`,
  ]);
  expect(store.entries.size).toBe(1);
  const second = sessionProgram({ semantic });
  const reused = reusedLibDiagnostics(second, names, supplied, moduleFile);
  expect(second.asked).toEqual([`checked ${main}`]);
  // The files' diagnostics in the order of their names (lib.es5.d.ts, main.ts), as the full answer.
  expect(reused).toEqual({
    semantic: [diagnostic(lib, 1), diagnostic(main, 5), diagnostic(main, 9)],
    global: [],
  });
  expect(full?.semantic).toEqual(reused?.semantic);
});

test("with kept files, a stored answer needs checking only the kept other files", () => {
  const store = memoryStore();
  setLibDiagnosticsStore(store, "checker");
  const pkg = join(dir, "node_modules", "pkg", "index.d.ts");
  const semantic = new Map([
    [lib, [diagnostic(lib, 1)]],
    [fallback, []],
    [main, [diagnostic(main, 5)]],
    [pkg, [diagnostic(pkg, 3)]],
  ]);
  const withPackage = files({
    [main]: "export const n: number = 'x';\n",
    [pkg]: "export declare const p: number;\n",
  });
  const all = [lib, fallback, main, pkg];
  const keep = new Set([lib, fallback, main]);
  // Without a stored answer nothing is checked or stored.
  const cold = sessionProgram({ semantic });
  expect(reusedKeptLibDiagnostics(cold, all, supplied, withPackage, keep)).toBeNull();
  expect(cold.asked).toEqual([]);
  expect(store.entries.size).toBe(0);
  reusedLibDiagnostics(sessionProgram({ semantic }), all, supplied, withPackage);
  expect(store.entries.size).toBe(1);
  const warm = sessionProgram({ semantic });
  expect(reusedKeptLibDiagnostics(warm, all, supplied, withPackage, keep)).toEqual({
    semantic: [diagnostic(lib, 1), diagnostic(main, 5)],
    global: [],
  });
  expect(warm.asked).toEqual([`checked ${main}`]);
  // A left-out file that can declare something global still prevents reuse.
  const augmenting = files({
    [main]: "export const n: number = 'x';\n",
    [pkg]: "export {};\ndeclare global {\n  var NaN: number;\n}\n",
  });
  const blocked = sessionProgram({ semantic });
  expect(reusedKeptLibDiagnostics(blocked, all, supplied, augmenting, keep)).toBeNull();
  expect(blocked.asked).toEqual([]);
});

test("files merge in code point order, which differs from UTF-16 order", () => {
  const store = memoryStore();
  setLibDiagnosticsStore(store, "checker");
  const all = [lib, fallback, util, other];
  const sources = files({ [util]: "export {};\n", [other]: "export {};\n" });
  const semantic = new Map([
    [util, [diagnostic(util, 1)]],
    [other, [diagnostic(other, 2)]],
  ]);
  reusedLibDiagnostics(sessionProgram({ semantic }), all, supplied, sources);
  const reused = reusedLibDiagnostics(sessionProgram({ semantic }), all, supplied, sources);
  // U+FFFD sorts before U+1F600 by code point (its surrogates sort after it by UTF-16 unit).
  expect(reused?.semantic).toEqual([diagnostic(other, 2), diagnostic(util, 1)]);
});

test("a full check with global diagnostics is not stored", () => {
  const store = memoryStore();
  setLibDiagnosticsStore(store, "checker");
  const program = sessionProgram({
    semantic: new Map([[main, [diagnostic(main, 1)]]]),
    global: [diagnostic(undefined, 0, 2318)],
  });
  expect(reusedLibDiagnostics(program, names, supplied, moduleFile)?.global).toEqual([
    diagnostic(undefined, 0, 2318),
  ]);
  expect(store.entries.size).toBe(0);
});

test("scripts reuse the answer unless they declare a global the supplied files declare", () => {
  const store = memoryStore();
  setLibDiagnosticsStore(store, "checker");
  const semantic = new Map([[main, []]]);
  // A script declaring only new names: it stores the answer, and a later one reuses it.
  const fresh = files({
    [main]: "const total = 1;\nfunction run() {}\nif (total) { var later = 2; }\n",
  });
  reusedLibDiagnostics(sessionProgram({ semantic }), names, supplied, fresh);
  expect(store.entries.size).toBe(1);
  const again = sessionProgram({ semantic });
  expect(reusedLibDiagnostics(again, names, supplied, fresh)).not.toBeNull();
  expect(again.asked).toEqual([`checked ${main}`]);
  // Scripts declaring a supplied global, at the top level, in a block, in a
  // `declare global` of a supplied module, or an ambient module: the full check.
  for (const text of [
    "interface Array<T> { extra: T }\n",
    "if (true) { var NaN = 1; }\n",
    "declare var process: unknown;\n",
    'declare module "fs" {}\n',
  ]) {
    const program = sessionProgram({ semantic });
    const result = reusedLibDiagnostics(program, names, supplied, files({ [main]: text }));
    expect(program.asked[0], text).not.toBe(`checked ${main}`);
    if (result !== null) expect(program.asked[0]).toBe("getGlobalDiagnostics");
  }
  expect(store.entries.size).toBe(1);
});

test("a program whose script declares a supplied global does not store its answer", () => {
  const store = memoryStore();
  setLibDiagnosticsStore(store, "checker");
  const program = sessionProgram({ semantic: new Map([[main, []]]) });
  reusedLibDiagnostics(program, names, supplied, files({ [main]: "declare var NaN: number;\n" }));
  expect(store.entries.size).toBe(0);
});

test("modules that can declare something global, and servers without the method, ask as before", () => {
  const store = memoryStore();
  setLibDiagnosticsStore(store, "checker");
  const semantic = new Map([[main, []]]);
  reusedLibDiagnostics(sessionProgram({ semantic }), names, supplied, moduleFile);
  expect(store.entries.size).toBe(1);
  for (const text of [
    "export {};\ndeclare global { var extra: number }\n",
    'export {};\ndeclare module "./other" { const extra: number }\n',
    "export as namespace Lib;\nexport const n = 1;\n",
  ]) {
    const program = sessionProgram({ semantic });
    expect(reusedLibDiagnostics(program, names, supplied, files({ [main]: text }))).toBeNull();
    expect(program.asked).toEqual([]);
  }
  const old = sessionProgram({ semantic, checked: false });
  expect(reusedLibDiagnostics(old, names, supplied, moduleFile)).toBeNull();
  // Nor does a server without the method store an answer it could not use.
  const fresh = memoryStore();
  setLibDiagnosticsStore(fresh, "checker");
  reusedLibDiagnostics(sessionProgram({ semantic, checked: false }), names, supplied, moduleFile);
  expect(fresh.entries.size).toBe(0);
});

test("a supplied file that changes is a different entry", () => {
  const store = memoryStore();
  setLibDiagnosticsStore(store, "checker");
  const semantic = new Map([[main, []]]);
  reusedLibDiagnostics(sessionProgram({ semantic }), names, supplied, moduleFile);
  writeFileSync(fallback, fallbackText + "// edited\n");
  const program = sessionProgram({ semantic });
  reusedLibDiagnostics(program, names, supplied, moduleFile);
  expect(program.asked[0]).toBe("getGlobalDiagnostics");
  expect(store.entries.size).toBe(2);
  writeFileSync(fallback, fallbackText);
});

/** The program's files, recording which ones were read. */
function recording(texts: Record<string, string>): ((name: string) => SourceFile | undefined) & {
  read: string[];
} {
  const inner = files(texts);
  const read: string[] = [];
  return Object.assign((name: string) => (read.push(name), inner(name)), { read });
}

test("a program of modules stores its answer without reading the supplied files", () => {
  const store = memoryStore();
  setLibDiagnosticsStore(store, "checker");
  const sources = recording({ [main]: "export const n: number = 'x';\n" });
  reusedLibDiagnostics(
    sessionProgram({ semantic: new Map([[main, []]]) }),
    names,
    supplied,
    sources,
  );
  expect(sources.read).toEqual([main]);
  const [text] = [...store.entries.values()];
  expect(JSON.parse(text!).globals).toBeNull();
  // A later program of modules reuses it, again without reading them.
  const again = recording({ [main]: "export const n: number = 'x';\n" });
  const program = sessionProgram({ semantic: new Map([[main, []]]) });
  expect(reusedLibDiagnostics(program, names, supplied, again)).not.toBeNull();
  expect(program.asked).toEqual([`checked ${main}`]);
  expect(again.read).toEqual([main]);
});

test("a script that uses an answer stored without global names collects and stores them", () => {
  const store = memoryStore();
  setLibDiagnosticsStore(store, "checker");
  const semantic = new Map([[main, []]]);
  reusedLibDiagnostics(sessionProgram({ semantic }), names, supplied, moduleFile);
  const script = recording({ [main]: "const total = 1;\n" });
  const program = sessionProgram({ semantic });
  expect(reusedLibDiagnostics(program, names, supplied, script)).not.toBeNull();
  expect(program.asked).toEqual([`checked ${main}`]);
  expect(script.read).toEqual([main, lib, fallback]);
  const [text] = [...store.entries.values()];
  expect(new Set(JSON.parse(text!).globals)).toEqual(new Set(["NaN", "Array", "process"]));
  // A script that declares one of them runs the full check, and the entry keeps its names.
  const clash = sessionProgram({ semantic });
  reusedLibDiagnostics(clash, names, supplied, files({ [main]: "declare var NaN: number;\n" }));
  expect(clash.asked[0]).toBe("getGlobalDiagnostics");
  expect(store.entries.size).toBe(1);
  expect(JSON.parse([...store.entries.values()][0]!).globals).not.toBeNull();
});

/** The content keys a full check of the program records, with checker release `checker`. */
function recorded(
  checker: string,
  semantic: Map<string, Ts7DiagnosticData[]>,
): PrebuiltLibDiagnostics {
  const keys = new Set<string>();
  recordPrebuiltLibDiagnostics({ checker, record: (key) => keys.add(key) });
  setLibDiagnosticsStore(memoryStore(), "build-time checker");
  reusedLibDiagnostics(sessionProgram({ semantic }), names, supplied, moduleFile);
  recordPrebuiltLibDiagnostics(null);
  return { checker, keys };
}

test("a prebuilt answer stands in for checking the supplied files in an empty store", () => {
  const semantic = new Map([[main, [diagnostic(main, 5)]]]);
  const prebuilt = recorded("1.0.0", semantic);
  expect(prebuilt.keys.size).toBe(1);
  // Another installation: its own store, its own checker identity.
  const store = memoryStore();
  setLibDiagnosticsStore(store, "installed checker", () => prebuilt);
  const program = sessionProgram({ semantic });
  expect(reusedLibDiagnostics(program, names, supplied, moduleFile)).toEqual({
    semantic: [diagnostic(main, 5)],
    global: [],
  });
  expect(program.asked).toEqual([`checked ${main}`]);
  // The answer is stored, so the next build reads it from the store.
  expect(store.entries.size).toBe(1);
  const next = sessionProgram({ semantic });
  setLibDiagnosticsStore(store, "installed checker", () => {
    throw new Error("the store answers first");
  });
  reusedLibDiagnostics(next, names, supplied, moduleFile);
  expect(next.asked).toEqual([`checked ${main}`]);
});

test("prebuilt answers apply only to the same checker release and file contents", () => {
  const semantic = new Map([[main, []]]);
  const prebuilt = recorded("1.0.0", semantic);
  const other: PrebuiltLibDiagnostics = { checker: "1.0.1", keys: prebuilt.keys };
  setLibDiagnosticsStore(memoryStore(), "installed checker", () => other);
  const release = sessionProgram({ semantic });
  reusedLibDiagnostics(release, names, supplied, moduleFile);
  expect(release.asked[0]).toBe("getGlobalDiagnostics");
  writeFileSync(fallback, fallbackText + "// edited\n");
  setLibDiagnosticsStore(memoryStore(), "installed checker", () => prebuilt);
  const edited = sessionProgram({ semantic });
  reusedLibDiagnostics(edited, names, supplied, moduleFile);
  expect(edited.asked[0]).toBe("getGlobalDiagnostics");
  writeFileSync(fallback, fallbackText);
});

test("options that cannot change the supplied files' diagnostics share their answers", () => {
  const store = memoryStore();
  setLibDiagnosticsStore(store, "checker");
  const semantic = new Map([
    [lib, [diagnostic(lib, 1)]],
    [main, [diagnostic(main, 5)]],
  ]);
  reusedLibDiagnostics(sessionProgram({ semantic }), names, supplied, moduleFile);
  expect(store.entries.size).toBe(1);
  // A project that also sets the options of OPTIONS_WITHOUT_SUPPLIED_DIAGNOSTICS checks only its own files.
  const unused = sessionProgram({
    semantic,
    options: {
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noImplicitReturns: true,
      noFallthroughCasesInSwitch: true,
      allowUnusedLabels: false,
      allowUnreachableCode: false,
      noUncheckedIndexedAccess: true,
      noPropertyAccessFromIndexSignature: true,
      allowSyntheticDefaultImports: true,
    },
  });
  expect(reusedLibDiagnostics(unused, names, supplied, moduleFile)?.semantic).toEqual([
    diagnostic(lib, 1),
    diagnostic(main, 5),
  ]);
  expect(unused.asked).toEqual([`checked ${main}`]);
  // Other options can change them: the answers stay apart.
  for (const options of [{ strict: false }, { strict: true, exactOptionalPropertyTypes: true }]) {
    const other = sessionProgram({ semantic, options });
    reusedLibDiagnostics(other, names, supplied, moduleFile);
    expect(other.asked[0]).toBe("getGlobalDiagnostics");
  }
});

test("a prebuilt answer recorded without a tsconfig serves a project setting those options", () => {
  const semantic = new Map([[main, [diagnostic(main, 5)]]]);
  const prebuilt = recorded("1.0.0", semantic);
  setLibDiagnosticsStore(memoryStore(), "installed checker", () => prebuilt);
  const program = sessionProgram({
    semantic,
    options: { strict: true, noUnusedLocals: true, noUncheckedIndexedAccess: true },
  });
  reusedLibDiagnostics(program, names, supplied, moduleFile);
  expect(program.asked).toEqual([`checked ${main}`]);
});

test("a full check that reports diagnostics in a supplied file records no prebuilt answer", () => {
  const prebuilt = recorded("1.0.0", new Map([[lib, [diagnostic(lib, 1)]]]));
  expect(prebuilt.keys.size).toBe(0);
});

test("prebuilt answer files round-trip, and a malformed one is no answer", () => {
  const path = join(dir, "lib-diagnostics.json");
  writeFileSync(path, prebuiltLibDiagnosticsText("1.0.0", ["b", "a", "b"]));
  expect(readPrebuiltLibDiagnostics(path)).toEqual({ checker: "1.0.0", keys: new Set(["a", "b"]) });
  writeFileSync(path, '{ "schema": "other", "checker": "1.0.0", "keys": [] }');
  expect(readPrebuiltLibDiagnostics(path)).toBeNull();
  expect(readPrebuiltLibDiagnostics(join(dir, "missing.json"))).toBeNull();
});

// Node module fallback files: ambient modules only, or one that also declares a global.
const moduleA = join(dir, "node-fallback-a.d.ts");
const moduleB = join(dir, "node-fallback-b.d.ts");
const moduleGlobal = join(dir, "node-fallback-global.d.ts");
const moduleTexts: Record<string, string> = {
  [moduleA]: 'declare module "node:a" {\n  export const a: number;\n}\n',
  [moduleB]: 'declare module "node:b" {\n  export const b: string;\n}\n',
  [moduleGlobal]:
    'declare module "node:g" {\n  global {\n    var g: number;\n  }\n  export {};\n}\n',
};
for (const [name, text] of Object.entries(moduleTexts)) writeFileSync(name, text);
const kind = (name: string): SuppliedKind =>
  name === lib ? "library" : name.includes("node-fallback-") ? "module" : "declarations";
const withModules = (...modules: string[]): string[] => [lib, fallback, ...modules, main];
const suppliedWithModules = (name: string): boolean => name !== main;
const moduleSources = files({ ...moduleTexts, [main]: "export const n: number = 'x';\n" });

test("a set with module files reuses the libs' answers of the set without them", () => {
  const store = memoryStore();
  setLibDiagnosticsStore(store, "checker");
  const semantic = new Map([
    [lib, [diagnostic(lib, 1)]],
    [main, [diagnostic(main, 5)]],
  ]);
  // Without an answer for the set without module files, a set with them checks in full.
  const first = sessionProgram({ semantic });
  reusedLibDiagnostics(first, withModules(moduleA), suppliedWithModules, moduleSources, kind);
  expect(first.asked[0]).toBe("getGlobalDiagnostics");
  const base = sessionProgram({ semantic });
  reusedLibDiagnostics(base, withModules(), suppliedWithModules, moduleSources, kind);
  expect(base.asked[0]).toBe("getGlobalDiagnostics");
  // That answer reports a diagnostic in a lib, so a set with another module file reuses the
  // libs' answers and checks the program, scriptc's declarations and that file.
  const second = sessionProgram({ semantic });
  const composed = reusedLibDiagnostics(
    second,
    withModules(moduleB),
    suppliedWithModules,
    moduleSources,
    kind,
  );
  expect(second.asked).toEqual([`checked ${main},${fallback},${moduleB}`]);
  expect(composed).toEqual({ semantic: [diagnostic(lib, 1), diagnostic(main, 5)], global: [] });
  // Its own answer is stored, so the same set then checks only the program.
  const third = sessionProgram({ semantic });
  reusedLibDiagnostics(third, withModules(moduleB), suppliedWithModules, moduleSources, kind);
  expect(third.asked).toEqual([`checked ${main}`]);
});

test("a clean answer of the set without module files stands in for all of its files", () => {
  const semantic = new Map([[main, []]]);
  const store = memoryStore();
  setLibDiagnosticsStore(store, "checker");
  reusedLibDiagnostics(
    sessionProgram({ semantic }),
    withModules(),
    suppliedWithModules,
    moduleSources,
    kind,
  );
  const fromBase = sessionProgram({ semantic });
  reusedLibDiagnostics(fromBase, withModules(moduleA), suppliedWithModules, moduleSources, kind);
  expect(fromBase.asked).toEqual([`checked ${main},${moduleA}`]);
  // So does a prebuilt answer for it.
  const keys = new Set<string>();
  recordPrebuiltLibDiagnostics({ checker: "1.0.0", record: (key) => keys.add(key) });
  setLibDiagnosticsStore(memoryStore(), "build-time checker");
  reusedLibDiagnostics(
    sessionProgram({ semantic }),
    withModules(),
    suppliedWithModules,
    moduleSources,
    kind,
  );
  recordPrebuiltLibDiagnostics(null);
  expect(keys.size).toBe(1);
  setLibDiagnosticsStore(memoryStore(), "installed checker", () => ({ checker: "1.0.0", keys }));
  const prebuilt = sessionProgram({ semantic });
  reusedLibDiagnostics(
    prebuilt,
    withModules(moduleA, moduleB),
    suppliedWithModules,
    moduleSources,
    kind,
  );
  expect(prebuilt.asked).toEqual([`checked ${main},${moduleA},${moduleB}`]);
});

test("scriptc's declarations are checked again when they report something or declare a module file's module", () => {
  const declared = join(dir, "scriptc-declared.d.ts");
  const moduleX = join(dir, "node-fallback-x.d.ts");
  const texts = {
    [declared]: 'declare module "node:x" {\n  export const x: number;\n}\n',
    [moduleX]: 'declare module "node:x" {\n  export const y: number;\n}\n',
  };
  for (const [name, text] of Object.entries(texts)) writeFileSync(name, text);
  const sources = files({ ...moduleTexts, ...texts, [main]: "export const n: number = 'x';\n" });
  const semantic = new Map([[main, []]]);
  setLibDiagnosticsStore(memoryStore(), "checker");
  const base = [lib, fallback, declared, main];
  const set = [lib, fallback, declared, moduleX, main];
  reusedLibDiagnostics(sessionProgram({ semantic }), base, suppliedWithModules, sources, kind);
  const merged = sessionProgram({ semantic });
  reusedLibDiagnostics(merged, set, suppliedWithModules, sources, kind);
  expect(merged.asked).toEqual([`checked ${main},${fallback},${declared},${moduleX}`]);
  // With a diagnostic in scriptc's declarations, only the libs' answers are reused.
  const reporting = new Map([
    [main, []],
    [fallback, [diagnostic(fallback, 3)]],
  ]);
  setLibDiagnosticsStore(memoryStore(), "checker");
  reusedLibDiagnostics(
    sessionProgram({ semantic: reporting }),
    withModules(),
    suppliedWithModules,
    moduleSources,
    kind,
  );
  const again = sessionProgram({ semantic: reporting });
  const answer = reusedLibDiagnostics(
    again,
    withModules(moduleA),
    suppliedWithModules,
    moduleSources,
    kind,
  );
  expect(again.asked).toEqual([`checked ${main},${fallback},${moduleA}`]);
  expect(answer?.semantic).toEqual([diagnostic(fallback, 3)]);
});

test("module files that declare something global, and programs with scripts, check in full", () => {
  const semantic = new Map([[main, []]]);
  const store = memoryStore();
  setLibDiagnosticsStore(store, "checker");
  reusedLibDiagnostics(
    sessionProgram({ semantic }),
    withModules(),
    suppliedWithModules,
    moduleSources,
    kind,
  );
  const global = sessionProgram({ semantic });
  reusedLibDiagnostics(global, withModules(moduleGlobal), suppliedWithModules, moduleSources, kind);
  expect(global.asked[0]).toBe("getGlobalDiagnostics");
  const other = sessionProgram({ semantic });
  reusedLibDiagnostics(
    other,
    withModules(moduleGlobal, moduleA),
    suppliedWithModules,
    moduleSources,
    kind,
  );
  expect(other.asked[0]).toBe("getGlobalDiagnostics");
  const script = sessionProgram({ semantic });
  const scriptSources = files({ ...moduleTexts, [main]: "const total = 1;\n" });
  reusedLibDiagnostics(script, withModules(moduleA), suppliedWithModules, scriptSources, kind);
  expect(script.asked[0]).toBe("getGlobalDiagnostics");
});

test("the TypeScript libs declare no ambient module and import none, so module files cannot reach them", () => {
  const libDir = dirname(hostTscTsExecutable());
  const libFiles = readdirSync(libDir).filter((name) => /^lib\..*\.d\.ts$/.test(name));
  expect(libFiles.length).toBeGreaterThan(50);
  for (const name of libFiles) {
    const text = readFileSync(join(libDir, name), "utf8");
    expect(text, name).not.toMatch(
      /\bmodule\s+["']|\bimport\s*\(\s*["']|\bfrom\s+["']|\brequire\s*\(/,
    );
  }
});
