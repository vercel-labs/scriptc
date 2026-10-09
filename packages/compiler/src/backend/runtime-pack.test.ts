import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { compilerReleaseVersion } from "../library/sidecar.js";
import { snapshotNativeArtifactDependencies } from "./native-toolchain.js";
import type { NativeLinkFeatures } from "./native-link-info.js";
import {
  effectiveRuntimeFeatures,
  evaluateRuntimePredicate,
  loadRuntimeBitcode,
  loadRuntimePack,
  parseRuntimePackManifest,
  RuntimePackError,
  type RuntimePackManifest,
} from "./runtime-pack.js";
import { createNativeLinkPlan } from "./link-plan.js";
import {
  executableLinkerEnvironmentFingerprint,
  linkNativeExecutable,
  platformLinkerSupportsPersistentCache,
  resolvePlatformLinker,
} from "./linker.js";
import { MACOS_ARM64_TARGET, WINDOWS_X64_MSVC_TARGET, type NativeTargetSpec } from "./targets.js";

const VERSION = compilerReleaseVersion();

const BASE: NativeLinkFeatures = {
  dynamic: false,
  regex: false,
  copying: false,
  textDecoderLegacy: false,
  fileHandle: false,
  fetch: false,
  netIsland: false,
  zlib: false,
  assert: false,
  inspect: false,
  dynInvoke: false,
  dc: false,
  dynAsync: false,
  events: false,
  emitter: false,
  symbol: false,
  bigint: false,
  searchParams: false,
  qs: false,
  parseArgs: false,
  stream: false,
  net: false,
  http: false,
  http2: false,
  dgram: false,
  watch: false,
  foreignFfi: false,
  nodeTest: false,
  tls: false,
  tlsCa: false,
};

async function fixture(target: NativeTargetSpec = MACOS_ARM64_TARGET) {
  const root = await mkdtemp(join(tmpdir(), "scriptc-runtime-pack-unit-"));
  const packagePath = join(root, "package.json");
  await writeFile(
    packagePath,
    JSON.stringify({
      name: target.runtimePackPackage,
      version: VERSION,
    }),
  );
  const artifact = async (path: string, bytes: string) => {
    const output = join(root, path);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, bytes);
    return {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: Buffer.byteLength(bytes),
    };
  };
  const base = await artifact("artifacts/base.o", "base");
  const legacy = await artifact("artifacts/legacy.o", "legacy");
  const dynamic = await artifact("artifacts/dynamic.o", "dynamic");
  const regex = await artifact("artifacts/regex.a", "regex");
  const quickjs = await artifact("artifacts/qjs.a", "qjs");
  await writeFile(join(root, "license.txt"), "license");
  const units = [
    {
      source: "scr_bytes.c",
      predicate: true,
      variants: [
        { id: "default", when: {}, defines: [], ...base },
        {
          id: "legacy",
          when: { textDecoderLegacy: true },
          defines: ["SCR_TEXT_DECODER_LEGACY"],
          ...legacy,
        },
        { id: "dynamic", when: { dynamic: true }, defines: ["SCR_DYNAMIC"], ...dynamic },
      ],
    },
  ];
  const manifest: RuntimePackManifest = {
    schema: "scriptc.runtime-pack.v1",
    format: 1,
    package: target.runtimePackPackage,
    version: VERSION,
    target: {
      name: target.name,
      llvm_triple: target.llvmTriple,
      architecture: target.architecture,
      object_format: target.objectFormat,
      minimum_os: target.minimumOs,
    },
    runtime_abi: { version: 8, marker: "scr_runtime_abi_v8" },
    compiler: {
      command: "clang",
      identity: "fixture clang",
      target: target.llvmTriple,
    },
    macros: {
      executable: ["SCR_DYNAMIC", "SCR_TEXT_DECODER_LEGACY"],
      excluded: ["SCR_LIB", "SCR_THREAD_INSTANCES", "SCR_RC_AUDIT"],
      sanitizer: "external-toolchain-required",
    },
    flavors: {
      release: { optimization: "-O2", runtime_units: units },
      dev: { optimization: "-O0", runtime_units: units },
    },
    archives: [
      { id: "libregexp", predicate: { all: ["regex"], not: ["dynamic"] }, ...regex },
      { id: "quickjs", predicate: "dynamic", ...quickjs },
    ],
    system_libraries: [{ name: "System", predicate: true }],
    licenses: [{ path: "license.txt", license: "fixture" }],
  };
  await writeFile(join(root, "runtime-pack.json"), JSON.stringify(manifest));
  return { root, packagePath, manifest };
}

