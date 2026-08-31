import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { compilerReleaseVersion } from "../library/sidecar.js";
import { snapshotNativeArtifactDependencies } from "./native-toolchain.js";
import type { NativeLinkFeatures } from "./native-link-info.js";
import {
  createRuntimeLinkPlan,
  effectiveRuntimeFeatures,
  evaluateRuntimePredicate,
  linkRuntimePackExecutable,
  loadRuntimePack,
  parseRuntimePackManifest,
  type RuntimePackManifest,
} from "./runtime-pack.js";
import { MACOS_ARM64_TARGET } from "./targets.js";

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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scriptc-runtime-pack-unit-"));
  const packagePath = join(root, "package.json");
  await writeFile(packagePath, JSON.stringify({
    name: "@scriptc/runtime-darwin-arm64",
    version: VERSION,
  }));
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
  const units = [{
    source: "scr_bytes.c",
    predicate: true,
    variants: [
      { id: "default", when: {}, defines: [], ...base },
      { id: "legacy", when: { textDecoderLegacy: true }, defines: ["SCR_TEXT_DECODER_LEGACY"], ...legacy },
      { id: "dynamic", when: { dynamic: true }, defines: ["SCR_DYNAMIC"], ...dynamic },
    ],
  }];
  const manifest: RuntimePackManifest = {
    schema: "scriptc.runtime-pack.v1",
    format: 1,
    package: "@scriptc/runtime-darwin-arm64",
    version: VERSION,
    target: {
      name: "macos-arm64",
      llvm_triple: "arm64-apple-macosx14.0.0",
      architecture: "arm64",
      object_format: "macho",
      minimum_os: "14.0",
    },
    runtime_abi: { version: 1, marker: "scr_runtime_abi_v1" },
    compiler: {
      command: "clang",
      identity: "fixture clang",
      target: "arm64-apple-macosx14.0.0",
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
    const plan = await createRuntimeLinkPlan({
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

  test("malformed manifests and damaged artifacts fail before linking", async () => {
    const { packagePath, manifest, root } = await fixture();
    expect(() => parseRuntimePackManifest({ ...manifest, format: 2 })).toThrow("malformed");
    await writeFile(join(root, "artifacts/base.o"), "damaged");
    await expect(loadRuntimePack({
      target: MACOS_ARM64_TARGET,
      features: BASE,
      optimization: "release",
      resolver: () => packagePath,
    })).rejects.toThrow("hash mismatch");
    expect(await readFile(packagePath, "utf8")).toContain("runtime-darwin-arm64");
  });

  test("rejects a selected artifact replaced before private link staging", async () => {
    const { root, packagePath } = await fixture();
    const programObject = join(root, "program.o");
    const output = join(root, "program");
    const linker = join(root, "linker.mjs");
    await Promise.all([
      writeFile(programObject, "program object"),
      writeFile(linker, [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        'const outputIndex = process.argv.indexOf("-o");',
        'writeFileSync(process.argv[outputIndex + 1], "linked executable");',
        "",
      ].join("\n")),
    ]);
    await chmod(linker, 0o755);
    const plan = await createRuntimeLinkPlan({
      target: MACOS_ARM64_TARGET,
      programObject,
      outPath: output,
      features: BASE,
      ffi: null,
      optimization: "release",
      resolver: () => packagePath,
    });
    await writeFile(join(root, "artifacts/base.o"), "tampered");

    await expect(linkRuntimePackExecutable(plan, { linker })).rejects.toThrow(
      "runtime pack changed after artifact selection",
    );
    expect(await stat(output).then(() => true, () => false)).toBe(false);
  });

  test("links a private verified copy when the installed artifact changes during linking", async () => {
    const { root, packagePath } = await fixture();
    const programObject = join(root, "program.o");
    const runtimeObject = join(root, "artifacts/base.o");
    const output = join(root, "program");
    const linker = join(root, "linker.mjs");
    await Promise.all([
      writeFile(programObject, "program object"),
      writeFile(linker, [
        "#!/usr/bin/env node",
        'import { readFileSync, writeFileSync } from "node:fs";',
        `const installed = ${JSON.stringify(runtimeObject)};`,
        'const outputIndex = process.argv.indexOf("-o");',
        'const staged = process.argv.find((arg) => arg.endsWith("/artifacts/base.o"));',
        'if (staged === undefined || staged === installed) process.exit(2);',
        'writeFileSync(installed, "tampered");',
        'writeFileSync(process.argv[outputIndex + 1], readFileSync(staged));',
        "",
      ].join("\n")),
    ]);
    await chmod(linker, 0o755);
    const plan = await createRuntimeLinkPlan({
      target: MACOS_ARM64_TARGET,
      programObject,
      outPath: output,
      features: BASE,
      ffi: null,
      optimization: "release",
      resolver: () => packagePath,
    });

    await linkRuntimePackExecutable(plan, { linker });

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
      writeFile(linker, [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        'const outputIndex = process.argv.indexOf("-o");',
        'const output = process.argv[outputIndex + 1];',
        'writeFileSync(output, JSON.stringify(output));',
        "",
      ].join("\n")),
    ]);
    await chmod(linker, 0o755);
    const plan = await createRuntimeLinkPlan({
      target: MACOS_ARM64_TARGET,
      programObject,
      outPath: output,
      features: BASE,
      ffi: null,
      optimization: "release",
      resolver: () => packagePath,
    });

    await linkRuntimePackExecutable(plan, { linker });

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
      writeFile(linker, [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        'const outputIndex = process.argv.indexOf("-o");',
        'writeFileSync(process.argv[outputIndex + 1], "linked executable");',
        "",
      ].join("\n")),
    ]);
    await chmod(linker, 0o755);
    const helperDependencies = await snapshotNativeArtifactDependencies([helper]);
    await writeFile(helper, "helper replaced during emission");
    const plan = await createRuntimeLinkPlan({
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

    await linkRuntimePackExecutable(plan, {
      linker,
      onArtifactReady: async () => { published = true; },
    });

    expect(await readFile(output, "utf8")).toBe("linked executable");
    expect(published).toBe(false);
  });

  test(
    "cache proofs follow the selected driver to its linker, SDK, and compiler runtime",
    async () => {
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
        writeFile(driver, [
          "#!/usr/bin/env node",
          'import { writeFileSync } from "node:fs";',
          `const dependencies = ${JSON.stringify([
            platformLinker,
            sdkSettings,
            systemStub,
            compilerRuntime,
          ])};`,
          'const args = process.argv.slice(2);',
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
        ].join("\n")),
      ]);
      await chmod(driver, 0o755);
      const plan = await createRuntimeLinkPlan({
        target: MACOS_ARM64_TARGET,
        programObject,
        outPath: output,
        features: BASE,
        ffi: null,
        optimization: "release",
        resolver: () => packagePath,
      });
      let dependencyPaths: string[] = [];

      await linkRuntimePackExecutable(plan, {
        linker: driver,
        onArtifactReady: async ({ dependencies }) => {
          dependencyPaths = dependencies.map((dependency) => dependency.path);
        },
      });

      expect(await readFile(output, "utf8")).toBe("linked executable");
      expect(dependencyPaths).toEqual(expect.arrayContaining([
        platformLinker,
        sdkSettings,
        systemStub,
        compilerRuntime,
      ]));
    },
  );

  test(
    "does not publish an executable cache proof when a dependency changes during linking",
    async () => {
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
        writeFile(linker, [
          "#!/usr/bin/env node",
          'import { writeFileSync } from "node:fs";',
          `const dependency = ${JSON.stringify(dependency)};`,
          `const platformLinker = ${JSON.stringify(platformLinker)};`,
          'const args = process.argv.slice(2);',
          'const outputIndex = args.indexOf("-o");',
          'if (args.includes("-print-prog-name=ld")) {',
          '  process.stdout.write(`${platformLinker}\\n`);',
          "  process.exit(0);",
          "}",
          'if (args.includes("-###")) {',
          '  process.stderr.write(`${JSON.stringify(platformLinker)} ${JSON.stringify(dependency)}\\n`);',
          "  process.exit(0);",
          "}",
          'if (args.includes("-Wl,-t")) {',
          '  process.stdout.write(`${platformLinker}\\n${dependency}\\n`);',
          '  writeFileSync(args[outputIndex + 1], "link trace output");',
          "  process.exit(0);",
          "}",
          'if (outputIndex < 0) process.exit(2);',
          'if (args.includes("-c")) {',
          '  writeFileSync(args[outputIndex + 1], "probe object");',
          "  process.exit(0);",
          "}",
          'writeFileSync(dependency, "changed during link");',
          'writeFileSync(args[outputIndex + 1], "linked executable");',
          "",
        ].join("\n")),
      ]);
      await chmod(linker, 0o755);
      const plan = await createRuntimeLinkPlan({
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

      await linkRuntimePackExecutable(plan, {
        linker,
        onArtifactReady: async () => { published = true; },
      });

      expect(await readFile(output, "utf8")).toBe("linked executable");
      expect(published).toBe(false);
    },
  );
});
