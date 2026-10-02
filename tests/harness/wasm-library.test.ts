import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WASI } from "node:wasi";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { compileLibrary as compileNodeLibrary, type CompileLibraryOptions } from "@scriptc/compiler";
import { NativeCompiler } from "../../packages/compiler/src/native/compiler.js";
import { nativeCodegenTarget, WASM32_WASI_TARGET } from "../../packages/compiler/src/backend/targets.js";
import { ts7Executable } from "../../packages/compiler/src/frontend/ts7/rpc-api.js";

// Run both compiler drivers against the same real checker transport in this
// harness. The production bootstrap separately exercises the native transport.
vi.mock("../../packages/compiler/src/frontend/pipeline-native.js", async () => {
  const { runFrontend } = await import("../../packages/compiler/src/frontend/pipeline.js");
  const { loadProgram } = await import("../../packages/compiler/src/frontend/program-node.js");
  return { runNativeFrontend: (entry: string, _executable: string, npmStatic?: readonly string[] | "auto" | "lib",
    externalTypes?: Readonly<Record<string, string>>, _evaluate?: unknown, libraryNpmStatic?: readonly string[]) =>
    runFrontend(entry, loadProgram, npmStatic, externalTypes, libraryNpmStatic) };
});

const fixture = join(import.meta.dirname, "../library-mode/wasm");
const hasZig = spawnSync("zig", ["version"]).status === 0;
type Api = Record<string, (...args: number[]) => number> & { memory: WebAssembly.Memory };