describe("runtime pack manifests", () => {
  test("the object linker is configured independently from the C compiler", () => {
    expect(resolvePlatformLinker({})).toBe("clang");
    expect(resolvePlatformLinker({ SCRIPTC_LINKER: "ld-driver" })).toBe("ld-driver");
    expect(platformLinkerSupportsPersistentCache({ SCRIPTC_LINKER: "wrapper" })).toBe(false);
    expect(platformLinkerSupportsPersistentCache({ LIBRARY_PATH: "/mutable" })).toBe(false);
    expect(platformLinkerSupportsPersistentCache({ SDKROOT: "/mutable" })).toBe(false);
  });

  test("the linker environment follows the effective clang behind a stable driver", async () => {
    const root = await mkdtemp(join(tmpdir(), "scriptc-linker-environment-"));
    const linker = join(root, "linker.mjs");
    const selectedOne = join(root, "selected-one");
    const selectedTwo = join(root, "selected-two");
    await Promise.all([
      writeFile(selectedOne, "one"),
      writeFile(selectedTwo, "two"),
      writeFile(
        linker,
        [
          "#!/bin/sh",
          'test "$1" = "-print-prog-name=clang" || exit 2',
          'printf "%s\\n" "$SCRIPTC_TEST_SELECTED_CLANG"',
          "",
        ].join("\n"),
      ),
    ]);
    await chmod(linker, 0o755);

    const first = await executableLinkerEnvironmentFingerprint({
      SCRIPTC_LINKER: linker,
      SCRIPTC_TEST_SELECTED_CLANG: selectedOne,
    });
    const second = await executableLinkerEnvironmentFingerprint({
      SCRIPTC_LINKER: linker,
      SCRIPTC_TEST_SELECTED_CLANG: selectedTwo,
    });
    expect(second).not.toBe(first);
  });

  test("feature implications and predicates are deterministic", () => {
    const features = effectiveRuntimeFeatures({ ...BASE, dynamic: true, fetch: true });
    expect(features).toMatchObject({
      nativeFetch: true,
      netIslandEffective: true,
      netEffective: true,
      httpEffective: true,
      tlsEffective: true,
      tlsCaEffective: true,
      zlibEffective: true,
    });
    expect(evaluateRuntimePredicate({ all: ["fetch"], not: ["regex"] }, features)).toBe(true);
    expect(evaluateRuntimePredicate({ any: ["regex", "dynamic"] }, features)).toBe(true);
  });

  test("static runtime-pack executable links dead-strip too", async () => {
    const { packagePath, root } = await fixture();
    const plan = await createNativeLinkPlan({
      target: MACOS_ARM64_TARGET,
      programObject: join(root, "program.o"),
      outPath: join(root, "program"),
      features: BASE,
      ffi: null,
      optimization: "release",
      resolver: () => packagePath,
    });
    expect(plan.driverFlags).toContain("-Wl,-dead_strip");
  });

  test("Windows runtime-pack links select the GUI subsystem only when requested", async () => {
    const { packagePath, root } = await fixture(WINDOWS_X64_MSVC_TARGET);
    const options = {
      target: WINDOWS_X64_MSVC_TARGET,
      programObject: join(root, "program.obj"),
      outPath: join(root, "program.exe"),
      features: BASE,
      ffi: null,
      optimization: "release" as const,
      resolver: () => packagePath,
    };
    const defaultPlan = await createNativeLinkPlan(options);
    const consolePlan = await createNativeLinkPlan({ ...options, windowsSubsystem: "console" });
    const guiPlan = await createNativeLinkPlan({ ...options, windowsSubsystem: "gui" });
    expect(defaultPlan.driverFlags).not.toContain("-Wl,--subsystem,windows");
    expect(consolePlan.driverFlags).toEqual(defaultPlan.driverFlags);
    expect(guiPlan.driverFlags).toEqual([...defaultPlan.driverFlags, "-Wl,--subsystem,windows"]);
  });

  test("selection chooses the most-specific variant and feature archive", async () => {
    const { packagePath } = await fixture();
    const resolver = () => packagePath;
    const legacy = await loadRuntimePack({
      target: MACOS_ARM64_TARGET,
      features: { ...BASE, textDecoderLegacy: true, regex: true },
      optimization: "release",
      resolver,
    });
    expect(legacy.runtimeObjects.map((path) => path.split("/").at(-1))).toEqual(["legacy.o"]);
    expect(legacy.archives.map((path) => path.split("/").at(-1))).toEqual(["regex.a"]);
    const dynamic = await loadRuntimePack({
      target: MACOS_ARM64_TARGET,
      features: { ...BASE, dynamic: true, regex: true },
      optimization: "dev",
      resolver,
    });
    expect(dynamic.flavor).toBe("dev");
    expect(dynamic.runtimeObjects.map((path) => path.split("/").at(-1))).toEqual(["dynamic.o"]);
    expect(dynamic.archives.map((path) => path.split("/").at(-1))).toEqual(["qjs.a"]);
  });

  test("runtime bitcode follows the selected speed variant and is verified", async () => {
    const { root, packagePath, manifest } = await fixture();
    const bitcode = async (path: string, bytes: string) => {
      await writeFile(join(root, path), bytes);
      return {
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: Buffer.byteLength(bytes),
      };
    };
    const unit = manifest.flavors.release!.runtime_units[0]!;
    const withBitcode: RuntimePackManifest = {
      ...manifest,
      flavors: {
        ...manifest.flavors,
        speed: {
          optimization: "-O2",
          runtime_units: [
            {
              ...unit,
              variants: [
                { ...unit.variants[0]!, bitcode: await bitcode("artifacts/base.bc", "base-bc") },
                {
                  ...unit.variants[1]!,
                  bitcode: await bitcode("artifacts/legacy.bc", "legacy-bc"),
                },
                unit.variants[2]!,
              ],
            },
          ],
        },
      },
    };
    const resolver = () => packagePath;
    // Release-flavor bitcode is never imported; only the speed flavor's is.
    await writeFile(
      join(root, "runtime-pack.json"),
      JSON.stringify({
        ...withBitcode,
        flavors: { ...withBitcode.flavors, release: withBitcode.flavors.speed, speed: undefined },
      }),
    );
    expect(
      await loadRuntimeBitcode({ target: MACOS_ARM64_TARGET, features: BASE, resolver }),
    ).toBeNull();
    await writeFile(join(root, "runtime-pack.json"), JSON.stringify(withBitcode));
    const legacy = await loadRuntimeBitcode({
      target: MACOS_ARM64_TARGET,
      features: { ...BASE, textDecoderLegacy: true },
      resolver,
    });
    expect(legacy?.paths.map((path) => basename(path))).toEqual(["legacy.bc"]);
    expect(legacy?.digests).toEqual([createHash("sha256").update("legacy-bc").digest("hex")]);
    // A variant without bitcode imports nothing.
    expect(
      await loadRuntimeBitcode({
        target: MACOS_ARM64_TARGET,
        features: { ...BASE, dynamic: true },
        resolver,
      }),
    ).toBeNull();
    await writeFile(join(root, "artifacts/base.bc"), "damaged");
    await expect(
      loadRuntimeBitcode({ target: MACOS_ARM64_TARGET, features: BASE, resolver }),
    ).rejects.toThrow("hash mismatch");
    const malformed = structuredClone(withBitcode);
    malformed.flavors.speed!.runtime_units[0]!.variants[0]!.bitcode = {
      path: "../escape.bc",
      sha256: "0".repeat(64),
      size: 1,
    };
    expect(() => parseRuntimePackManifest(malformed)).toThrow("malformed");
  });

  test("a stale manifest reports its identity independently from the package", async () => {
    const { packagePath, manifest, root } = await fixture();
    await writeFile(
      join(root, "runtime-pack.json"),
      JSON.stringify({ ...manifest, version: "0.0.0" }),
    );
    await expect(
      loadRuntimePack({
        target: MACOS_ARM64_TARGET,
        features: BASE,
        optimization: "release",
        resolver: () => packagePath,
      }),
    ).rejects.toThrow(
      `found package @scriptc/runtime-darwin-arm64@${VERSION} with manifest @scriptc/runtime-darwin-arm64@0.0.0`,
    );
  });

  test("malformed manifests and damaged artifacts fail before linking", async () => {
    const { packagePath, manifest, root } = await fixture();
    expect(() => parseRuntimePackManifest({ ...manifest, format: 2 })).toThrow("malformed");
    await writeFile(join(root, "artifacts/base.o"), "damaged");
    await expect(
      loadRuntimePack({
        target: MACOS_ARM64_TARGET,
        features: BASE,
        optimization: "release",
        resolver: () => packagePath,
      }),
    ).rejects.toThrow("hash mismatch");
    expect(await readFile(packagePath, "utf8")).toContain("runtime-darwin-arm64");
  });

  test("rejects a selected artifact replaced before private link staging", async () => {
    const { root, packagePath } = await fixture();
    const programObject = join(root, "program.o");
    const output = join(root, "program");
    const linker = join(root, "linker.mjs");
    await Promise.all([
      writeFile(programObject, "program object"),
      writeFile(
        linker,
        [
          "#!/usr/bin/env node",
          'import { writeFileSync } from "node:fs";',
          'const outputIndex = process.argv.indexOf("-o");',
          'writeFileSync(process.argv[outputIndex + 1], "linked executable");',
          "",
        ].join("\n"),
      ),
    ]);
    await chmod(linker, 0o755);
    const plan = await createNativeLinkPlan({
      target: MACOS_ARM64_TARGET,
      programObject,
      outPath: output,
      features: BASE,
      ffi: null,
      optimization: "release",
      resolver: () => packagePath,
    });
    await writeFile(join(root, "artifacts/base.o"), "tampered");

    await expect(linkNativeExecutable(plan, { linker })).rejects.toBeInstanceOf(RuntimePackError);
    expect(
      await stat(output).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("links a private verified copy when the installed artifact changes during linking", async () => {
    const { root, packagePath } = await fixture();
    const programObject = join(root, "program.o");
    const runtimeObject = join(root, "artifacts/base.o");
    const output = join(root, "program");
    const linker = join(root, "linker.mjs");
    await Promise.all([
      writeFile(programObject, "program object"),
      writeFile(
        linker,
        [
          "#!/usr/bin/env node",
          'import { readFileSync, writeFileSync } from "node:fs";',
          `const installed = ${JSON.stringify(runtimeObject)};`,
          'const outputIndex = process.argv.indexOf("-o");',
          'const staged = process.argv.find((arg) => arg.endsWith("/artifacts/base.o"));',
          "if (staged === undefined || staged === installed) process.exit(2);",
          'writeFileSync(installed, "tampered");',
          "writeFileSync(process.argv[outputIndex + 1], readFileSync(staged));",
          "",
        ].join("\n"),
      ),
    ]);
    await chmod(linker, 0o755);
    const plan = await createNativeLinkPlan({
      target: MACOS_ARM64_TARGET,
      programObject,
      outPath: output,
      features: BASE,
      ffi: null,
      optimization: "release",
      resolver: () => packagePath,
    });

    await linkNativeExecutable(plan, { linker });

    expect(await readFile(output, "utf8")).toBe("base");
    expect(await readFile(runtimeObject, "utf8")).toBe("tampered");
  });

  test("preserves the requested basename in the private linker output path", async () => {
    const { root, packagePath } = await fixture();
    const programObject = join(root, "program.o");
    const output = join(root, "requested-name");
    const linker = join(root, "linker.mjs");
    await Promise.all([
      writeFile(programObject, "program object"),
      writeFile(
        linker,
        [
          "#!/usr/bin/env node",
          'import { writeFileSync } from "node:fs";',
          'const outputIndex = process.argv.indexOf("-o");',
          "const output = process.argv[outputIndex + 1];",
          "writeFileSync(output, JSON.stringify(output));",
          "",
        ].join("\n"),
      ),
    ]);
    await chmod(linker, 0o755);
    const plan = await createNativeLinkPlan({
      target: MACOS_ARM64_TARGET,
      programObject,
      outPath: output,
      features: BASE,
      ffi: null,
      optimization: "release",
      resolver: () => packagePath,
    });

    await linkNativeExecutable(plan, { linker });

    const privateOutput = JSON.parse(await readFile(output, "utf8")) as string;
    expect(privateOutput).not.toBe(output);
    expect(basename(privateOutput)).toBe(basename(output));
    expect(dirname(dirname(privateOutput))).toBe(dirname(output));
  });

  test("does not publish a cache proof from a stale program-object dependency snapshot", async () => {
    const { root, packagePath } = await fixture();
    const programObject = join(root, "program.o");
    const helper = join(root, "helper");
    const output = join(root, "program");
    const linker = join(root, "linker.mjs");
    await Promise.all([
      writeFile(programObject, "program object"),
      writeFile(helper, "helper before emission"),
      writeFile(
        linker,
        [
          "#!/usr/bin/env node",
          'import { writeFileSync } from "node:fs";',
          'const outputIndex = process.argv.indexOf("-o");',
          'writeFileSync(process.argv[outputIndex + 1], "linked executable");',
          "",
        ].join("\n"),
      ),
    ]);
    await chmod(linker, 0o755);
    const helperDependencies = await snapshotNativeArtifactDependencies([helper]);
    await writeFile(helper, "helper replaced during emission");
    const plan = await createNativeLinkPlan({
      target: MACOS_ARM64_TARGET,
      programObject,
      outPath: output,
      features: BASE,
      ffi: null,
      optimization: "release",
      programObjectDependencies: helperDependencies,
      resolver: () => packagePath,
    });
    let published = false;

    await linkNativeExecutable(plan, {
      linker,
      onArtifactReady: async () => {
        published = true;
      },
    });

    expect(await readFile(output, "utf8")).toBe("linked executable");
    expect(published).toBe(false);
  });

  test("cache proofs follow the selected driver to its linker, SDK, and compiler runtime", async () => {
    const { root, packagePath } = await fixture();
    const programObject = join(root, "program.o");
    const output = join(root, "program");
    const driver = join(root, "clang.mjs");
    const platformLinker = join(root, "toolchain", "ld");
    const sdkSettings = join(root, "driver-sdk", "SDKSettings.json");
    const systemStub = join(root, "driver-sdk", "usr", "lib", "libSystem.tbd");
    const compilerRuntime = join(root, "toolchain", "libclang_rt.osx.a");
    await Promise.all([
      mkdir(dirname(platformLinker), { recursive: true }),
      mkdir(dirname(systemStub), { recursive: true }),
      writeFile(programObject, "program object"),
    ]);
    await Promise.all([
      writeFile(platformLinker, "selected platform linker"),
      writeFile(sdkSettings, "selected SDK settings"),
      writeFile(systemStub, "selected System stub"),
      writeFile(compilerRuntime, "selected compiler runtime"),
      writeFile(
        driver,
        [
          "#!/usr/bin/env node",
          'import { writeFileSync } from "node:fs";',
          `const dependencies = ${JSON.stringify([
            platformLinker,
            sdkSettings,
            systemStub,
            compilerRuntime,
          ])};`,
          "const args = process.argv.slice(2);",
          'const outputIndex = args.indexOf("-o");',
          'if (args.includes("-print-prog-name=ld")) {',
          `  process.stdout.write(${JSON.stringify(`${platformLinker}\n`)});`,
          "  process.exit(0);",
          "}",
          'if (args.includes("-###")) {',
          '  process.stderr.write(`${dependencies.map(JSON.stringify).join(" ")}\\n`);',
          "  process.exit(0);",
          "}",
          'if (args.includes("-Wl,-t")) {',
          '  process.stdout.write(`${dependencies.join("\\n")}\\n`);',
          '  writeFileSync(args[outputIndex + 1], "link trace output");',
          "  process.exit(0);",
          "}",
          'writeFileSync(args[outputIndex + 1], args.includes("-c") ? "probe object" : "linked executable");',
          "",
        ].join("\n"),
      ),
    ]);
    await chmod(driver, 0o755);
    const plan = await createNativeLinkPlan({
      target: MACOS_ARM64_TARGET,
      programObject,
      outPath: output,
      features: BASE,
      ffi: null,
      optimization: "release",
      resolver: () => packagePath,
    });
    let dependencyPaths: string[] = [];

    await linkNativeExecutable(plan, {
      linker: driver,
      onArtifactReady: async ({ dependencies }) => {
        dependencyPaths = dependencies.map((dependency) => dependency.path);
      },
    });

    expect(await readFile(output, "utf8")).toBe("linked executable");
    expect(dependencyPaths).toEqual(
      expect.arrayContaining([platformLinker, sdkSettings, systemStub, compilerRuntime]),
    );
  });

  test("does not publish an executable cache proof when a dependency changes during linking", async () => {
    const { root, packagePath } = await fixture();
    const programObject = join(root, "program.o");
    const dependency = join(root, "link-dependency.a");
    const output = join(root, "program");
    const linker = join(root, "linker.mjs");
    const platformLinker = join(root, "ld");
    await Promise.all([
      writeFile(programObject, "program object"),
      writeFile(dependency, "before link"),
      writeFile(platformLinker, "selected platform linker"),
      writeFile(
        linker,
        [
          "#!/usr/bin/env node",
          'import { writeFileSync } from "node:fs";',
          `const dependency = ${JSON.stringify(dependency)};`,
          `const platformLinker = ${JSON.stringify(platformLinker)};`,
          "const args = process.argv.slice(2);",
          'const outputIndex = args.indexOf("-o");',
          'if (args.includes("-print-prog-name=ld")) {',
          "  process.stdout.write(`${platformLinker}\\n`);",
          "  process.exit(0);",
          "}",
          'if (args.includes("-###")) {',
          "  process.stderr.write(`${JSON.stringify(platformLinker)} ${JSON.stringify(dependency)}\\n`);",
          "  process.exit(0);",
          "}",
          'if (args.includes("-Wl,-t")) {',
          "  process.stdout.write(`${platformLinker}\\n${dependency}\\n`);",
          '  writeFileSync(args[outputIndex + 1], "link trace output");',
          "  process.exit(0);",
          "}",
          "if (outputIndex < 0) process.exit(2);",
          'if (args.includes("-c")) {',
          '  writeFileSync(args[outputIndex + 1], "probe object");',
          "  process.exit(0);",
          "}",
          'writeFileSync(dependency, "changed during link");',
          'writeFileSync(args[outputIndex + 1], "linked executable");',
          "",
        ].join("\n"),
      ),
    ]);
    await chmod(linker, 0o755);
    const plan = await createNativeLinkPlan({
      target: MACOS_ARM64_TARGET,
      programObject,
      outPath: output,
      features: BASE,
      ffi: null,
      optimization: "release",
      programObjectDependencies: await snapshotNativeArtifactDependencies([dependency]),
      resolver: () => packagePath,
    });
    let published = false;

    await linkNativeExecutable(plan, {
      linker,
      onArtifactReady: async () => {
        published = true;
      },
    });

    expect(await readFile(output, "utf8")).toBe("linked executable");
    expect(published).toBe(false);
  });
});

test("library runtime selection requires dedicated packs and never substitutes executable objects", async () => {
  const f = await fixture();
  const options = {
    target: MACOS_ARM64_TARGET,
    features: BASE,
    optimization: "release" as const,
    resolver: () => f.packagePath,
  };
  await expect(loadRuntimePack({ ...options, mode: "library" })).rejects.toThrow(
    "no library-release flavor",
  );
  await expect(loadRuntimePack({ ...options, mode: "library-thread" })).rejects.toThrow(
    "no library-thread-release flavor",
  );
  const unit = f.manifest.flavors.release!.runtime_units[0]!;
  const variant = unit.variants[0]!;
  for (const [name, defines] of [
    ["library-release", ["SCR_LIB"]],
    ["library-thread-release", ["SCR_LIB", "SCR_THREAD_INSTANCES"]],
  ] as const) {
    f.manifest.flavors[name] = {
      optimization: "-O2",
      runtime_units: [{ ...unit, variants: [{ ...variant, defines: [...defines] }] }],
    };
  }
  await writeFile(join(f.root, "runtime-pack.json"), JSON.stringify(f.manifest));
  const threaded = await loadRuntimePack({ ...options, mode: "library-thread" });
  expect(threaded.runtimeObjects.map((path) => basename(path))).toEqual(["base.o"]);
  await expect(
    loadRuntimePack({ ...options, features: { ...BASE, dynamic: true }, mode: "library" }),
  ).rejects.toThrow("do not support dynamic");
  delete f.manifest.flavors.release;
  delete f.manifest.flavors.dev;
  await writeFile(join(f.root, "runtime-pack.json"), JSON.stringify(f.manifest));
  await expect(loadRuntimePack({ ...options, mode: "library-thread" })).resolves.toMatchObject({
    runtimeObjects: threaded.runtimeObjects,
  });
  await expect(loadRuntimePack(options)).rejects.toThrow("no release flavor");
});

test("speed selects the pack's speed flavor and falls back to release objects without one", async () => {
  const f = await fixture();
  const options = {
    target: MACOS_ARM64_TARGET,
    features: BASE,
    resolver: () => f.packagePath,
  };
  // A pack without a speed flavor links its release objects for speed.
  const fallback = await loadRuntimePack({ ...options, optimization: "speed" });
  expect(fallback.flavor).toBe("speed");
  expect(fallback.runtimeObjects.map((path) => basename(path))).toEqual(["base.o"]);

  const bytes = "speed";
  await writeFile(join(f.root, "artifacts/speed.o"), bytes);
  const speedArtifact = {
    path: "artifacts/speed.o",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: Buffer.byteLength(bytes),
  };
  const unit = f.manifest.flavors.release!.runtime_units[0]!;
  f.manifest.flavors.speed = {
    optimization: "-O2",
    runtime_units: [
      {
        ...unit,
        variants: unit.variants.map((variant) =>
          variant.id === "default" ? { ...variant, ...speedArtifact } : variant,
        ),
      },
    ],
  };
  await writeFile(join(f.root, "runtime-pack.json"), JSON.stringify(f.manifest));
  const speed = await loadRuntimePack({ ...options, optimization: "speed" });
  expect(speed.runtimeObjects.map((path) => basename(path))).toEqual(["speed.o"]);
  // Release and dev never see the speed flavor's objects.
  const release = await loadRuntimePack({ ...options, optimization: "release" });
  expect(release.runtimeObjects.map((path) => basename(path))).toEqual(["base.o"]);
  // Library modes have no speed flavor and link their release objects.
  f.manifest.flavors["library-release"] = {
    optimization: "-O2",
    runtime_units: [{ ...unit, variants: [{ ...unit.variants[0]!, defines: ["SCR_LIB"] }] }],
  };
  await writeFile(join(f.root, "runtime-pack.json"), JSON.stringify(f.manifest));
  await expect(
    loadRuntimePack({ ...options, optimization: "speed", mode: "library" }),
  ).resolves.toMatchObject({ runtimeObjects: release.runtimeObjects });
  // A speed flavor must be optimized and accompany the release flavor.
  expect(() =>
    parseRuntimePackManifest({
      ...f.manifest,
      flavors: { ...f.manifest.flavors, speed: { optimization: "-O0", runtime_units: [unit] } },
    }),
  ).toThrow("malformed");
  const { release: _release, dev: _dev, ...withoutExecutable } = f.manifest.flavors;
  expect(() => parseRuntimePackManifest({ ...f.manifest, flavors: withoutExecutable })).toThrow(
    "malformed",
  );
});
