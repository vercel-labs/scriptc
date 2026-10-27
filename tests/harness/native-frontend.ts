/* The native frontend checks: the complete compiler frontend built to a native
 * executable, which lowers programs without Node and must produce the IR and
 * reports of the Node pipeline it was built from. The checks are split across
 * the self-hosting-native-frontend*.test.ts files so that CI runs them on
 * different shards; each file builds the executable once (useNativeFrontend). */
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect } from "vitest";
import { compileC, deserializeModule, emitLlvmModule, validateModule } from "@scriptc/compiler";
import type { compile } from "@scriptc/compiler";
import type { IrModule } from "../../packages/compiler/src/ir/ir.js";
import { ts7Executable } from "../../packages/compiler/src/frontend/ts7/rpc-api.js";

import { moduleLinkFeatures } from "./link-features.js";

const root = join(import.meta.dirname, "../..");
const entry = join(root, "tests/fixtures/self-hosting/frontend-pipeline.ts");
const oracle = join(root, "tests/fixtures/self-hosting/frontend-pipeline-node.ts");
const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const runOptions = {
  cwd: root,
  timeout: 120_000,
  maxBuffer: 16 * 1024 * 1024,
  encoding: "utf8" as const,
};

function comparableStderr(text: string): string {
  return sanitize
    ? text.replace(
        /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext functions and may produce false positives in some cases!\n/gm,
        "",
      )
    : text;
}

export const programs = [
  "001-hello.ts",
  "101-arithmetic.ts",
  "600-closures-basic.ts",
  "711-inheritance-dispatch.ts",
  "1005-json-nested.ts",
  "1452-return-through-finally.ts",
  "2012-generators-return-throw.ts",
  "3089-array-find-narrowing.ts",
  "tuple-array-union.ts",
  "array-refined-storage.ts",
  "typed-rest-filtered-return.ts",
  "rest-optional-elements.ts",
  "1300-errors-basics.ts",
  "error-tostring-overrides.ts",
  "nullish-long-chain.ts",
  "class-array-optional-return.ts",
  "contextual-array-union-write.ts",
  "2391-default-builtin-imports/main.ts",
  "3055-default-builtin-nodenext/main.ts",
  "5854-array-from-async.ts",
  "6020-class-extends-function-constructor.js",
  "5585-record-results-inlined.ts",
  "2631-create-require/main.ts",
  "4970-int32-call-abi.ts",
  // Re-chosen key orders rebuild the inspect helpers after lowering.
  "key-order-late-optional.ts",
  "5888-inspect-sorted.ts",
];

interface LowerRequest {
  entry: string;
  npmStatic?: string[] | "auto" | "lib";
  externalTypes?: Record<string, string>;
  ffiProfile?: string;
  contract?: boolean;
}

export interface NativeFrontend {
  /** The build directory; checks write their scratch files here. */
  directory: string;
  executable(name: string): string;
  /** Lowers one request with the Node pipeline and the native frontend, and checks that their reports and
   * IR agree. */
  lowerRequest(file: string, request: LowerRequest): { module: IrModule | null; report: unknown[] };
}

/** Builds the native frontend in a beforeAll hook of the calling suite (and removes it afterwards). The
 * returned function gives the built frontend to the suite's tests. */
