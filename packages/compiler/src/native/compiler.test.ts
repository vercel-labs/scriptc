import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { NativeCompiler } from "./compiler.js";
import { selectNativeRuntimePack } from "../backend/runtime-pack-native.js";
import type { NativeToolchain } from "./toolchain.js";
import { runNativeFrontend } from "../frontend/pipeline-native.js";
import { trackedReadFile } from "../frontend/input-tracker.js";
import { emitNativeObject } from "../backend/native-tools.js";
import { LINUX_X64_GNU_TARGET, MACOS_ARM64_TARGET } from "../backend/targets.js";
import { VOID, type IrModule } from "../ir/ir.js";
import { contentDigest, NativeCache } from "./cache.js";
import { NativeExecutableCache, openNativeExecutableCache } from "./executable-cache.js";

vi.mock("../frontend/pipeline-native.js", () => ({ runNativeFrontend: vi.fn() }));
vi.mock("../backend/native-tools.js", async (original) => ({
  ...(await original<typeof import("../backend/native-tools.js")>()),
  emitNativeObject: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));
vi.mock("./executable-cache.js", async (original) => ({
  ...(await original<typeof import("./executable-cache.js")>()),
  openNativeExecutableCache: vi.fn(),
}));
/** The selection the runtime pack mock returns; a test that needs pack
 * artifacts replaces it. */
const runtimePack = vi.hoisted(() => ({
  selection: {
    root: "/nonexistent",
    licenses: [] as { path: string }[],
    packageText: "",
    manifestText: "",
    selected: {
      runtime: [] as { path: string }[],
      archives: [] as { path: string }[],
      data: [] as { path: string }[],
      systemLibraries: [] as string[],
    },
    flavor: "release",
  },
}));
vi.mock("../backend/runtime-pack-native.js", () => ({
  selectNativeRuntimePack: vi.fn(() => runtimePack.selection),
  stageNativeRuntimeSelection: () => ({ runtimeObjects: [], archives: [], systemLibraries: [] }),
}));

const directories: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  runtimePack.selection = {
    ...runtimePack.selection,
    root: "/nonexistent",
    licenses: [],
    selected: { runtime: [], archives: [], data: [], systemLibraries: [] },
  };
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

test.each([
  "traced",
  "empty trace",
  "failed trace",
  "changed input",
  "disabled",
  "failed link",
  "missing output",
] as const)("executable linking preserves the dependency trace contract: %s", (mode) => {
  const directory = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-native-link-"),
  );
  directories.push(directory);
  const sdk = join(directory, "sdk");
  mkdirSync(sdk);
  const library = join(sdk, "libSystem.tbd");
  writeFileSync(library, "system library");
  const entry = join(directory, "entry.ts");
  const output = join(directory, "program");
  const llvmPath = join(directory, "entry.ll");
  writeFileSync(output, "previous executable");
  writeFileSync(llvmPath, "previous LLVM");
  const module: IrModule = {
    irVersion: 17,
    sourceFile: entry,
    entry: "%main",
    functions: [
      {
        name: "%main",
        params: [],
        locals: [],
        body: [],
        returnType: VOID,
        loc: { file: entry, start: 0, end: 0 },
      },
    ],
  };
  vi.mocked(runNativeFrontend).mockReturnValue({
    preflight: [],
    entryText: () => "",
    entryExports: () => new Map(),
    entryContract: () => {
      throw new Error("unexpected contract request");
    },
    sourceTexts: () => new Map(),
    npmStatic: [],
    npmImportSites: new Map(),
    dispose: () => {},
    lower: () => ({
      module,
      diagnostics: [],
      runtimeFences: [],
      stats: {
        statementsTotal: 0,
        statementsFailed: 0,

        functionsSkipped: 0,
      },
    }),
  });
  vi.mocked(emitNativeObject).mockImplementation((options) => {
    writeFileSync(options.outputPath, "object");
    return { outputs: [options.outputPath], profileMatch: null };
  });
  const cache = new NativeCache(join(directory, "cache"));
  const key = contentDigest("executable link");
  const open = () => new NativeExecutableCache(cache, key, "clang", false, [library]);
  vi.mocked(openNativeExecutableCache).mockImplementation(() =>
    mode === "disabled" ? null : open(),
  );
  let tracedLinks = 0;
  let ordinaryLinks = 0;
  vi.mocked(spawnSync).mockImplementation((_command, args) => {
    const dry = args!.includes("-###");
    if (!dry) {
      expect(args).toContain("-Wl,-t");
      tracedLinks++;
      if (mode === "changed input") writeFileSync(library, "replacement system library");
      if (mode !== "missing output")
        writeFileSync(args![args!.indexOf("-o") + 1]!, "traced executable");
    }
    const failed = !dry && (mode === "failed trace" || mode === "failed link");
    return {
      pid: 1,
      status: failed ? 1 : 0,
      signal: null,
      output: [],
      stdout: mode === "empty trace" ? "" : library + "\n",
      stderr: failed ? "trace failed" : "",
    };
  });
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    ordinaryLinks++;
    expect(args).not.toContain("-Wl,-t");
    expect(args).not.toContain("-###");
    if (mode === "failed link") throw new Error("link failed");
    writeFileSync(args![args!.indexOf("-o") + 1]!, "ordinary executable");
    return "";
  });
  const target = MACOS_ARM64_TARGET;
  const compiler = new NativeCompiler({
    compilerVersion: "0.0.0",
    target,
    helper: target.helper,
    ts7Executable: "unused",
    helperExecutable: "unused",
    helperPackageRoot: "unused",
    runtimePackRoot: "unused",
    linker: "clang",
    linkerArgs: [],
    dsymutil: "unused",
  });
  const options = {
    outDir: directory,
    outPath: output,
    backend: "llvm",
    optimization: "release",
    strip: true,
  } as const;
  const result = compiler.compile(entry, options);
  expect(tracedLinks).toBe(mode === "disabled" ? 0 : 1);
  expect(ordinaryLinks).toBe(mode === "traced" || mode === "missing output" ? 0 : 1);
  if (mode === "failed link" || mode === "missing output") {
    expect(result.ok).toBe(false);
    expect(readFileSync(output, "utf8")).toBe("previous executable");
    expect(readFileSync(llvmPath, "utf8")).toBe("previous LLVM");
  } else {
    expect(result).toMatchObject({ ok: true, binaryPath: output });
    expect(readFileSync(output, "utf8")).toBe(
      mode === "traced" ? "traced executable" : "ordinary executable",
    );
    expect(readFileSync(llvmPath, "utf8")).toContain("define i32 @main");
  }
  expect(open().restore(join(directory, "restored"))).toBe(mode === "traced");
  if (mode === "traced") {
    // A second invocation must restore the actual traced executable without
    // invoking either the optimizer or the linker again.
    vi.mocked(emitNativeObject).mockClear();
    expect(compiler.compile(entry, options).ok).toBe(true);
    expect(readFileSync(output, "utf8")).toBe("traced executable");
    expect(emitNativeObject).not.toHaveBeenCalled();
    expect(tracedLinks).toBe(1);
    expect(ordinaryLinks).toBe(0);
  }
  expect(readdirSync(directory).filter((name) => name.startsWith(".scriptc-"))).toEqual([]);
});

