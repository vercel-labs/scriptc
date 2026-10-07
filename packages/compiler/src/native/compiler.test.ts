import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { NativeCompiler } from "./compiler.js";
import type { NativeToolchain } from "./toolchain.js";
import { runNativeFrontend } from "../frontend/pipeline-native.js";
import { emitNativeObject } from "../backend/native-tools.js";
import { MACOS_ARM64_TARGET } from "../backend/targets.js";
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
vi.mock("../backend/runtime-pack-native.js", () => ({
  selectNativeRuntimePack: () => ({}),
  stageNativeRuntimeSelection: () => ({ runtimeObjects: [], archives: [], systemLibraries: [] }),
}));

const directories: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
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
    irVersion: 14,
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
        statementsIsland: 0,
        functionsSkipped: 0,
      },
    }),
  });
  vi.mocked(emitNativeObject).mockImplementation((options) => {
    writeFileSync(options.outputPath, "object");
    return [options.outputPath];
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
      irVersion: 14,
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
          statementsIsland: 0,
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
      return [options.outputPath];
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