export function useNativeFrontend(backend: "llvm" = "llvm"): () => NativeFrontend {
  let frontend: NativeFrontend | undefined;
  let directory: string | undefined;
  beforeAll(async () => {
    const dir = mkdtempSync(
      join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-native-frontend-"),
    );
    directory = dir;
    const executable = (name: string) =>
      join(dir, name + (process.platform === "win32" ? ".exe" : ""));
    const nativeSources = join(root, "packages/compiler/native");
    const object = join(dir, "ts7-process.o");
    execFileSync("clang", [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      ...(sanitize ? ["-fsanitize=address"] : []),
      "-c",
      join(nativeSources, "ts7-process.c"),
      "-o",
      object,
    ]);
    const profile = join(dir, "ffi.json");
    writeFileSync(
      profile,
      JSON.stringify({
        ...JSON.parse(readFileSync(join(nativeSources, "ts7-process.ffi.json"), "utf8")),
        libraries: [object],
      }),
    );
    // Production lowering can monopolize a worker's synchronous RPC loop.
    // Build the actual entry in a child while keeping Vitest responsive.
    const api = pathToFileURL(join(root, "packages/compiler/src/index.ts")).href;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "--max-old-space-size=8192",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `import { compile } from ${JSON.stringify(api)};
         const result = await compile(process.argv[1], {
           outDir: process.argv[2], outPath: process.argv[3], backend: process.argv[4],
           optimization: 'dev', sanitize: process.argv[5] === '1',
           ffiProfilePath: process.argv[6],
         });
         console.log(JSON.stringify({ ...result, sourceTexts: undefined }));`,
        entry,
        dir,
        executable("frontend"),
        backend,
        sanitize ? "1" : "0",
        profile,
      ],
      // Under the sanitizer this compile alone can take most of 15 minutes
      // on a loaded macOS runner.
      { cwd: root, timeout: 1_500_000, maxBuffer: 16 * 1024 * 1024 },
    );
    expect(stderr).toBe("");
    const built = JSON.parse(stdout) as Awaited<ReturnType<typeof compile>>;
    if (!built.ok)
      throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    if (!("binaryPath" in built)) throw new Error("expected a native frontend executable");
    expect(built.backend).toBe(backend);

    const lowerRequest = (
      file: string,
      request: LowerRequest,
    ): { module: IrModule | null; report: unknown[] } => {
      const requestPath = join(dir, "request.json");
      writeFileSync(requestPath, JSON.stringify(request));
      const expectedPath = join(dir, "node.json");
      const actualPath = join(dir, "native.json");
      for (const output of [expectedPath, actualPath]) rmSync(output, { force: true });
      const expected = spawnSync(
        process.execPath,
        ["--import", "tsx", oracle, ts7Executable(), requestPath, expectedPath],
        runOptions,
      );
      // The native client launches the selected TS7 executable directly.
      // Removing PATH makes an accidental Node subprocess dependency fail.
      const actual = spawnSync(built.binaryPath, [ts7Executable(), requestPath, actualPath], {
        ...runOptions,
        env: { ...process.env, PATH: "" },
      });
      for (const result of [expected, actual]) {
        expect(result.error, file + "\n" + result.stderr).toBeUndefined();
        expect(result.signal, file + "\n" + result.stderr).toBeNull();
        expect(result.status, file + "\n" + result.stderr).toBe(0);
        expect(comparableStderr(result.stderr), file).toBe("");
      }
      const expectedReport = expected.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const actualReport = actual.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(actualReport, file).toEqual(expectedReport);
      expect(existsSync(actualPath), file).toBe(existsSync(expectedPath));
      if (!existsSync(actualPath)) return { module: null, report: actualReport };
      const module = deserializeModule(readFileSync(actualPath, "utf8"));
      expect(module, file).toEqual(deserializeModule(readFileSync(expectedPath, "utf8")));
      expect(validateModule(module), file).toEqual([]);

      return { module, report: actualReport };
    };
    frontend = { directory: dir, executable, lowerRequest };
  }, 1_800_000);
  afterAll(() => {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  });
  return () => {
    if (frontend === undefined) throw new Error("the native frontend was not built");
    return frontend;
  };
}

/** A corpus program lowered by the native frontend compiles and prints what Node prints. */
export async function checkProgram(frontend: NativeFrontend, file: string): Promise<void> {
  const source = join(root, "tests/corpus", file);
  const { module, report } = frontend.lowerRequest(file, { entry: source });
  expect(report[0], file).toEqual({ preflight: [], npmStatic: [] });
  if (!module) throw new Error(file + ": missing native IR");
  const cPath = join(frontend.directory, "program.ll");
  writeFileSync(cPath, emitLlvmModule(module));
  await compileC({
    cPath,
    outPath: frontend.executable("program"),
    sanitize,
    ...moduleLinkFeatures(module),
  });
  const node = spawnSync(process.execPath, [source], runOptions);
  const native = spawnSync(frontend.executable("program"), [], runOptions);
  for (const result of [node, native]) {
    expect(result.error, file).toBeUndefined();
    expect(result.signal, file + "\n" + result.stderr).toBeNull();
    expect(result.status, file + "\n" + result.stderr).toBe(0);
  }
  expect(native.stdout, file).toBe(node.stdout);
  expect(comparableStderr(native.stderr), file).toBe(node.stderr);
}

/** Opted-in npm packages lower statically, and a deviant __toESM package is refused. */
export function checkNpmStatic(frontend: NativeFrontend): void {
  for (const [file, npmStatic, packages] of [
    ["escape-cli.ts", "auto", ["escape-string-regexp"]],
    ["escape-barrel.ts", "auto", ["escape-string-regexp"]],
    ["nested/main.ts", "auto", ["shouty"]],
    ["slash-cli.ts", ["slash"], ["slash"]],
    ["inferred-returns.mjs", ["inferred-returns"], ["inferred-returns"]],
  ] as const) {
    const result = frontend.lowerRequest(file, {
      entry: join(root, "tests/fixtures/npm-static", file),
      npmStatic: typeof npmStatic === "string" ? npmStatic : [...npmStatic],
    });
    expect(result.report[0], file).toEqual({
      preflight: [],
      npmStatic: packages.map((name) => ({ package: name, status: "static" })),
    });
    expect(result.report[1], file).toMatchObject({
      stats: { statementsFailed: 0 },
      diagnostics: [],
      validation: [],
    });
    expect(result.module, file).not.toBeNull();
  }
  const fallback = frontend.lowerRequest("package fallback", {
    entry: join(root, "tests/fixtures/npm/cases/2557-toesm-drift/main.ts"),
    npmStatic: "auto",
  });
  expect(fallback.report[0]).toMatchObject({
    npmStatic: [
      { package: "gtdrift", status: "refused", detail: expect.stringContaining("__toESM") },
    ],
  });
}