test.each([false, true])(
  "object generation releases frontend resources and preserves outputs on failure (%s)",
  (fail) => {
    const directory = mkdtempSync(
      join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-native-driver-"),
    );
    directories.push(directory);
    const entry = join(directory, "entry.ts");
    const output = join(directory, "output.o");
    const llvmPath = output + ".ll";
    writeFileSync(output, "previous object");
    writeFileSync(llvmPath, "previous LLVM");
    const module: IrModule = {
      irVersion: 17,
      sourceFile: entry,
      entry: "%main",
      functions: [
        {
          name: "%main",
          params: [],
          locals: [],
          body: [],
          returnType: VOID,
          loc: { file: entry, start: 0, end: 0 },
        },
      ],
    };
    const dispose = vi.fn();
    vi.mocked(runNativeFrontend).mockReturnValue({
      preflight: [],
      entryText: () => "",
      entryExports: () => new Map(),
      entryContract: () => {
        throw new Error("unexpected contract request");
      },
      sourceTexts: () => new Map(),
      npmStatic: [],
      npmImportSites: new Map(),
      dispose,
      lower: () => ({
        module,
        diagnostics: [],
        runtimeFences: [],
        stats: {
          statementsTotal: 0,
          statementsFailed: 0,

          functionsSkipped: 0,
        },
      }),
    });
    let emitted = "";
    vi.mocked(emitNativeObject).mockImplementation((options) => {
      expect(dispose).toHaveBeenCalledTimes(1);
      emitted = readFileSync(options.inputPath, "utf8");
      expect(emitted).toContain("define i32 @main");
      if (fail) throw new Error("codegen failed");
      writeFileSync(options.outputPath, "new object");
      return { outputs: [options.outputPath], profileMatch: null };
    });
    const target = MACOS_ARM64_TARGET;
    const toolchain: NativeToolchain = {
      compilerVersion: "0.0.0",
      target,
      helper: target.helper,
      ts7Executable: "unused",
      helperExecutable: "unused",
      helperPackageRoot: "unused",
      runtimePackRoot: "unused",
      linker: "unused",
      linkerArgs: [],
      dsymutil: "unused",
    };
    const build = () =>
      new NativeCompiler(toolchain).compile(entry, {
        outDir: directory,
        outPath: output,
        backend: "llvm",
        outputKind: "obj",
        optimization: "release",
        strip: true,
      });
    if (fail) {
      expect(build()).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({ message: "codegen failed" })],
      });
      expect(readFileSync(output, "utf8")).toBe("previous object");
      expect(readFileSync(llvmPath, "utf8")).toBe("previous LLVM");
    } else {
      expect(build()).toMatchObject({ ok: true, artifact: { kind: "obj", path: output } });
      expect(readFileSync(output, "utf8")).toBe("new object");
      expect(emitted).toContain("define i32 @main");
      expect(readFileSync(llvmPath, "utf8")).toBe("previous LLVM");
    }
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(readdirSync(directory).sort()).toEqual(["output.o", "output.o.ll"]);
  },
);