describe.skipIf(!hasZig).each(["node", "native"] as const)("Wasm library embedding (%s driver)", (driver) => {
  let directory: string;
  let module: WebAssembly.Module;
  let oldTarget: string | undefined;
  let profile: any;
  let native: NativeCompiler;
  const compileLibrary = (options: CompileLibraryOptions) => driver === "node"
    ? compileNodeLibrary(options) : Promise.resolve(native.compileLibrary(options));

  beforeAll(async () => {
    oldTarget = process.env["SCRIPTC_TARGET"];
    if (driver === "native") {
      const host = nativeCodegenTarget()!;
      const root = join(import.meta.dirname, "../..");
      const helperPackageRoot = join(root, "packages", host.helper.packageName.replace("@scriptc/", ""));
      const compilerPackage = JSON.parse(await readFile(join(root, "packages/compiler/package.json"), "utf8"));
      native = new NativeCompiler({
        compilerVersion: compilerPackage.version, target: WASM32_WASI_TARGET, helper: host.helper,
        helperPackageRoot, helperExecutable: join(helperPackageRoot, "bin", process.platform === "win32" ? "scriptc-llvm-codegen.exe" : "scriptc-llvm-codegen"),
        runtimePackRoot: join(root, "packages/runtime-wasm32-wasi"), ts7Executable: ts7Executable(),
        linker: "zig", linkerArgs: ["cc"], dsymutil: "unused",
      });
    }
    process.env["SCRIPTC_TARGET"] = "wasm32-wasi";
    directory = await mkdtemp("/tmp/scriptc-wasm-library-test-");
    profile = JSON.parse(await readFile(join(fixture, "profile.json"), "utf8"));
    profile.entry = join(fixture, "lib.ts");
    const result = await compileLibrary({ profilePath: join(fixture, "profile.json"), outDir: directory });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.archivePath.endsWith(".wasm")).toBe(true);
    module = new WebAssembly.Module(await readFile(result.archivePath));
  });

  afterAll(async () => {
    if (oldTarget === undefined) delete process.env["SCRIPTC_TARGET"];
    else process.env["SCRIPTC_TARGET"] = oldTarget;
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  function instantiate(adjust?: (value: number, api: Api) => number) {
    const wasi = new WASI({ version: "preview1" });
    let api: Api;
    const reports: unknown[] = [];
    const panics: string[] = [];
    const text = (ptr: number, len: number) => new TextDecoder().decode(new Uint8Array(api.memory.buffer, ptr, len));
    const instance = new WebAssembly.Instance(module, {
      ...wasi.getImportObject(),
      scriptc: {
        adjust: (value: number) => adjust ? adjust(value, api) : value * 2,
        report: (p: number, n: number, b: number, size: number, flag: number) => {
          reports.push([text(p, n), Array.from(new Uint8Array(api.memory.buffer, b, size)), flag !== 0]);
        },
        panic: (p: number, n: number) => { const message = text(p, n); panics.push(message); throw new Error(message); },
      },
    });
    api = instance.exports as Api;
    wasi.initialize(instance);
    api.app_init();
    return { api, reports, panics, text };
  }

  test("exports only the callable ABI and requires named host imports", () => {
    expect(WebAssembly.Module.exports(module).map((e) => e.name).sort()).toEqual([
      "_initialize", "memory", "scriptc_alloc", "scriptc_free", "app_init", "app_collect", "app_reset_results",
      "app_step", "app_echo", "app_echo_cstring", "app_bytes", "app_fail",
    ].sort());
    expect(WebAssembly.Module.imports(module).filter((e) => e.module === "scriptc").map((e) => e.name).sort()).toEqual(["adjust", "panic", "report"]);
    expect(() => new WebAssembly.Instance(module, { scriptc: {}, wasi_snapshot_preview1: {} })).toThrow();
  });

  test("matches Node across stateful calls, strings, buffers, and host callbacks", () => {
    const { api, reports, text } = instantiate();
    const values = [api.app_step(3), api.app_step(-2), api.app_step(0.5)];
    const input = new TextEncoder().encode("λ\0hello");
    const ptr = api.scriptc_alloc(input.length + 8);
    new Uint8Array(api.memory.buffer, ptr, input.length).set(input);
    const out = ptr + input.length;
    api.app_echo(ptr, input.length, out, out + 4);
    let view = new DataView(api.memory.buffer);
    const resultPtr = view.getUint32(out, true), resultLen = view.getUint32(out + 4, true);
    const echo = text(resultPtr, resultLen);
    const cstringInput = new TextEncoder().encode("λ hello");
    const cstringPtr = api.scriptc_alloc(32);
    new Uint8Array(api.memory.buffer, cstringPtr, cstringInput.length).set(cstringInput);
    new Uint8Array(api.memory.buffer)[cstringPtr + cstringInput.length] = 0;
    const cstringResult = api.app_echo_cstring(cstringPtr);
    expect(text(cstringResult, new Uint8Array(api.memory.buffer, cstringResult).indexOf(0))).toBe("cstr:λ hello");
    const nulInput = new TextEncoder().encode("λ\0ignored\0");
    new Uint8Array(api.memory.buffer, cstringPtr, nulInput.length).set(nulInput);
    new Uint8Array(api.memory.buffer)[cstringPtr + nulInput.length] = 0;
    const nulResult = api.app_echo_cstring(cstringPtr);
    expect(text(nulResult, new Uint8Array(api.memory.buffer, nulResult).indexOf(0))).toBe("cstr:λ");
    new Uint8Array(api.memory.buffer, ptr, 3).set([0, 254, 255]);
    api.app_bytes(ptr, 3, out, out + 4);
    view = new DataView(api.memory.buffer);
    const bytes = Array.from(new Uint8Array(api.memory.buffer, view.getUint32(out, true), view.getUint32(out + 4, true)));
    // An explicit reset entry keeps earlier results live across later calls.
    expect(text(resultPtr, resultLen)).toBe(echo);
    api.scriptc_free(cstringPtr);
    api.scriptc_free(ptr);
    api.app_reset_results();
    api.app_collect();
    const reference = execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `
      const reports=[];
      globalThis.adjust=x=>x*2;
      globalThis.report=(s,b,f)=>reports.push([s,Array.from(b),f]);
      const api=await import(${JSON.stringify(join(fixture, "lib.ts"))});
      const values=[api.step(3),api.step(-2),api.step(0.5)];
      const echo=api.echo("λ\\0hello");
      const echoCString=api.echoCString("λ");
      const bytes=Array.from(api.bytes(new Uint8Array([0,254,255])));
      console.log(JSON.stringify({values,echo,echoCString,bytes,reports}));
    `], { encoding: "utf8" });
    expect({ values, echo, echoCString: "cstr:λ", bytes, reports }).toEqual(JSON.parse(reference));
  });

  test("instances isolate state and initialization resets the session", () => {
    const a = instantiate().api, b = instantiate().api;
    expect(a.memory).not.toBe(b.memory);
    expect(a.app_step(5)).toBe(17);
    expect(b.app_step(1)).toBe(9);
    a.app_init();
    expect(a.app_step(0)).toBe(7);
    expect(b.app_step(0)).toBe(9);
  });

  test("host allocations survive memory growth and collection", () => {
    const { api } = instantiate();
    const p = api.scriptc_alloc(16);
    new Uint8Array(api.memory.buffer, p, 16).fill(42);
    const original = api.memory.buffer;
    const big = api.scriptc_alloc(original.byteLength + 65536);
    expect(big).not.toBe(0);
    expect(api.memory.buffer).not.toBe(original);
    api.app_collect();
    expect(Array.from(new Uint8Array(api.memory.buffer, p, 16))).toEqual(Array(16).fill(42));
    api.scriptc_free(big);
    api.scriptc_free(p);
  });

  test("escaped exceptions poison only their instance", () => {
    const a = instantiate(), b = instantiate();
    expect(() => a.api.app_fail()).toThrow(/reactor failure/);
    expect(a.panics).toHaveLength(1);
    expect(a.panics[0]).toContain("app_fail");
    expect(() => a.api.app_step(1)).toThrow();
    expect(() => a.api.scriptc_alloc(8)).toThrow();
    expect(b.api.app_step(1)).toBe(9);
  });

  test.each(["app_init", "app_collect", "app_reset_results", "scriptc_alloc", "scriptc_free", "app_step"])("rejects callback reentry through %s", (entry) => {
    const { api, panics } = instantiate((value, api) => api[entry](value));
    expect(() => api.app_step(2)).toThrow(/SC4026/);
    expect(panics[0]).toContain(entry);
  });

  test("an escaping host exception prevents reuse of the suspended instance", () => {
    const { api } = instantiate(() => { throw new Error("host failure"); });
    expect(() => api.app_step(1)).toThrow("host failure");
    expect(() => api.app_init()).toThrow(/SC4026/);
  });

  test.each(["instance_per_thread", "localize_runtime"])("refuses native-only %s", async (key) => {
    const path = join(directory, `${key}.json`);
    await writeFile(path, JSON.stringify({ ...profile, abi: { ...profile.abi, [key]: true } }));
    const result = await compileLibrary({ profilePath: path, outDir: directory });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.code).toBe("SC3002");
  });

  test("refuses collisions with built-in Wasm exports and imports", async () => {
    for (const change of [
      { abi: { ...profile.abi, prefix: "scriptc_", init_symbol: "scriptc_alloc", sink_register_symbol: "scriptc_sink", callback_register_symbol: "scriptc_callback", collect_symbol: null, result_reset_symbol: null }, exports: [] },
      { callbacks: [{ name: "panic", params: [], returns: "void" }] },
    ]) {
      const path = join(directory, "reserved.json");
      await writeFile(path, JSON.stringify({ ...profile, ...change }));
      const result = await compileLibrary({ profilePath: path, outDir: directory });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics[0]?.message).toMatch(/reserved/);
    }
  });

  test.each(["release", "dev"])("published three.js computes animated camera-space vertices in %s", async (optimization) => {
    const threeProfile = JSON.parse(await readFile(join(fixture, "three.json"), "utf8"));
    const profilePath = join(directory, `three-${optimization}.json`);
    await writeFile(profilePath, JSON.stringify({ ...threeProfile, entry: join(fixture, "three.mjs"), optimization }));
    const result = await compileLibrary({ profilePath, outDir: directory });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const wasi = new WASI({ version: "preview1" });
    let api: Api;
    const vertices: number[][] = [];
    const instance = new WebAssembly.Instance(new WebAssembly.Module(await readFile(result.archivePath)), {
      ...wasi.getImportObject(),
      scriptc: {
        vertex: (...args: number[]) => vertices.push(args.map((x) => Number(x.toFixed(9)))),
        panic: (p: number, n: number) => { throw new Error(new TextDecoder().decode(new Uint8Array(api.memory.buffer, p, n))); },
      },
    });
    api = instance.exports as Api;
    wasi.initialize(instance);
    api.app_init();
    for (const time of [0, 123, 2000]) expect(api.app_frame(time, 1.5)).toBe(24);
    const reference = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `
      const vertices=[];
      globalThis.vertex=(...args)=>vertices.push(args.map(x=>Number(x.toFixed(9))));
      const {frame}=await import(${JSON.stringify(join(fixture, "three.mjs"))});
      for (const time of [0,123,2000]) frame(time,1.5);
      console.log(JSON.stringify(vertices));
    `], { encoding: "utf8" });
    expect({ stdout: JSON.stringify(vertices) + "\n", stderr: "", status: 0 }).toEqual({ stdout: reference.stdout, stderr: reference.stderr, status: reference.status });
    api.app_collect();
    api.app_init();
    expect(api.app_frame(0, 1)).toBe(24);
  });
});