/** A module project in a directory of its own: returns its main.ts path. */
function project(frontend: NativeFrontend): string {
  const directory = mkdtempSync(join(frontend.directory, "project-"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        strict: true,
        noEmit: true,
      },
    }),
  );
  return join(directory, "main.ts");
}

/** A type error and a static refusal produce the Node pipeline's diagnostics and no IR. */
export function checkDiagnostics(frontend: NativeFrontend): void {
  const source = project(frontend);
  writeFileSync(source, "const value: string = 1; console.log(value);\n");
  const badType = frontend.lowerRequest("type error", { entry: source });
  expect(badType.module).toBeNull();
  expect(badType.report[0]).toMatchObject({
    preflight: [expect.objectContaining({ code: "SC0001" })],
  });
  writeFileSync(
    source,
    `
        const values: (string | number)[] = ["wrong"];
        console.log(values.find((value): value is number => true));
      `,
  );
  const refusal = frontend.lowerRequest("static refusal", { entry: source });
  expect(refusal.module).toBeNull();
  expect(refusal.report[1]).toMatchObject({
    diagnostics: [expect.objectContaining({ code: "SC1090" })],
  });
}

/** The same production pipeline supplies the library's syntax contract. Local type names and convention
 * constants exercise its scoped cache and the heterogeneous destination fields used by the projection. */
export function checkLibraryContract(frontend: NativeFrontend): void {
  const source = project(frontend);
  writeFileSync(
    source,
    `
        export interface Model { zebra: string; alpha: readonly number[]; }
        export type Msg = { kind: "paint"; payload: string } | { kind: "data"; payload: Uint8Array };
        export type ReadonlyArray<T> = { item: T };
        export type Local = ReadonlyArray<string>;
        export const modelUnbound = ["zebra"] as const;
        export const msgUnbound = ["paint"] as const;
        export const appearanceMsg = "paint";
        export const chromeMsg = "paint";
        export const envMsgs = [{ env: "DATA", msg: "data" }] as const;
        export function count(value: Model): number { return value.alpha.length; }
      `,
  );
  const contract = frontend.lowerRequest("library contract", {
    entry: source,
    npmStatic: "lib",
    contract: true,
  });
  expect(contract.report[0]).toEqual({ preflight: [], npmStatic: [] });
  expect(contract.report[1]).toMatchObject({
    modelUnbound: { value: ["zebra"] },
    msgUnbound: { value: ["paint"] },
    appearanceMsg: { value: "paint" },
    chromeMsg: { value: "paint" },
    envMsgs: { value: [{ env: "DATA", msg: "data" }] },
    types: expect.arrayContaining([
      expect.objectContaining({
        name: "Local",
        shape: { k: "unsupported", text: "ReadonlyArray<string>" },
      }),
    ]),
  });
}

/** A declared native function bound through an FFI profile lowers, links and runs. */
export async function checkNativeBindings(frontend: NativeFrontend): Promise<void> {
  const source = project(frontend);
  const directory = join(source, "..");
  writeFileSync(
    source,
    "declare function nativeAdd(a: number, b: number): number; console.log(nativeAdd(20, 22));\n",
  );
  const inputFfi = join(directory, "input-ffi.json");
  writeFileSync(
    inputFfi,
    JSON.stringify({
      ffi_format: 1,
      functions: [
        { name: "nativeAdd", symbol: "native_add", params: ["f64", "f64"], returns: "f64" },
      ],
    }),
  );
  const ffiResult = frontend.lowerRequest("native bindings", {
    entry: source,
    ffiProfile: inputFfi,
  });
  expect(ffiResult.report[1]).toMatchObject({ diagnostics: [], validation: [] });
  if (!ffiResult.module) throw new Error("missing FFI IR");
  const helper = join(directory, "add.c");
  const helperObject = join(directory, "add.o");
  writeFileSync(helper, "double native_add(double a, double b) { return a + b; }\n");
  execFileSync("clang", ["-c", helper, "-o", helperObject]);
  const ffiC = join(directory, "ffi.ll");
  writeFileSync(ffiC, emitLlvmModule(ffiResult.module));
  await compileC({
    cPath: ffiC,
    outPath: frontend.executable("ffi"),
    sanitize,
    ...moduleLinkFeatures(ffiResult.module),
    inspect: true,
    linkInputs: [helperObject],
  });
  const ffiRun = spawnSync(frontend.executable("ffi"), [], runOptions);
  expect(ffiRun.error).toBeUndefined();
  expect(ffiRun.status, ffiRun.stderr).toBe(0);
  expect(ffiRun.stdout).toBe("42\n");
  expect(comparableStderr(ffiRun.stderr)).toBe("");
}