test.skipIf(process.platform === "win32").each([false, true])(
  "Linux links use lld when the driver finds it, and the default linker when lld fails (%s)",
  (lldFails) => {
    const directory = mkdtempSync(join("/tmp", "scriptc-native-lld-"));
    directories.push(directory);
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const clang = join(bin, "clang");
    writeFileSync(clang, "#!/bin/sh\n");
    chmodSync(clang, 0o755);
    writeFileSync(join(bin, "ld.lld"), "#!/bin/sh\n");
    chmodSync(join(bin, "ld.lld"), 0o755);
    const entry = join(directory, "entry.ts");
    const output = join(directory, "program");
    const module: IrModule = {
      irVersion: 17,
      sourceFile: entry,
      entry: "%main",
      functions: [
        {
          name: "%main",
          params: [],
          locals: [],
          body: [],
          returnType: VOID,
          loc: { file: entry, start: 0, end: 0 },
        },
      ],
    };
    vi.mocked(runNativeFrontend).mockReturnValue({
      preflight: [],
      entryText: () => "",
      entryExports: () => new Map(),
      entryContract: () => {
        throw new Error("unexpected contract request");
      },
      sourceTexts: () => new Map(),
      npmStatic: [],
      npmImportSites: new Map(),
      dispose: () => {},
      lower: () => ({
        module,
        diagnostics: [],
        runtimeFences: [],
        stats: { statementsTotal: 0, statementsFailed: 0, functionsSkipped: 0 },
      }),
    });
    vi.mocked(emitNativeObject).mockImplementation((options) => {
      writeFileSync(options.outputPath, "object");
      return { outputs: [options.outputPath], profileMatch: null };
    });
    vi.mocked(openNativeExecutableCache).mockReturnValue(null);
    const links: string[][] = [];
    vi.mocked(execFileSync).mockImplementation((_command, args) => {
      const list = args as string[];
      links.push(list);
      if (lldFails && list.includes("-fuse-ld=lld")) throw new Error("lld failed");
      writeFileSync(list[list.indexOf("-o") + 1]!, "executable");
      return "";
    });
    const target = LINUX_X64_GNU_TARGET;
    const compiler = new NativeCompiler({
      compilerVersion: "0.0.0",
      target,
      helper: target.helper,
      ts7Executable: "unused",
      helperExecutable: "unused",
      helperPackageRoot: "unused",
      runtimePackRoot: "unused",
      linker: clang,
      linkerArgs: [],
      dsymutil: "unused",
    });
    const result = compiler.compile(entry, {
      outDir: directory,
      outPath: output,
      backend: "llvm",
      optimization: "release",
      strip: true,
    });
    expect(result).toMatchObject({ ok: true, binaryPath: output });
    expect(links[0]).toContain("-fuse-ld=lld");
    expect(links.length).toBe(lldFails ? 2 : 1);
    if (lldFails) expect(links[1]).not.toContain("-fuse-ld=lld");
  },
);

