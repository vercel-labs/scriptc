import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { loadNativeToolchain, type NativeToolchainManifest } from "./toolchain.js";

test("native toolchain installation paths relocate with the manifest", () => {
  const root = realpathSync(
    mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-native-tools-")),
  );
  const path = join(root, "toolchain.json");
  const manifest: NativeToolchainManifest = {
    schema: "scriptc.native-toolchain.v1",
    compiler_version: "1.2.3",
    target: "macos-arm64",
    ts7: "typescript/tsc",
    tsc_ts: "tsc-ts/lib/tsc-ts",
    llvm_package: "llvm",
    runtime_pack: "runtime",
    linker: "tools/linker",
    linker_args: ["cc"],
    dsymutil: "dsymutil",
  };
  try {
    writeFileSync(path, JSON.stringify(manifest));
    const toolchain = loadNativeToolchain(path);
    expect(toolchain.ts7Executable).toBe(join(root, "tsc-ts/lib/tsc-ts"));
    expect(loadNativeToolchain(path, { SCRIPTC_CHECKER: "tsgo" }).ts7Executable).toBe(
      join(root, "typescript/tsc"),
    );
    expect(toolchain.helperExecutable).toBe(join(root, "llvm/bin/scriptc-llvm-codegen"));
    expect(toolchain.runtimePackRoot).toBe(join(root, "runtime"));
    expect(toolchain.linker).toBe(join(root, "tools/linker"));
    expect(toolchain.linkerArgs).toEqual(["cc"]);
    expect(toolchain.target.name).toBe("macos-arm64");
    expect(loadNativeToolchain(path, { SCRIPTC_TARGET: "aarch64-apple-ios" }).target.name).toBe(
      "ios-arm64",
    );
    for (const invalid of [
      null,
      [],
      {},
      { ...manifest, schema: "other" },
      { ...manifest, target: "other" },
      { ...manifest, ts7: "" },
      { ...manifest, tsc_ts: "" },
      { ...manifest, linker_args: [1] },
    ]) {
      writeFileSync(path, JSON.stringify(invalid));
      expect(() => loadNativeToolchain(path)).toThrow();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prebuilt lib diagnostics apply while the checker is the distribution's tsc-ts", () => {
  const root = realpathSync(
    mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-native-tools-")),
  );
  const path = join(root, "toolchain.json");
  const manifest: NativeToolchainManifest = {
    schema: "scriptc.native-toolchain.v1",
    compiler_version: "1.2.3",
    target: "macos-arm64",
    ts7: "typescript/tsc",
    tsc_ts: "tsc-ts/lib/tsc-ts",
    llvm_package: "llvm",
    runtime_pack: "runtime",
    linker: "tools/linker",
    linker_args: [],
    dsymutil: "dsymutil",
    lib_diagnostics: "declarations/lib-diagnostics.json",
  };
  try {
    writeFileSync(path, JSON.stringify(manifest));
    expect(loadNativeToolchain(path).prebuiltLibDiagnostics).toBe(
      join(root, "declarations/lib-diagnostics.json"),
    );
    // tsgo checks without them.
    expect(
      loadNativeToolchain(path, { SCRIPTC_CHECKER: "tsgo" }).prebuiltLibDiagnostics,
    ).toBeUndefined();
    writeFileSync(path, JSON.stringify({ ...manifest, lib_diagnostics: "" }));
    expect(() => loadNativeToolchain(path)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native toolchain assets resolve from the physical manifest through package links", () => {
  const root = realpathSync(
    mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-linked-tools-")),
  );
  const store = join(root, "node_modules", ".pnpm");
  const installation = join(store, "scriptc@1.2.3", "node_modules", "scriptc");
  const bin = join(installation, "bin");
  const assets = join(
    store,
    "@scriptc+cli-win32-x64-msvc@1.2.3",
    "node_modules",
    "@scriptc",
    "cli-win32-x64-msvc",
    "dist",
    "lib",
  );
  const asset = (path: string) => relative(bin, join(assets, path));
  const manifest: NativeToolchainManifest = {
    schema: "scriptc.native-toolchain.v1",
    compiler_version: "1.2.3",
    target: "windows-x64-msvc",
    ts7: asset("typescript/lib/tsc.exe"),
    tsc_ts: asset("tsc-ts/lib/tsc-ts.exe"),
    llvm_package: asset("llvm"),
    runtime_pack: asset("runtime"),
    runtime_packs: [{ target: "windows-x64-msvc", path: asset("runtime") }],
    runtime_sources: asset("runtime-sources"),
    declarations: asset("declarations"),
    comptime: asset("comptime.exe"),
    wasi_node_runner: asset("wasi/cli/wasi-runner.js"),
    linker: asset("tools/linker.exe"),
    linker_args: ["cc"],
    dsymutil: asset("tools/dsymutil.exe"),
    archiver: asset("tools/archiver.exe"),
    relocatable_linker: asset("tools/ld.exe"),
  };
  try {
    mkdirSync(bin, { recursive: true });
    const path = join(bin, "scriptc.exe.json");
    writeFileSync(path, JSON.stringify(manifest));
    const linked = join(root, "node_modules", "scriptc");
    symlinkSync(installation, linked, process.platform === "win32" ? "junction" : "dir");
    const direct = loadNativeToolchain(path);
    const viaLink = loadNativeToolchain(join(linked, "bin", "scriptc.exe.json"));
    expect(viaLink).toEqual(direct);
    expect(viaLink.ts7Executable).toBe(join(assets, "tsc-ts/lib/tsc-ts.exe"));
    expect(
      loadNativeToolchain(join(linked, "bin", "scriptc.exe.json"), { SCRIPTC_CHECKER: "tsgo" })
        .ts7Executable,
    ).toBe(join(assets, "typescript/lib/tsc.exe"));
    expect(viaLink.helperExecutable).toBe(join(assets, "llvm/bin/scriptc-llvm-codegen.exe"));
    expect(
      loadNativeToolchain(join(linked, "bin", "scriptc.exe.json"), {
        SCRIPTC_RUNTIME_PACK: "../explicit",
      }).runtimePackRoot,
    ).toBe(join(installation, "explicit"));
    if (process.platform !== "win32") {
      const linkedManifest = join(root, "toolchain.json");
      symlinkSync(path, linkedManifest, "file");
      expect(loadNativeToolchain(linkedManifest)).toEqual(direct);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cross-target packs can be added to a project after the compiler is installed", () => {
  const root = realpathSync(
    mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-project-pack-")),
  );
  const installation = join(root, "compiler", "bin");
  const project = join(root, "project");
  const nested = join(project, "src", "nested");
  const pack = join(project, "node_modules/@scriptc/runtime-wasm32-wasi");
  mkdirSync(installation, { recursive: true });
  mkdirSync(nested, { recursive: true });
  const path = join(installation, "scriptc.json");
  const manifest: NativeToolchainManifest = {
    schema: "scriptc.native-toolchain.v1",
    compiler_version: "1.2.3",
    target: "macos-arm64",
    ts7: "../lib/typescript/tsc",
    tsc_ts: "../lib/tsc-ts/lib/tsc-ts",
    llvm_package: "../lib/llvm",
    runtime_pack: "../lib/runtime-darwin-arm64",
    linker: "clang",
    linker_args: [],
    dsymutil: "dsymutil",
  };
  writeFileSync(path, JSON.stringify(manifest));
  const env = { SCRIPTC_TARGET: "wasm32-wasi" };
  try {
    // Object emission does not require a pack to be installed.
    expect(loadNativeToolchain(path, env, nested).target.name).toBe("wasm32-wasi");
    mkdirSync(pack, { recursive: true });
    writeFileSync(
      join(pack, "package.json"),
      JSON.stringify({ name: "@scriptc/runtime-wasm32-wasi", version: "1.2.3" }),
    );
    expect(loadNativeToolchain(path, env, nested).runtimePackRoot).toBe(pack);
    expect(
      loadNativeToolchain(path, { ...env, SCRIPTC_RUNTIME_PACK: "../explicit" }, nested)
        .runtimePackRoot,
    ).toBe(join(root, "compiler", "explicit"));
    expect(loadNativeToolchain(path, {}, nested).runtimePackRoot).toBe(
      join(root, "compiler", "lib/runtime-darwin-arm64"),
    );
    const registered = join(root, "registered");
    mkdirSync(registered);
    writeFileSync(
      path,
      JSON.stringify({ ...manifest, runtime_packs: [{ target: "wasm32-wasi", path: registered }] }),
    );
    expect(loadNativeToolchain(path, env, nested).runtimePackRoot).toBe(registered);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("versioned GNU targets select Zig while ordinary host builds keep the installed linker", () => {
  const root = realpathSync(
    mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-gnu-linker-")),
  );
  const path = join(root, "scriptc.json");
  writeFileSync(
    path,
    JSON.stringify({
      schema: "scriptc.native-toolchain.v1",
      compiler_version: "1.2.3",
      target: "linux-x64-gnu",
      ts7: "tsc",
      tsc_ts: "tsc-ts",
      llvm_package: "llvm",
      runtime_pack: "runtime",
      linker: "clang",
      linker_args: [],
      dsymutil: "dsymutil",
    }),
  );
  try {
    expect(loadNativeToolchain(path).linker).toBe("clang");
    expect(loadNativeToolchain(path, { SCRIPTC_TARGET: "x86_64-linux-gnu.2.34" })).toMatchObject({
      linker: "zig",
      linkerArgs: ["cc"],
      target: { linkerTargetTriple: "x86_64-linux-gnu.2.34" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a manifest without tsc_ts takes the host's tsc-ts executable from the installed package", () => {
  const root = realpathSync(
    mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-checker-tools-")),
  );
  const path = join(root, "toolchain.json");
  const manifest: NativeToolchainManifest = {
    schema: "scriptc.native-toolchain.v1",
    compiler_version: "1.2.3",
    target: "linux-x64-musl",
    ts7: "typescript/tsc",
    llvm_package: "llvm",
    runtime_pack: "runtime",
    linker: "tools/linker",
    linker_args: ["cc"],
    dsymutil: "dsymutil",
  };
  try {
    writeFileSync(path, JSON.stringify(manifest));
    const project = join(root, "project");
    const platformPackage = join(project, "node_modules/@tsc-ts/linux-x64-musl");
    mkdirSync(join(project, "node_modules/tsc-ts"), { recursive: true });
    writeFileSync(join(project, "node_modules/tsc-ts/package.json"), '{"name":"tsc-ts"}');
    mkdirSync(join(platformPackage, "lib"), { recursive: true });
    writeFileSync(join(platformPackage, "lib/tsc-ts"), "");
    expect(loadNativeToolchain(path, {}, project).ts7Executable).toBe(
      join(platformPackage, "lib/tsc-ts"),
    );
    expect(loadNativeToolchain(path, { SCRIPTC_CHECKER: "tsgo" }, project).ts7Executable).toBe(
      join(root, "typescript/tsc"),
    );
    expect(() => loadNativeToolchain(path, {}, root)).toThrow(
      "the tsc-ts package is not installed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["nested", "hoisted", "pnpm"])(
  "an npm platform package resolves its LLVM helper and runtime pack dependencies (%s)",
  (layout) => {
    const root = realpathSync(
      mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-dependencies-")),
    );
    const modules =
      layout === "pnpm"
        ? join(root, "node_modules/.pnpm/@scriptc+cli-linux-x64-gnu@1.2.3/node_modules")
        : join(root, "node_modules");
    const platform = join(modules, "@scriptc/cli-linux-x64-gnu");
    const dependencies = layout === "nested" ? join(platform, "node_modules") : modules;
    const bin = join(platform, "dist/bin");
    const path = join(bin, "scriptc.json");
    const manifest: NativeToolchainManifest = {
      schema: "scriptc.native-toolchain.v1",
      compiler_version: "1.2.3",
      target: "linux-x64-gnu",
      ts7: "../lib/typescript/tsc",
      tsc_ts: "../lib/tsc-ts/lib/tsc-ts",
      linker: "clang",
      linker_args: [],
      dsymutil: "dsymutil",
    };
    const install = (name: string, version = "1.2.3") => {
      mkdirSync(join(dependencies, name), { recursive: true });
      writeFileSync(join(dependencies, name, "package.json"), JSON.stringify({ name, version }));
    };
    try {
      mkdirSync(bin, { recursive: true });
      writeFileSync(path, JSON.stringify(manifest));
      expect(() => loadNativeToolchain(path)).toThrow(
        "scriptc requires @scriptc/llvm-linux-x64-gnu@1.2.3, which is not installed beside the native compiler",
      );
      install("@scriptc/llvm-linux-x64-gnu");
      install("@scriptc/runtime-linux-x64-gnu", "1.2.2");
      expect(() => loadNativeToolchain(path)).toThrow(
        "scriptc requires @scriptc/runtime-linux-x64-gnu@1.2.3, found 1.2.2",
      );
      install("@scriptc/runtime-linux-x64-gnu");
      const toolchain = loadNativeToolchain(path);
      expect(toolchain.helperPackageRoot).toBe(join(dependencies, "@scriptc/llvm-linux-x64-gnu"));
      expect(toolchain.helperExecutable).toBe(
        join(dependencies, "@scriptc/llvm-linux-x64-gnu/bin/scriptc-llvm-codegen"),
      );
      expect(toolchain.runtimePackRoot).toBe(join(dependencies, "@scriptc/runtime-linux-x64-gnu"));
      // Other targets' packs still come from the project.
      const project = join(root, "project");
      const wasi = join(project, "node_modules/@scriptc/runtime-wasm32-wasi");
      mkdirSync(wasi, { recursive: true });
      writeFileSync(join(wasi, "package.json"), "{}");
      expect(
        loadNativeToolchain(path, { SCRIPTC_TARGET: "wasm32-wasi" }, project).runtimePackRoot,
      ).toBe(wasi);
      expect(
        loadNativeToolchain(path, { SCRIPTC_RUNTIME_PACK: "../explicit" }).runtimePackRoot,
      ).toBe(join(platform, "dist/explicit"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
