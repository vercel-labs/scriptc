import { join, resolve } from "node:path";
import { buildTargetPlatform } from "@scriptc/compiler";
import { expect, test } from "vitest";
import { defaultExecutableName, defaultOutputName, selectOutputPaths, wasiEnvironment, wasiPreopens } from "../src/paths.js";

test("default executable names use the Windows PE suffix", () => {
  expect(defaultExecutableName("main", "win32")).toBe("main.exe");
  expect(defaultExecutableName("main", "linux")).toBe("main");
  expect(defaultExecutableName("main", "darwin")).toBe("main");
  expect(defaultExecutableName("main", "wasi")).toBe("main.wasm");
});

test("source artifact names use stable POSIX and Windows suffixes", () => {
  expect(["ir", "c", "llvm", "asm", "obj", "exe"].map((kind) =>
    defaultOutputName("main", kind as Parameters<typeof defaultOutputName>[1], "linux")
  )).toEqual(["main.ir.json", "main.c", "main.ll", "main.s", "main.o", "main"]);
  expect(["ir", "c", "llvm", "asm", "obj", "exe"].map((kind) =>
    defaultOutputName("main", kind as Parameters<typeof defaultOutputName>[1], "win32")
  )).toEqual(["main.ir.json", "main.c", "main.ll", "main.asm", "main.obj", "main.exe"]);
});

test("primary output selection keeps explicit paths exact", () => {
  const input = resolve("work/main.ts");
  expect(selectOutputPaths(input, "llvm", undefined, "linux")).toEqual({
    outDir: join(input, "../.scriptc"),
    outPath: join(input, "../.scriptc/main.ll"),
    defaultOutputPath: true,
  });
  const explicit = resolve("artifacts/custom.anything");
  expect(selectOutputPaths(input, "ir", explicit, "win32")).toEqual({
    outDir: join(explicit, ".."),
    outPath: explicit,
    defaultOutputPath: false,
  });
});

test("TypeScript module extensions do not become part of default stems", () => {
  expect(selectOutputPaths(resolve("work/main.mts"), "ir", undefined, "linux").outPath)
    .toBe(resolve("work/.scriptc/main.ir.json"));
  expect(selectOutputPaths(resolve("work/main.cts"), "llvm", undefined, "linux").outPath)
    .toBe(resolve("work/.scriptc/main.ll"));
});

test("WASI cross-builds use the WebAssembly suffix", () => {
  const platform = buildTargetPlatform({
    SCRIPTC_CC: "zigcc",
    SCRIPTC_TARGET: "wasm32-wasi",
  });
  expect(platform).toBe("wasi");
  expect(defaultExecutableName("main", platform)).toBe("main.wasm");
});

test("WASI preopens map guest /tmp to the host platform temp directory", () => {
  expect(wasiPreopens("C:\\work\\repo", "C:\\Users\\runner\\AppData\\Local\\Temp")).toEqual({
    "/": "C:\\work\\repo",
    "/tmp": "C:\\Users\\runner\\AppData\\Local\\Temp",
  });
});

test("WASI environment paths name guest-visible capabilities", () => {
  const cwd = resolve("work/repo");
  const hostTmp = resolve("host/tmp");
  const outside = resolve("elsewhere");

  expect(wasiEnvironment({
    KEEP: "yes",
    PWD: cwd,
    HOME: outside,
    TMPDIR: hostTmp,
    TMP: hostTmp,
    TEMP: hostTmp,
    USERPROFILE: outside,
    OLDPWD: outside,
    INIT_CWD: join(cwd, "package"),
  }, cwd, hostTmp)).toEqual({
    KEEP: "yes",
    PWD: "/",
    HOME: "/",
    TMPDIR: "/tmp",
    TMP: "/tmp",
    TEMP: "/tmp",
    USERPROFILE: "/",
    INIT_CWD: "/package",
  });
});

test("Windows cross-builds use the PE suffix on a non-Windows host", () => {
  const platform = buildTargetPlatform({
    SCRIPTC_CC: "zigcc",
    SCRIPTC_TARGET: "x86_64-windows-gnu",
  });
  expect(platform).toBe("win32");
  expect(defaultExecutableName("main", platform)).toBe("main.exe");
});