test.skipIf(process.platform === "win32")(
  "a --profile-use executable reports the helper's profile match",
  () => {
    const directory = mkdtempSync(join("/tmp", "scriptc-native-profile-"));
    directories.push(directory);
    const clang = join(directory, "clang");
    writeFileSync(clang, "#!/bin/sh\n");
    chmodSync(clang, 0o755);
    const entry = join(directory, "entry.ts");
    const output = join(directory, "program");
    const profile = join(directory, "app.profdata");
    writeFileSync(profile, "indexed profile");
    const module: IrModule = {
      irVersion: 17,
      sourceFile: entry,
      entry: "%main",
      functions: [
        {
          name: "%main",
          params: [],
          locals: [],
          body: [],
          returnType: VOID,
          loc: { file: entry, start: 0, end: 0 },
        },
      ],
    };
    vi.mocked(runNativeFrontend).mockReturnValue({
      preflight: [],
      entryText: () => "",
      entryExports: () => new Map(),
      entryContract: () => {
        throw new Error("unexpected contract request");
      },
      sourceTexts: () => new Map(),
      npmStatic: [],
      npmImportSites: new Map(),
      dispose: () => {},
      lower: () => ({
        module,
        diagnostics: [],
        runtimeFences: [],
        stats: { statementsTotal: 0, statementsFailed: 0, functionsSkipped: 0 },
      }),
    });
    const match = {
      annotated: 120,
      mismatched: 7,
      missing: 40,
      recovered: 0,
      unknownPartitions: 0,
    };
    vi.mocked(emitNativeObject).mockImplementation((options) => {
      expect(options.profile?.use?.path).toBe(profile);
      writeFileSync(options.outputPath, "object");
      return { outputs: [options.outputPath], profileMatch: match };
    });
    vi.mocked(openNativeExecutableCache).mockReturnValue(null);
    vi.mocked(execFileSync).mockImplementation((_command, args) => {
      const list = args as string[];
      writeFileSync(list[list.indexOf("-o") + 1]!, "executable");
      return "";
    });
    const target = LINUX_X64_GNU_TARGET;
    const compiler = new NativeCompiler({
      compilerVersion: "0.0.0",
      target,
      helper: target.helper,
      ts7Executable: "unused",
      helperExecutable: "unused",
      helperPackageRoot: "unused",
      runtimePackRoot: "unused",
      linker: clang,
      linkerArgs: [],
      dsymutil: "unused",
    });
    const result = compiler.compile(entry, {
      outDir: directory,
      outPath: output,
      backend: "llvm",
      optimization: "speed",
      profileUse: profile,
    });
    expect(result).toMatchObject({ ok: true, artifact: { kind: "exe", profileMatch: match } });
  },
);

