import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { compilerReleaseVersion } from "../library/sidecar.js";
import { snapshotNativeArtifactDependencies } from "./native-toolchain.js";
import { nativeArtifactDependenciesStillMatch } from "./native/artifact-stamps.js";
import type { NativeLinkFeatures } from "./native-link-info.js";
import {
  effectiveRuntimeFeatures,
  evaluateRuntimePredicate,
  loadRuntimePack,
  parseRuntimePackManifest,
  RuntimePackError,
  type RuntimePackManifest,
} from "./runtime-pack.js";
import { HUGE_TEXT_MIN_CODE_BYTES } from "./huge-text.js";
import { createNativeLinkPlan } from "./link-plan.js";
import {
  executableLinkerEnvironmentFingerprint,
  linkNativeExecutable,
  missingLinkDriverMessage,
  platformLinkerSupportsPersistentCache,
  resolvePlatformLinker,
} from "./linker.js";
import {
  LINUX_X64_GNU_TARGET,
  MACOS_ARM64_TARGET,
  WINDOWS_X64_MSVC_TARGET,
  type NativeTargetSpec,
} from "./targets.js";

const VERSION = compilerReleaseVersion();

/** The first bytes of a program image.  The cache gate only needs a file that
 * is not a script interpreter line. */
const PROGRAM_IMAGE = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00]);

