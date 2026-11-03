import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Ts7Api } from "./rpc-api.js";
import {
  getPreEmitDiagnostics,
  Ts7Host,
  type Ts7ApiOptions,
  type Ts7CompilerOptions,
} from "./program-host.js";
import { ModuleDetectionKind, ModuleKind, ModuleResolutionKind, ScriptTarget } from "./enums.js";
import { tsgoPath } from "./session-path.js";

const directories: string[] = [];
const hosts: Ts7Host[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(): { directory: string; entry: string } {
  const directory = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-host-unit-"),
  );
  directories.push(directory);
  const entry = join(directory, "entry.ts");
  writeFileSync(entry, "export const answer = 42;\n");
  return { directory, entry };
}
function makeHost(directory: string): { host: Ts7Host; api: Ts7Api; connection: Ts7ApiOptions } {
  let connection!: Ts7ApiOptions;
  let api!: Ts7Api;
  const host = new Ts7Host(
    (options) => {
      connection = options;
      return (api = new Ts7Api(options));
    },
    { cwd: directory, collectTiming: true },
  );
  hosts.push(host);
  return { host, api, connection };
}

const options: Ts7CompilerOptions = { strict: true, noEmit: true, types: [] };

test("implementation discovery leaves declaration trees lazy without skipping their diagnostics", () => {
  const { directory, entry } = fixture();
  const declaration = join(directory, "types.d.ts");
  const unusual = join(directory, "styles.d.css.ts");
  writeFileSync(declaration, "declare const broken: MissingType;\n");
  writeFileSync(unusual, "declare const styles: string;\n");
  const { host } = makeHost(directory);
  const program = host.createProgram([entry, declaration, unusual], options);
  const fetch = vi.spyOn(program.project.program, "getSourceFile");
  const names = vi.spyOn(program.project.program, "getSourceFileNames");
  try {
    const files = program.getImplementationSourceFiles();
    expect(files.map((file) => file.fileName)).toEqual([tsgoPath(entry)]);
    expect(fetch.mock.calls.some(([name]) => String(name).endsWith(".d.ts"))).toBe(false);
    expect(program.getImplementationSourceFiles()).toBe(files);
    expect(names).toHaveBeenCalledTimes(1);
    expect(program.getSemanticDiagnostics().some((diagnostic) => diagnostic.code === 2304)).toBe(
      true,
    );
    expect(program.getSourceFile(declaration)?.isDeclarationFile).toBe(true);
    const all = program.getSourceFiles();
    expect(all.filter((file) => !file.isDeclarationFile)).toEqual(files);
    expect(all.find((file) => file.fileName === tsgoPath(entry))).toBe(files[0]);
    expect(names).toHaveBeenCalledTimes(1);
  } finally {
    program.dispose();
  }
  expect(() => program.getImplementationSourceFiles()).toThrow("disposed");
  expect(() => program.getSourceFileNames()).toThrow("disposed");
});

test("pre-emit diagnostics for kept files check only those, unless a global diagnostic appears", () => {
  const { directory, entry } = fixture();
  const other = join(directory, "other.ts");
  const later = join(directory, "later.ts");
  writeFileSync(
    entry,
    'import "./other.js";\nimport "./later.js";\nexport const n: number = "x";\n',
  );
  writeFileSync(other, "export const s: string = 1;\n");
  writeFileSync(later, "export const b: boolean = 0;\n");
  const { host } = makeHost(directory);
  const program = host.createProgram([entry], options);
  try {
    const full = getPreEmitDiagnostics(program);
    const keep = (name: string): boolean => name !== tsgoPath(other);
    const checked = vi.spyOn(program.project.program, "checkedFileDiagnosticData");
    const kept = getPreEmitDiagnostics(program, keep);
    // The full answer without the left-out file's diagnostics, in the same order.
    expect(full.some((diagnostic) => diagnostic.fileName === tsgoPath(other))).toBe(true);
    expect(kept.map((diagnostic) => [diagnostic.fileName, diagnostic.code])).toEqual(
      full
        .filter((diagnostic) => diagnostic.fileName === undefined || keep(diagnostic.fileName))
        .map((diagnostic) => [diagnostic.fileName, diagnostic.code]),
    );
    expect(kept).toHaveLength(2);
    expect(checked).toHaveBeenCalledTimes(1);
    expect(checked.mock.calls[0]![0]).not.toContain(tsgoPath(other));
    // Keeping every file is the full check.
    expect(getPreEmitDiagnostics(program, () => true)).toEqual(full);
    expect(checked).toHaveBeenCalledTimes(1);
    // A global diagnostic from the partial check, or a server without it: the full check.
    for (const answer of [
      {
        files: [],
        global: [{ fileName: undefined, pos: 0, end: 0, code: 2318, category: 1, text: "global" }],
      },
      null,
    ]) {
      checked.mockReturnValueOnce(
        answer as ReturnType<typeof program.project.program.checkedFileDiagnosticData>,
      );
      expect(getPreEmitDiagnostics(program, keep)).toEqual(full);
    }
  } finally {
    program.dispose();
  }
});