test.skipIf(process.platform === "win32")(
  "an unchanged build keeps its executable without lowering the program again",
  () => {
    const directory = mkdtempSync(join("/tmp", "scriptc-native-unchanged-"));
    directories.push(directory);
    const tool = (name: string): string => {
      const path = join(directory, name);
      writeFileSync(path, "#!/bin/sh\n");
      chmodSync(path, 0o755);
      return path;
    };
    const helperRoot = join(directory, "helper");
    mkdirSync(helperRoot);
    writeFileSync(join(helperRoot, "package.json"), '{"name":"helper","version":"0.0.0"}');
    const packRoot = join(directory, "pack");
    mkdirSync(packRoot);
    writeFileSync(join(packRoot, "package.json"), '{"name":"pack","version":"0.0.0"}');
    // The link consumes one artifact of the pack.
    const archive = join(packRoot, "libruntime.a");
    writeFileSync(archive, "runtime archive");
    runtimePack.selection = {
      ...runtimePack.selection,
      root: packRoot,
      selected: {
        runtime: [],
        archives: [{ path: "libruntime.a" }],
        data: [],
        systemLibraries: [],
      },
    };
    const entry = join(directory, "entry.ts");
    writeFileSync(entry, "export const value = 1;\n");
    // The input probes only name a file's identity once it has settled.
    const settled = new Date(Date.now() - 60_000);
    utimesSync(entry, settled, settled);
    const output = join(directory, "program");
    const module: IrModule = {
      irVersion: 17,
      sourceFile: entry,
      entry: "%main",
      functions: [
        {
          name: "%main",
          params: [],
          locals: [],
          body: [],
          returnType: VOID,
          loc: { file: entry, start: 0, end: 0 },
        },
      ],
    };
    vi.mocked(runNativeFrontend).mockImplementation(() => {
      // The input tracker the compiler records probes in is running here.
      trackedReadFile(entry);
      return {
        preflight: [],
        entryText: () => "",
        entryExports: () => new Map(),
        entryContract: () => {
          throw new Error("unexpected contract request");
        },
        sourceTexts: () => new Map(),
        npmStatic: [],
        npmImportSites: new Map(),
        dispose: () => {},
        lower: () => ({
          module,
          diagnostics: [],
          runtimeFences: [],
          stats: { statementsTotal: 0, statementsFailed: 0, functionsSkipped: 0 },
        }),
      };
    });
    vi.mocked(emitNativeObject).mockImplementation((options) => {
      writeFileSync(options.outputPath, "object");
      return { outputs: [options.outputPath], profileMatch: null };
    });
    vi.mocked(openNativeExecutableCache).mockReturnValue(null);
    vi.mocked(execFileSync).mockImplementation((_command, args) => {
      const list = args as string[];
      writeFileSync(list[list.indexOf("-o") + 1]!, "executable");
      return "";
    });
    const target = LINUX_X64_GNU_TARGET;
    const cache = new NativeCache(join(directory, "cache"));
    const compiler = new NativeCompiler(
      {
        compilerVersion: "0.0.0",
        target,
        helper: target.helper,
        ts7Executable: tool("ts7"),
        helperExecutable: tool("codegen"),
        helperPackageRoot: helperRoot,
        runtimePackRoot: packRoot,
        linker: tool("clang"),
        linkerArgs: [],
        dsymutil: tool("dsymutil"),
      },
      cache,
    );
    const options = { outDir: directory, outPath: output, backend: "llvm" as const };
    expect(compiler.compile(entry, options)).toMatchObject({ ok: true, binaryPath: output });
    expect(vi.mocked(runNativeFrontend)).toHaveBeenCalledTimes(1);
    // The record names the pack artifact the link read, so a pack edited in
    // place cannot leave this executable standing.
    const recorded = readdirSync(join(cache.root, "unchanged")).filter(
      (name) => !name.endsWith(".sha256"),
    );
    expect(recorded).toHaveLength(1);
    const record: { packInputs: { path: string }[] } = JSON.parse(
      readFileSync(join(cache.root, "unchanged", recorded[0]!), "utf8"),
    );
    expect(record.packInputs.map((input) => input.path)).toEqual([archive]);
    const kept = readFileSync(output, "utf8");
    expect(compiler.compile(entry, options)).toMatchObject({ ok: true, binaryPath: output });
    // Nothing lowered, generated or linked the second time, and the
    // executable it kept is the first build's.
    expect(vi.mocked(runNativeFrontend)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(emitNativeObject)).toHaveBeenCalledTimes(1);
    expect(readFileSync(output, "utf8")).toBe(kept);
    // A removed executable is built again, not reported as kept (from the
    // frontend cache, which this record sits in front of).
    rmSync(output);
    expect(compiler.compile(entry, options)).toMatchObject({ ok: true, binaryPath: output });
    expect(vi.mocked(emitNativeObject)).toHaveBeenCalledTimes(2);
    // Another build request is another key.
    expect(compiler.compile(entry, { ...options, strip: true })).toMatchObject({
      ok: true,
      binaryPath: output,
    });
    expect(vi.mocked(runNativeFrontend)).toHaveBeenCalledTimes(2);
    // An edited source is not kept: the record's probes name the identity the
    // file had when it was read, and a write changes it.
    writeFileSync(entry, "export const value = 2;\n");
    expect(compiler.compile(entry, options)).toMatchObject({ ok: true, binaryPath: output });
    expect(vi.mocked(runNativeFrontend)).toHaveBeenCalledTimes(3);
  },
);