const BASE: NativeLinkFeatures = {
  regex: false,
  copying: false,
  textDecoderLegacy: false,
  bigintBytes: false,
  fileHandle: false,
  fetch: false,
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
  utilPromisify: false,
  dynBuiltinClass: false,
  dynBuiltinStream: false,
  parseArgs: false,
  stream: false,
  net: false,
  http: false,
  http2: false,
  dgram: false,
  dnsPromises: false,
  dgramDyn: false,
  textCodecDyn: false,
  watch: false,
  watchFile: false,
  fsBufferBrand: false,
  foreignFfi: false,
  nodeTest: false,
  tls: false,
  tlsCa: false,
  cipher: false,
  ecdh: false,
  dh: false,
  pki: false,
  ed25519: false,
  x509: false,
  webcrypto: false,
  perfLoop: false,
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
  const fileHandle = await artifact("artifacts/fileHandle.o", "fileHandle");
  const regex = await artifact("artifacts/regex.a", "regex");
  const zlib = await artifact("artifacts/zlib.a", "zlib");
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
        {
          id: "fileHandle",
          when: { fileHandle: true },
          defines: ["SCR_TEST_FILE_HANDLE"],
          ...fileHandle,
        },
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
    runtime_abi: { version: 48, marker: "scr_runtime_abi_v48" },
    compiler: {
      command: "clang",
      identity: "fixture clang",
      target: target.llvmTriple,
    },
    macros: {
      executable: ["SCR_TEST_FILE_HANDLE", "SCR_TEXT_DECODER_LEGACY"],
      excluded: ["SCR_LIB", "SCR_THREAD_INSTANCES", "SCR_RC_AUDIT"],
      sanitizer: "external-toolchain-required",
    },
    flavors: {
      release: { optimization: "-O2", runtime_units: units },
      dev: { optimization: "-O0", runtime_units: units },
    },
    archives: [
      { id: "libregexp", predicate: { all: ["regex"], not: ["fileHandle"] }, ...regex },
      { id: "zlib", predicate: "fileHandle", ...zlib },
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

  test("a Linux driver in any prefix may publish, an unreachable one may not", async () => {
    const toolDir = await mkdtemp(join(tmpdir(), "scriptc-linker-gate-"));
    await writeFile(join(toolDir, "clang"), PROGRAM_IMAGE);
    const env = { PATH: toolDir };
    expect(
      platformLinkerSupportsPersistentCache(env, { platform: "linux", defaultLinker: "clang" }),
    ).toBe(true);
    // A Darwin entry is only trusted from the system shim.
    expect(
      platformLinkerSupportsPersistentCache(env, { platform: "darwin", defaultLinker: "clang" }),
    ).toBe(false);
    expect(
      platformLinkerSupportsPersistentCache(env, { platform: "win32", defaultLinker: "clang" }),
    ).toBe(false);
    expect(
      platformLinkerSupportsPersistentCache(
        { PATH: join(toolDir, "empty") },
        { platform: "linux", defaultLinker: "clang" },
      ),
    ).toBe(false);
  });

  test("a script driver or linker never publishes a complete executable", async () => {
    // A script decides at run time what it runs, so its file identity does not
    // describe the link line, and a warm build would restore an executable
    // that an earlier configuration produced.
    const toolDir = await mkdtemp(join(tmpdir(), "scriptc-linker-gate-script-"));
    await writeFile(join(toolDir, "clang"), "#!/bin/sh\nexit 0\n");
    await chmod(join(toolDir, "clang"), 0o755);
    const env = { PATH: toolDir };
    expect(
      platformLinkerSupportsPersistentCache(env, { platform: "linux", defaultLinker: "clang" }),
    ).toBe(false);

    // The linker program `-fuse-ld=lld` selects is held to the same rule.
    await writeFile(join(toolDir, "clang"), PROGRAM_IMAGE);
    expect(
      platformLinkerSupportsPersistentCache(env, { platform: "linux", defaultLinker: "clang" }),
    ).toBe(true);
    await writeFile(join(toolDir, "ld.lld"), "#!/bin/sh\nexit 0\n");
    expect(
      platformLinkerSupportsPersistentCache(env, { platform: "linux", defaultLinker: "clang" }),
    ).toBe(false);
    await writeFile(join(toolDir, "ld.lld"), PROGRAM_IMAGE);
    expect(
      platformLinkerSupportsPersistentCache(env, { platform: "linux", defaultLinker: "clang" }),
    ).toBe(true);
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

  test("the linker environment follows the driver file itself", async () => {
    const root = await mkdtemp(join(tmpdir(), "scriptc-linker-driver-"));
    const driver = join(root, "clang");
    // An explicit driver keeps the probe results constant, so the driver's
    // own file identity is the only thing that differs between the two calls.
    const env = { SCRIPTC_LINKER: driver, PATH: root };
    await writeFile(driver, "#!/bin/sh\nexit 2\n");
    await chmod(driver, 0o755);
    const before = await executableLinkerEnvironmentFingerprint(env);
    // A different file at the same spelling, as a driver replacement leaves.
    await writeFile(driver, "#!/bin/sh\nexit 33\n");
    await chmod(driver, 0o755);
    const after = await executableLinkerEnvironmentFingerprint(env);
    expect(after).not.toBe(before);
  });

  test.skipIf(process.platform !== "linux")(
    "the linker environment follows the ld.lld beside the driver",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "scriptc-linker-lld-"));
      const driver = join(root, "clang");
      await writeFile(driver, "#!/bin/sh\nexit 0\n");
      await chmod(driver, 0o755);
      // An explicit driver keeps the fingerprint free of its own identity
      // probe, leaving the ld.lld lookup as the only difference.
      const env = { SCRIPTC_LINKER: driver, PATH: root };
      const before = await executableLinkerEnvironmentFingerprint(env);
      await writeFile(join(root, "ld.lld"), "#!/bin/sh\nexit 0\n");
      const after = await executableLinkerEnvironmentFingerprint(env);
      expect(after).not.toBe(before);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "the linker environment follows the default linker when no ld.lld is selected",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "scriptc-linker-default-"));
      const driver = join(root, "clang");
      await writeFile(
        driver,
        [
          "#!/bin/sh",
          'case "$1" in',
          '  -print-prog-name=clang) printf "%s\\n" "$0" ;;',
          '  -print-prog-name=ld) printf "%s\\n" "ld" ;;',
          "  *) exit 2 ;;",
          "esac",
          "",
        ].join("\n"),
      );
      await chmod(driver, 0o755);
      // The driver runs the linker program it reports, so leaving PATH alone
      // and installing that program is what changes the link line.
      const env = { SCRIPTC_LINKER: driver, PATH: root };
      const before = await executableLinkerEnvironmentFingerprint(env);
      await writeFile(join(root, "ld"), PROGRAM_IMAGE);
      const after = await executableLinkerEnvironmentFingerprint(env);
      expect(after).not.toBe(before);
    },
  );

  test("feature implications and predicates are deterministic", () => {
    const features = effectiveRuntimeFeatures({ ...BASE, fileHandle: true, fetch: true });
    expect(features).toMatchObject({
      nativeFetch: true,
      netEffective: true,
      httpEffective: true,
      tlsEffective: true,
      tlsCaEffective: true,
      zlibEffective: true,
    });
    expect(evaluateRuntimePredicate({ all: ["fetch"], not: ["regex"] }, features)).toBe(true);
    expect(evaluateRuntimePredicate({ any: ["regex", "fileHandle"] }, features)).toBe(true);
    // The JavaScript object model build implies the dynamic tier (t262-da
    // §J): its code is the dynamic tier's, so a program with it links the
    // dynamic-tier units too. A program without it keeps both off.
    const objectModel = effectiveRuntimeFeatures({ ...BASE, jsObjectModel: true });
    expect(objectModel).toMatchObject({ jsObjectModel: true, dynTier: true });
    // The features that share the build OR into it: BigInt views today, so a
    // program with them selects the object model build without naming it.
    const bigint = effectiveRuntimeFeatures({ ...BASE, bigintBytes: true });
    expect(bigint).toMatchObject({ bigintBytes: true, jsObjectModel: true, dynTier: true });
    const plain = effectiveRuntimeFeatures(BASE);
    expect(plain).toMatchObject({ jsObjectModel: false, dynTier: false, bigintBytes: false });
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

  test("Linux runtime-pack links are static PIE only when requested", async () => {
    const { packagePath, root } = await fixture(LINUX_X64_GNU_TARGET);
    const options = {
      target: LINUX_X64_GNU_TARGET,
      programObject: join(root, "program.o"),
      outPath: join(root, "program"),
      features: BASE,
      ffi: null,
      optimization: "release" as const,
      resolver: () => packagePath,
    };
    const defaultPlan = await createNativeLinkPlan(options);
    const staticPlan = await createNativeLinkPlan({ ...options, staticLink: true });
    expect(defaultPlan.driverFlags).not.toContain("-static-pie");
    expect(defaultPlan.staticLink).toBeUndefined();
    expect(staticPlan.driverFlags).toEqual([...defaultPlan.driverFlags, "-static-pie"]);
    expect(staticPlan.staticLink).toBe(true);
  });

  test("Linux links of large program code use huge text unless it is turned off", async () => {
    const { packagePath, root } = await fixture(LINUX_X64_GNU_TARGET);
    // An ELF64 relocatable object's headers with one executable section of
    // HUGE_TEXT_MIN_CODE_BYTES; only the headers are read.
    const object = Buffer.alloc(64 + 2 * 64);
    object.writeUInt32BE(0x7f454c46, 0);
    object[4] = 2;
    object[5] = 1;
    object.writeBigUInt64LE(64n, 40);
    object.writeUInt16LE(64, 58);
    object.writeUInt16LE(2, 60);
    object.writeUInt32LE(1, 128 + 4); // SHT_PROGBITS
    object.writeBigUInt64LE(0x6n, 128 + 8); // SHF_ALLOC | SHF_EXECINSTR
    object.writeBigUInt64LE(BigInt(HUGE_TEXT_MIN_CODE_BYTES), 128 + 32);
    await writeFile(join(root, "program.o"), object);
    const options = {
      target: LINUX_X64_GNU_TARGET,
      programObject: join(root, "program.o"),
      outPath: join(root, "program"),
      features: BASE,
      ffi: null,
      optimization: "release" as const,
      resolver: () => packagePath,
    };
    expect((await createNativeLinkPlan(options)).hugeText).toBe(true);
    expect((await createNativeLinkPlan({ ...options, hugeText: false })).hugeText).toBeUndefined();
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
    const fileHandle = await loadRuntimePack({
      target: MACOS_ARM64_TARGET,
      features: { ...BASE, fileHandle: true, regex: true },
      optimization: "dev",
      resolver,
    });
    expect(fileHandle.flavor).toBe("dev");
    expect(fileHandle.runtimeObjects.map((path) => path.split("/").at(-1))).toEqual([
      "fileHandle.o",
    ]);
    expect(fileHandle.archives.map((path) => path.split("/").at(-1))).toEqual(["zlib.a"]);
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

  test("a link driver the host cannot execute reports what to install", async () => {
    const { root, packagePath } = await fixture();
    const programObject = join(root, "program.o");
    await writeFile(programObject, "program object");
    const plan = await createNativeLinkPlan({
      target: MACOS_ARM64_TARGET,
      programObject,
      outPath: join(root, "program"),
      features: BASE,
      ffi: null,
      optimization: "release",
      resolver: () => packagePath,
    });
    const linker = join(root, "missing-linker");

    await expect(linkNativeExecutable(plan, { linker })).rejects.toMatchObject({
      name: "CcCompileError",
      driver: linker,
      message: expect.stringContaining(
        `cannot run the link driver "${linker}": the host has no missing-linker executable.`,
      ),
    });
  });

  test("a dev build whose link succeeds but cannot run dsymutil names dsymutil", async () => {
    const { root, packagePath } = await fixture();
    const programObject = join(root, "program.o");
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
      outPath: join(root, "program"),
      features: BASE,
      ffi: null,
      optimization: "dev",
      resolver: () => packagePath,
    });
    expect(plan.darwinDebugSymbols).toBe(true);

    const failure = await linkNativeExecutable(plan, { linker }).then(
      () => null,
      (error: unknown) => error as { name?: string; driver?: string; message?: string },
    );
    expect(failure?.name).toBe("CcCompileError");
    expect(failure?.driver).toBe("dsymutil");
    expect(failure?.message).toContain("dsymutil failed to collect the debug symbols for program:");
    expect(failure?.message).not.toContain("cannot run the link driver");
  });

  test("a missing driver names the toolchain its target links with", () => {
    const enoent = Object.assign(new Error("spawn zig ENOENT"), { code: "ENOENT" });
    expect(missingLinkDriverMessage(enoent, "zig", "win32")).toContain(
      "Windows targets link with Zig",
    );
    expect(missingLinkDriverMessage(enoent, "/usr/bin/clang", "darwin")).toContain(
      "xcode-select --install",
    );
    expect(missingLinkDriverMessage(enoent, "clang", "linux")).toContain("apt install clang");
    expect(missingLinkDriverMessage(enoent, "cc", "linux")).toContain("Install cc");
    expect(missingLinkDriverMessage(enoent, "zig", "wasi")).toContain("ziglang.org/download");
    expect(missingLinkDriverMessage(new Error("zig exited 1"), "zig", "win32")).toBeNull();
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

  test("a Linux link proof covers the driver, the linker it selects and the pack", async () => {
    const { root, packagePath } = await fixture(LINUX_X64_GNU_TARGET);
    const programObject = join(root, "program.o");
    const output = join(root, "program");
    const driver = join(root, "clang.mjs");
    const platformLinker = join(root, "toolchain", "ld");
    const runtimeArtifact = join(root, "artifacts", "base.o");
    await Promise.all([
      mkdir(dirname(platformLinker), { recursive: true }),
      writeFile(programObject, "program object"),
    ]);
    await Promise.all([
      writeFile(platformLinker, "selected platform linker"),
      writeFile(
        driver,
        [
          "#!/usr/bin/env node",
          'import { writeFileSync } from "node:fs";',
          "const args = process.argv.slice(2);",
          'const outputIndex = args.indexOf("-o");',
          'if (args.includes("-print-prog-name=ld")) {',
          `  process.stdout.write(${JSON.stringify(`${platformLinker}\n`)});`,
          "  process.exit(0);",
          "}",
          'if (args.includes("-###")) {',
          "  process.exit(0);",
          "}",
          'if (args.includes("-Wl,-t")) {',
          '  writeFileSync(args[outputIndex + 1], "link trace output");',
          "  process.exit(0);",
          "}",
          'writeFileSync(args[outputIndex + 1], "linked executable");',
          "",
        ].join("\n"),
      ),
    ]);
    await chmod(driver, 0o755);
    const plan = await createNativeLinkPlan({
      target: LINUX_X64_GNU_TARGET,
      programObject,
      outPath: output,
      features: BASE,
      ffi: null,
      optimization: "release",
      resolver: () => packagePath,
    });
    let dependencies: Awaited<ReturnType<typeof snapshotNativeArtifactDependencies>> = [];

    await linkNativeExecutable(plan, {
      linker: driver,
      onArtifactReady: async (artifact) => {
        dependencies = artifact.dependencies;
      },
    });

    expect(await readFile(output, "utf8")).toBe("linked executable");
    const paths = dependencies.map((dependency) => dependency.path);
    expect(paths).toEqual(expect.arrayContaining([driver, platformLinker, runtimeArtifact]));
    expect(await nativeArtifactDependenciesStillMatch(dependencies)).toBe(true);
    // A changed runtime pack invalidates the proof without touching the driver.
    await writeFile(runtimeArtifact, "rebuilt runtime object");
    expect(await nativeArtifactDependenciesStillMatch(dependencies)).toBe(false);
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