test("the factory receives one connection with the host's filesystem and timing", () => {
  const { directory, entry } = fixture();
  const factory = vi.fn((connection: Ts7ApiOptions) => new Ts7Api(connection));
  const host = new Ts7Host(factory, { cwd: directory, collectTiming: true });
  hosts.push(host);
  const first = host.createProgram([entry], options);
  const second = host.createProgram([entry], options);
  try {
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]![0]).toMatchObject({ cwd: directory, collectTiming: true });
    expect(first.getSemanticDiagnostics()).toEqual([]);
    expect(second.getSemanticDiagnostics()).toEqual([]);
    expect(host.getTimingInfo().enabled).toBe(true);
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("virtual contents and virtual existence take precedence over real-path shadows", () => {
  const { directory, entry } = fixture();
  let connection!: Ts7ApiOptions;
  const host = new Ts7Host(
    (provided) => {
      connection = provided;
      return new Ts7Api(provided);
    },
    {
      cwd: directory,
      fsShadow: { readFile: () => "\ufeffshadow", hideFile: (file) => file === entry },
    },
  );
  hosts.push(host);
  expect(connection.fs.readFile(entry)).toBeNull();
  expect(connection.fs.fileExists(entry)).toBe(false);
  host.addVirtualFile(entry, "\ufeffvirtual");
  expect(connection.fs.readFile(tsgoPath(entry))).toBe("virtual");
  expect(connection.fs.fileExists(tsgoPath(entry))).toBe(true);
  expect(connection.fs.realpath(tsgoPath(entry))).toBe(tsgoPath(entry));
  expect(connection.fs.readFile(join(directory, "replacement.ts"))).toBe("shadow");
});

test("filesystem fallthrough distinguishes empty content, missing files, and directories", () => {
  const { directory, entry } = fixture();
  const empty = join(directory, "empty.ts");
  writeFileSync(empty, "");
  mkdirSync(join(directory, "nested"));
  const { connection } = makeHost(directory);
  expect(connection.fs.readFile(empty)).toBe("");
  expect(connection.fs.readFile(entry + ".missing")).toBeNull();
  expect(connection.fs.fileExists(entry)).toBe(true);
  expect(connection.fs.directoryExists(directory)).toBe(true);
  expect(connection.fs.directoryExists(entry)).toBe(false);
  expect(connection.fs.getAccessibleEntries(directory)).toEqual({
    files: ["empty.ts", "entry.ts"],
    directories: ["nested"],
  });
  expect(connection.fs.getAccessibleEntries(entry + ".missing")).toEqual({
    files: [],
    directories: [],
  });
});

test("serializes the pinned enum options and library aliases without mutating input", () => {
  const { directory, entry } = fixture();
  const { host, connection, api } = makeHost(directory);
  const update = vi.spyOn(api, "updateSnapshot");
  const requested: Ts7CompilerOptions = {
    ...options,
    target: ScriptTarget.Latest,
    module: ModuleKind.ESNext,
    moduleResolution: ModuleResolutionKind.Bundler,
    moduleDetection: ModuleDetectionKind.Force,
    lib: ["lib.es2025.d.ts"],
    maxNodeModuleJsDepth: 2,
    paths: { "@app/*": ["src/*"] },
  };
  const program = host.createProgram([entry], requested);
  try {
    const config = update.mock.calls[0]![0]!.openProjects![0] as string;
    const serialized = JSON.parse(connection.fs.readFile(config)!);
    expect(serialized).toEqual({
      compilerOptions: {
        strict: true,
        noEmit: true,
        types: [],
        target: "esnext",
        module: "esnext",
        moduleResolution: "bundler",
        moduleDetection: "force",
        lib: ["es2025"],
        maxNodeModuleJsDepth: 2,
        paths: { "@app/*": ["src/*"] },
      },
      files: [entry],
      include: [],
    });
    expect(requested.lib).toEqual(["lib.es2025.d.ts"]);
    expect(requested.target).toBe(ScriptTarget.Latest);
  } finally {
    program.dispose();
  }
});

test("new snapshots see changed virtual sources while existing programs keep their source", () => {
  const { directory, entry } = fixture();
  const { host } = makeHost(directory);
  const valid = "export const answer: number = 42;\n";
  const invalid = 'export const answer: number = "wrong";\n';
  host.addVirtualFile(entry, valid);
  const first = host.createProgram([entry], options);
  const source = first.getSourceFile(entry)!;
  host.addVirtualFile(entry, invalid);
  const second = host.createProgram([entry], options);
  try {
    expect(second.getSourceFile(entry)!.text).toBe(invalid);
    expect(second.getSemanticDiagnostics().map((d) => d.code)).toContain(2322);
    expect(first.getSourceFile(entry)).toBe(source);
    expect(source.text).toBe(valid);
    expect(first.getSemanticDiagnostics()).toEqual([]);
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("new virtual imports invalidate previously missing module resolution", () => {
  const { directory, entry } = fixture();
  writeFileSync(entry, 'import { value } from "./new.js";\nexport const answer = value;\n');
  const { host } = makeHost(directory);
  const first = host.createProgram([entry], options);
  expect(first.getSemanticDiagnostics().map((d) => d.code)).toContain(2307);
  host.addVirtualFile(join(directory, "new.ts"), "export const value = 42;\n");
  const second = host.createProgram([entry], options);
  try {
    expect(second.getSemanticDiagnostics()).toEqual([]);
    expect(first.getSemanticDiagnostics().map((d) => d.code)).toContain(2307);
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("disposing a shared program retires its config and closes only that project on the next update", () => {
  const { directory, entry } = fixture();
  const { host, api, connection } = makeHost(directory);
  const update = vi.spyOn(api, "updateSnapshot");
  const first = host.createProgram([entry], options);
  const config = update.mock.calls[0]![0]!.openProjects![0] as string;
  first.dispose();
  first.dispose();
  expect(connection.fs.readFile(config)).toBeNull();
  const second = host.createProgram([entry], options);
  try {
    expect(update.mock.calls[1]![0]!.closeProjects).toEqual([config]);
    expect(update.mock.results[1]!.value.getProjects()).toHaveLength(1);
    expect(second.getSemanticDiagnostics()).toEqual([]);
  } finally {
    second.dispose();
  }
});

test("failed program updates retire their config and can be retried", () => {
  const { directory, entry } = fixture();
  const { host, api, connection } = makeHost(directory);
  const update = vi.spyOn(api, "updateSnapshot").mockImplementationOnce(() => {
    throw new Error("update failed");
  });
  expect(() => host.createProgram([entry], options)).toThrow("update failed");
  const failed = update.mock.calls[0]![0]!.openProjects![0] as string;
  expect(connection.fs.readFile(failed)).toBeNull();
  const program = host.createProgram([entry], options);
  try {
    expect(program.getSemanticDiagnostics()).toEqual([]);
  } finally {
    program.dispose();
  }
});

test("a program owning the host closes it even when snapshot release fails", () => {
  const { directory, entry } = fixture();
  const { host, api } = makeHost(directory);
  const update = vi.spyOn(api, "updateSnapshot");
  const close = vi.spyOn(api, "close");
  const program = host.createProgram([entry], options, true);
  const snapshot = update.mock.results[0]!.value;
  vi.spyOn(snapshot, "dispose").mockImplementationOnce(() => {
    throw new Error("release failed");
  });
  expect(() => program.dispose()).toThrow("release failed");
  expect(close).toHaveBeenCalledTimes(1);
  expect(() => host.createProgram([entry], options)).toThrow("closed");
  expect(() => program.getSourceFiles()).toThrow();
  program.dispose();
  expect(close).toHaveBeenCalledTimes(1);
});

test("closed hosts refuse every operation and release virtual contents", () => {
  const { directory, entry } = fixture();
  const { host, connection } = makeHost(directory);
  const virtual = join(directory, "virtual.ts");
  host.addVirtualFile(virtual, "export {};");
  host.close();
  host.close();
  expect(connection.fs.readFile(virtual)).toBeNull();
  expect(() => host.addVirtualFile(virtual, "again")).toThrow("closed");
  expect(() => host.parseConfigFile(entry)).toThrow("closed");
  expect(() => host.getTimingInfo()).toThrow("closed");
  expect(() => host.createProgram([entry], options)).toThrow("closed");
});

/** What a program answers that a reused host could answer stale: its file
 * list, each file's text, and its diagnostics. */
function answers(program: ReturnType<Ts7Host["createProgram"]>) {
  const names = [...program.getSourceFileNames()];
  return {
    names,
    texts: names.map((name) => program.getSourceFile(name)?.text),
    diagnostics: getPreEmitDiagnostics(program),
  };
}

test("a rebound host answers as a new host when shadows, disk files and in-memory files change", () => {
  const { directory, entry } = fixture();
  const dep = join(directory, "dep.ts");
  const extra = join(directory, "extra.d.ts");
  const virtual = join(directory, "virtual.ts");
  writeFileSync(
    entry,
    '/// <reference path="./extra.d.ts" />\nimport { value } from "./dep.js";\nimport { v } from "./virtual.js";\nexport const sum: number = value + extra + v;\n',
  );
  writeFileSync(dep, "export const value: number = 1;\n");
  writeFileSync(extra, "declare const extra: number;\n");
  // Load 1: dep.ts reads as a string-typed replacement, extra.d.ts is
  // hidden, and virtual.ts exists in memory only.
  const shadow = {
    readFile: (path: string) =>
      tsgoPath(path) === tsgoPath(dep) ? 'export const value: string = "1";\n' : undefined,
    hideFile: (path: string) => tsgoPath(path) === tsgoPath(extra),
  };
  const factory = vi.fn((connection: Ts7ApiOptions) => new Ts7Api(connection));
  const reused = new Ts7Host(factory, { cwd: directory, fsShadow: shadow }, () => {});
  hosts.push(reused);
  reused.addVirtualFile(virtual, "export const v = 2;\n");
  const first = reused.createProgram([entry], options);
  const firstAnswers = answers(first);
  first.dispose();
  expect(firstAnswers.diagnostics.map((d) => d.code).sort()).toEqual([2304, 2322, 6053]);
  // Load 2: no shadow, no in-memory file, and dep.ts changed on disk
  // without a change notification.
  writeFileSync(dep, "export const value: boolean = true;\n");
  reused.rebind(null);
  const second = reused.createProgram([entry], options);
  const fresh = makeHost(directory).host.createProgram([entry], options);
  try {
    expect(factory).toHaveBeenCalledTimes(1);
    expect(answers(second)).toEqual(answers(fresh));
    expect(
      answers(second)
        .diagnostics.map((d) => d.code)
        .sort(),
    ).toEqual([2307, 2365]);
  } finally {
    second.dispose();
    fresh.dispose();
  }
  // Load 3: the first load's shadow again answers as it did.
  writeFileSync(dep, "export const value: number = 1;\n");
  reused.rebind(shadow);
  reused.addVirtualFile(virtual, "export const v = 2;\n");
  const third = reused.createProgram([entry], options);
  try {
    expect(answers(third)).toEqual(firstAnswers);
  } finally {
    third.dispose();
  }
});

test("a reusable host returns to its owner on close and closes its connection only once", () => {
  const { directory, entry } = fixture();
  const released: Ts7Host[] = [];
  let api!: Ts7Api;
  const host = new Ts7Host(
    (connection) => (api = new Ts7Api(connection)),
    { cwd: directory },
    (h) => released.push(h),
  );
  hosts.push(host);
  const program = host.createProgram([entry], options);
  program.dispose();
  const close = vi.spyOn(api, "close");
  host.close();
  host.close();
  expect(released).toEqual([host]);
  expect(close).not.toHaveBeenCalled();
  // Still open: the next load rebinds it.
  host.rebind(null);
  expect(host.loads).toBe(2);
  host.createProgram([entry], options).dispose();
  host.closeConnection();
  host.close();
  expect(close).toHaveBeenCalledTimes(1);
  expect(() => host.createProgram([entry], options)).toThrow("closed");
});