test.skipIf(process.platform === "win32")(
  "a static native link selects the runtime pack's /etc/passwd build",
  () => {
    const directory = mkdtempSync(join("/tmp", "scriptc-native-static-pack-"));
    directories.push(directory);
    const entry = join(directory, "entry.ts");
    writeFileSync(entry, "export const value = 1;\n");
    const output = join(directory, "program");
    const clang = join(directory, "clang");
    writeFileSync(clang, "#!/bin/sh\n");
    chmodSync(clang, 0o755);
    const module: IrModule = {
      irVersion: 17,
      sourceFile: entry,
      entry: "%main",
      functions: [
        {
          name: "%main",
          params: [],
          locals: [],
          body: [],
          returnType: VOID,
          loc: { file: entry, start: 0, end: 0 },
        },
      ],
    };
    vi.mocked(runNativeFrontend).mockReturnValue({
      preflight: [],
      entryText: () => "",
      entryExports: () => new Map(),
      entryContract: () => {
        throw new Error("unexpected contract request");
      },
      sourceTexts: () => new Map(),
      npmStatic: [],
      npmImportSites: new Map(),
      dispose: () => {},
      lower: () => ({
        module,
        diagnostics: [],
        runtimeFences: [],
        stats: { statementsTotal: 0, statementsFailed: 0, functionsSkipped: 0 },
      }),
    });
    vi.mocked(emitNativeObject).mockImplementation((options) => {
      writeFileSync(options.outputPath, "object");
      return { outputs: [options.outputPath], profileMatch: null };
    });
    vi.mocked(openNativeExecutableCache).mockReturnValue(null);
    vi.mocked(execFileSync).mockImplementation((_command, args) => {
      const list = args as string[];
      // The static link asks for a map (`-Xlinker -Map -Xlinker <path>`);
      // an empty one keeps no NSS member.
      const map = list.indexOf("-Map");
      if (map >= 0) writeFileSync(list[map + 2]!, "");
      writeFileSync(list[list.indexOf("-o") + 1]!, "executable");
      return "";
    });
    const target = LINUX_X64_GNU_TARGET;
    const compiler = new NativeCompiler({
      compilerVersion: "0.0.0",
      target,
      helper: target.helper,
      ts7Executable: "unused",
      helperExecutable: "unused",
      helperPackageRoot: "unused",
      runtimePackRoot: "unused",
      linker: clang,
      linkerArgs: [],
      dsymutil: "unused",
    });
    const select = vi.mocked(selectNativeRuntimePack);
    select.mockClear();
    vi.mocked(openNativeExecutableCache).mockClear();
    const options = { outDir: directory, outPath: output, backend: "llvm" as const };
    // The dynamic link leaves the selection to the program's features.
    expect(compiler.compile(entry, options)).toMatchObject({ ok: true, binaryPath: output });
    expect(select.mock.calls[0]![3]).not.toHaveProperty("staticLink");
    // A static link names the fact the variant selection reads (SCR_STATIC_PASSWD),
    // and the executable cache keys the same selection: a static build never
    // keeps a dynamic executable, nor the other way round.
    expect(compiler.compile(entry, { ...options, staticLink: true })).toMatchObject({
      ok: true,
      binaryPath: output,
    });
    expect(select.mock.calls[1]![3]).toMatchObject({ staticLink: true });
    const cachePack = (index: number) => vi.mocked(openNativeExecutableCache).mock.calls[index]![6];
    expect(cachePack(0).features).not.toHaveProperty("staticLink");
    expect(cachePack(1).features).toMatchObject({ staticLink: true });
  },
);
