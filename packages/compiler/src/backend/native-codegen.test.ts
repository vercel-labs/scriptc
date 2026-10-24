import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  emitNativeArtifact,
  writeLlvmSource,
  NativeCodegenError,
  validateNativeCodegenVersion,
} from "./native-codegen.js";
import {
  inlineThresholdArgs,
  nativeInlineThreshold,
  nativePartitionPaths,
  nativeProgramPartitions,
} from "./native-codegen-core.js";
import { nativeArtifactDependenciesStillMatch } from "./native-toolchain.js";
import { LINUX_X64_GNU_TARGET, MACOS_ARM64_TARGET, WASM32_WASI_TARGET } from "./targets.js";
import { compilerReleaseVersion } from "../library/sidecar.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fakePackage(
  options: {
    protocol?: string;
    packageVersion?: string;
    emitFailure?: boolean;
    emptyOutput?: boolean;
    missingOutput?: boolean;
    changePackageDuringEmit?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "scriptc-native-helper-test-"));
  dirs.push(root);
  const packageJson = join(root, "package.json");
  const bin = join(root, "bin", "scriptc-llvm-codegen");
  const log = join(root, "calls.log");
  await mkdir(join(root, "bin"));
  await writeFile(packageJson, JSON.stringify({ name: MACOS_ARM64_TARGET.helperPackage }));
  const version = JSON.stringify({
    ok: true,
    protocol_version: options.protocol ?? "1",
    scriptc_package_version: options.packageVersion ?? compilerReleaseVersion(),
    llvm_version: "22.1.8",
    host_triple: "arm64-apple-darwin24.0.0",
    targets: ["AArch64"],
    supported_targets: [MACOS_ARM64_TARGET.llvmTriple],
    default_target: MACOS_ARM64_TARGET.llvmTriple,
    data_layout: MACOS_ARM64_TARGET.dataLayout,
  });
  await writeFile(
    bin,
    `#!/bin/sh
if [ "$1" = version ]; then
  printf '%s\\n' '${version}'
  exit 0
fi
printf '%s\\n' "$*" >> '${log}'
output=''
outputs=''
input=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then output="$2"; outputs="$outputs $2"; shift 2; continue; fi
  if [ "$1" = --input ]; then input="$2"; shift 2; continue; fi
  shift
done
${options.changePackageDuringEmit === true ? `printf '\\n' >> '${packageJson}'` : ""}
${
  options.emitFailure === true
    ? 'printf \'%s\\n\' \'{"ok":false,"code":"verification_failed","message":"bad module"}\' >&2; exit 1'
    : options.emptyOutput === true
      ? ': > "$output"'
      : options.missingOutput === true
        ? ":"
        : 'for each in $outputs; do cp "$input" "$each"; done'
}
`,
  );
  await chmod(bin, 0o755);
  return { packageJson, bin, log, root };
}

function request(
  root: string,
  packageJson: string,
  output = join(root, "program.o"),
  target = MACOS_ARM64_TARGET,
) {
  return {
    outputPath: output,
    llvm: "define i32 @answer() { ret i32 42 }\n",
    outputKind: "obj" as const,
    sourcePath: "/source/app.ts",
    target,
    helperHost: { platform: "darwin" as const, arch: "arm64" },
    resolvePackageJson: () => packageJson,
    cacheRoot: join(root, "cache"),
  };
}

test("resolves the build host's platform helper", async () => {
  const pkg = await fakePackage();
  const output = join(pkg.root, "linux.o");
  await writeFile(pkg.packageJson, JSON.stringify({ name: LINUX_X64_GNU_TARGET.helperPackage }));
  await writeFile(
    pkg.bin,
    (await readFile(pkg.bin, "utf8"))
      .replaceAll(MACOS_ARM64_TARGET.llvmTriple, LINUX_X64_GNU_TARGET.helper.defaultTarget)
      .replaceAll(MACOS_ARM64_TARGET.dataLayout, LINUX_X64_GNU_TARGET.helper.defaultDataLayout)
      .replaceAll('"targets":["AArch64"]', '"targets":["X86"]')
      .replaceAll(
        `"supported_targets":["${MACOS_ARM64_TARGET.llvmTriple}"]`,
        `"supported_targets":["${LINUX_X64_GNU_TARGET.llvmTriple}"]`,
      ),
  );
  await emitNativeArtifact({
    ...request(pkg.root, pkg.packageJson, output, LINUX_X64_GNU_TARGET),
    helperHost: { platform: "linux", arch: "x64", linuxLibc: "gnu" },
  });
  expect(await readFile(output, "utf8")).toContain("define i32 @answer");
});

test("requires a portable target backend in addition to the host helper backend", async () => {
  const pkg = await fakePackage();
  await expect(
    emitNativeArtifact({
      ...request(pkg.root, pkg.packageJson, join(pkg.root, "program.wasm"), WASM32_WASI_TARGET),
      helperHost: { platform: "darwin", arch: "arm64" },
    }),
  ).rejects.toMatchObject({ diagnosticCode: "SC3003", detailCode: "version_mismatch" });
});

test("accepts a WASI-capable helper whose default host target differs", () => {
  const helper = WASM32_WASI_TARGET.hostHelpers?.["darwin-arm64"];
  if (!helper) throw new Error("missing darwin-arm64 WASI helper fixture");
  expect(
    validateNativeCodegenVersion(
      {
        ok: true,
        protocol_version: "1",
        scriptc_package_version: compilerReleaseVersion(),
        llvm_version: "22.1.8",
        host_triple: "arm64-apple-darwin25.0.0",
        targets: ["AArch64", "WebAssembly"],
        supported_targets: [helper.defaultTarget, WASM32_WASI_TARGET.llvmTriple],
        default_target: helper.defaultTarget,
        data_layout: helper.defaultDataLayout,
      },
      WASM32_WASI_TARGET,
      helper,
    ).targets,
  ).toContain("WebAssembly");
});

test("resolves a package helper, emits atomically, and caches by all native inputs", async () => {
  const pkg = await fakePackage();
  const first = join(pkg.root, "first.o");
  const second = join(pkg.root, "second.o");
  const firstArtifact = await emitNativeArtifact(request(pkg.root, pkg.packageJson, first));
  const secondArtifact = await emitNativeArtifact(request(pkg.root, pkg.packageJson, second));
  expect(await readFile(first, "utf8")).toContain("define i32 @answer");
  expect(await readFile(second)).toEqual(await readFile(first));
  const expectedMode = 0o666 & ~process.umask();
  expect((await stat(first)).mode & 0o777).toBe(expectedMode);
  expect((await stat(second)).mode & 0o777).toBe(expectedMode);
  expect((await readFile(pkg.log, "utf8")).trim().split("\n")).toHaveLength(1);
  expect(firstArtifact.dependencies.map((dependency) => dependency.path)).toEqual(
    [pkg.bin, pkg.packageJson].sort(),
  );
  expect(secondArtifact.dependencies).toEqual(firstArtifact.dependencies);
});

test("profiles reach the helper and key the native cache by their bytes", async () => {
  const pkg = await fakePackage();
  const base = request(pkg.root, pkg.packageJson, join(pkg.root, "plain.o"));
  await emitNativeArtifact(base);
  await emitNativeArtifact({
    ...base,
    outputPath: join(pkg.root, "instrumented.o"),
    profile: { generate: "/profiles/%p.profraw" },
  });
  const used = {
    ...base,
    outputPath: join(pkg.root, "used.o"),
    profile: { use: { path: "/profiles/a.profdata", digest: "a".repeat(64) } },
  };
  await emitNativeArtifact(used);
  await emitNativeArtifact({
    ...used,
    outputPath: join(pkg.root, "changed.o"),
    profile: { use: { path: "/profiles/a.profdata", digest: "b".repeat(64) } },
  });
  await emitNativeArtifact({ ...used, outputPath: join(pkg.root, "again.o") });
  const calls = (await readFile(pkg.log, "utf8")).trim().split("\n");
  expect(calls).toHaveLength(4);
  expect(calls[0]).not.toContain("--profile-");
  expect(calls[1]).toContain("--profile-generate /profiles/%p.profraw");
  expect(calls[2]).toContain("--profile-use /profiles/a.profdata");
});

test("chunked LLVM input preserves emitted bytes and the native cache identity", async () => {
  const pkg = await fakePackage();
  const first = request(pkg.root, pkg.packageJson, join(pkg.root, "chunks.o"));
  const chunks = [first.llvm.slice(0, 17), first.llvm.slice(17, 23), first.llvm.slice(23)];
  await emitNativeArtifact({ ...first, llvm: chunks });
  const second = request(pkg.root, pkg.packageJson, join(pkg.root, "text.o"));
  await emitNativeArtifact(second);
  expect(await readFile(first.outputPath, "utf8")).toBe(first.llvm);
  expect(await readFile(second.outputPath)).toEqual(await readFile(first.outputPath));
  expect((await readFile(pkg.log, "utf8")).trim().split("\n")).toHaveLength(1);
});

test("returns the pre-emission helper snapshot when its package changes during emission", async () => {
  const pkg = await fakePackage({ changePackageDuringEmit: true });

  const artifact = await emitNativeArtifact(request(pkg.root, pkg.packageJson));

  expect(await readFile(join(pkg.root, "program.o"), "utf8")).toContain("define i32 @answer");
  expect(await nativeArtifactDependenciesStillMatch(artifact.dependencies)).toBe(false);
  expect(
    await stat(join(pkg.root, "cache", "native-codegen-v1")).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});

test("cache publication failures do not discard a valid requested artifact", async () => {
  const pkg = await fakePackage();
  const cacheRoot = join(pkg.root, "cache");
  const output = join(pkg.root, "uncached-success.o");
  await mkdir(cacheRoot, { mode: 0o700 });
  // Block creation of the cache family below an otherwise valid cache root.
  await writeFile(join(cacheRoot, "native-codegen-v1"), "not a directory\n");

  await emitNativeArtifact({
    ...request(pkg.root, pkg.packageJson, output),
    cacheRoot,
  });

  expect(await readFile(output, "utf8")).toContain("define i32 @answer");
  expect((await readFile(pkg.log, "utf8")).trim().split("\n")).toHaveLength(1);
});

test("reports a missing platform package as an actionable installation diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "scriptc-native-missing-test-"));
  dirs.push(root);
  await expect(
    emitNativeArtifact({
      ...request(root, join(root, "missing.json")),
      resolvePackageJson: () => {
        throw new Error("missing");
      },
    }),
  ).rejects.toMatchObject({
    diagnosticCode: "SC3003",
    detailCode: "missing_package",
    message: expect.stringContaining("optional dependencies"),
  });
});

test.skipIf(process.platform === "win32")(
  "reports unreadable or non-executable helper binaries as installation failures",
  async () => {
    for (const mode of [0o111, 0o644]) {
      const pkg = await fakePackage();
      await chmod(pkg.bin, mode);
      await expect(emitNativeArtifact(request(pkg.root, pkg.packageJson))).rejects.toMatchObject({
        diagnosticCode: "SC3003",
        detailCode: "unusable_binary",
        message: expect.stringContaining("reinstall scriptc"),
      });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "reports helper identity execution failures as installation failures",
  async () => {
    const pkg = await fakePackage();
    await writeFile(pkg.bin, "#!/definitely/missing/scriptc-interpreter\n");
    await chmod(pkg.bin, 0o755);
    await expect(emitNativeArtifact(request(pkg.root, pkg.packageJson))).rejects.toMatchObject({
      diagnosticCode: "SC3003",
      detailCode: "identity_probe_failed",
      message: expect.stringContaining("identity check"),
    });
  },
);

test("rejects protocol and package-version mismatches before emission", async () => {
  for (const options of [{ protocol: "99" }, { packageVersion: "9.9.9" }]) {
    const pkg = await fakePackage(options);
    await expect(emitNativeArtifact(request(pkg.root, pkg.packageJson))).rejects.toMatchObject({
      diagnosticCode: "SC3003",
      detailCode: "version_mismatch",
    });
  }
});

test("translates structured helper failures and preserves an existing output", async () => {
  const pkg = await fakePackage({ emitFailure: true });
  const output = join(pkg.root, "existing.o");
  await writeFile(output, "caller artifact\n");
  await expect(
    emitNativeArtifact(request(pkg.root, pkg.packageJson, output)),
  ).rejects.toMatchObject({
    diagnosticCode: "SC3004",
    detailCode: "verification_failed",
    message: expect.stringContaining("bad module"),
  });
  expect(await readFile(output, "utf8")).toBe("caller artifact\n");
});

test("rejects a successful helper that leaves an empty staged output", async () => {
  const pkg = await fakePackage({ emptyOutput: true });
  await expect(emitNativeArtifact(request(pkg.root, pkg.packageJson))).rejects.toMatchObject({
    diagnosticCode: "SC3004",
    detailCode: "empty_output",
  });
});

test("rejects a successful helper that creates no staged output", async () => {
  const pkg = await fakePackage({ missingOutput: true });
  await expect(emitNativeArtifact(request(pkg.root, pkg.packageJson))).rejects.toMatchObject({
    diagnosticCode: "SC3004",
    detailCode: "empty_output",
    message: expect.stringContaining("non-empty regular artifact"),
  });
});

test("sanitized native artifacts fail before helper resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "scriptc-native-sanitize-test-"));
  dirs.push(root);
  await expect(
    emitNativeArtifact({
      ...request(root, join(root, "unused.json")),
      sanitize: true,
      resolvePackageJson: () => {
        throw new Error("must not resolve");
      },
    }),
  ).rejects.toBeInstanceOf(NativeCodegenError);
  await expect(
    emitNativeArtifact({
      ...request(root, join(root, "unused.json")),
      sanitize: true,
      resolvePackageJson: () => {
        throw new Error("must not resolve");
      },
    }),
  ).rejects.toMatchObject({ diagnosticCode: "SC3002", detailCode: "sanitize_unsupported" });
});

test("program partitions depend only on module size", () => {
  const megabyte = 1024 * 1024;
  expect(nativeProgramPartitions(megabyte)).toBe(1);
  expect(nativeProgramPartitions(megabyte + 1)).toBe(4);
  expect(nativeProgramPartitions(2 * megabyte)).toBe(4);
  expect(nativeProgramPartitions(2 * megabyte + 1)).toBe(8);
  expect(nativeProgramPartitions(32 * megabyte)).toBe(8);
  // Powers of two keep every function in its partition across small edits.
  expect(nativeProgramPartitions(32 * megabyte + 1)).toBe(16);
  expect(nativeProgramPartitions(100 * megabyte)).toBe(32);
  expect(nativeProgramPartitions(1024 * megabyte)).toBe(64);
  expect(nativePartitionPaths("/build.d/program.o", 3)).toEqual([
    "/build.d/program.o",
    "/build.d/program.part1.o",
    "/build.d/program.part2.o",
  ]);
  expect(nativePartitionPaths("C:\\build.d\\program", 2)).toEqual([
    "C:\\build.d\\program",
    "C:\\build.d\\program.part1",
  ]);
});

test("partitioned objects are emitted, cached and restored together", async () => {
  const pkg = await fakePackage();
  const first = join(pkg.root, "first", "program.o");
  const artifact = await emitNativeArtifact({
    ...request(pkg.root, pkg.packageJson, first),
    partitions: 3,
  });
  expect(artifact.outputPaths).toEqual(nativePartitionPaths(first, 3));
  for (const path of artifact.outputPaths)
    expect(await readFile(path, "utf8")).toBe("define i32 @answer() { ret i32 42 }\n");
  const calls = (await readFile(pkg.log, "utf8")).trim().split("\n");
  expect(calls).toHaveLength(1);
  const args = calls[0]!.split(" ");
  expect(args.filter((arg) => arg === "--output")).toHaveLength(3);
  // Partition artifacts are reused from a private directory per helper build.
  const partitionCache = args[args.indexOf("--cache-dir") + 1]!;
  expect(partitionCache).toMatch(/[/\\]cache[/\\]native-partitions-v1[/\\][0-9a-f]{32}$/);
  expect((await stat(partitionCache)).mode & 0o777).toBe(0o700);

  const second = join(pkg.root, "second", "program.o");
  const restored = await emitNativeArtifact({
    ...request(pkg.root, pkg.packageJson, second),
    partitions: 3,
  });
  expect(restored.outputPaths).toEqual(nativePartitionPaths(second, 3));
  for (const path of restored.outputPaths) expect((await stat(path)).size).toBeGreaterThan(0);
  expect((await readFile(pkg.log, "utf8")).trim().split("\n")).toHaveLength(1);

  // A single object for the same module is a distinct artifact.
  await emitNativeArtifact(request(pkg.root, pkg.packageJson, join(pkg.root, "whole.o")));
  const all = (await readFile(pkg.log, "utf8")).trim().split("\n");
  expect(all).toHaveLength(2);
  expect(all[1]).not.toContain("--cache-dir");
});

test("large release programs inline less, and speed and dev builds keep the default", () => {
  expect(nativeInlineThreshold("release", 16)).toBe(100);
  expect(nativeInlineThreshold(undefined, 64)).toBe(100);
  expect(nativeInlineThreshold("release", 8)).toBeUndefined();
  expect(nativeInlineThreshold("release", 1)).toBeUndefined();
  expect(nativeInlineThreshold("speed", 64)).toBeUndefined();
  expect(nativeInlineThreshold("dev", 64)).toBeUndefined();
  expect(inlineThresholdArgs(100)).toEqual(["--inline-threshold", "100"]);
  expect(inlineThresholdArgs(undefined)).toEqual([]);
});

test("the inline threshold reaches the helper and keys the native cache", async () => {
  const pkg = await fakePackage();
  const base = request(pkg.root, pkg.packageJson, join(pkg.root, "default", "program.o"));
  await emitNativeArtifact({ ...base, partitions: 16 });
  await emitNativeArtifact({
    ...request(pkg.root, pkg.packageJson, join(pkg.root, "reduced", "program.o")),
    partitions: 16,
    inlineThreshold: 100,
  });
  const calls = (await readFile(pkg.log, "utf8")).trim().split("\n");
  expect(calls).toHaveLength(2);
  expect(calls[0]).not.toContain("--inline-threshold");
  expect(calls[1]).toContain("--inline-threshold 100");
});

test("LLVM text parts are written as one file and the helper reads a private copy", async () => {
  const pkg = await fakePackage();
  const parts = Array.from({ length: 5000 }, (_, index) => `; part ${index} \u00e9\n`);
  const written = join(pkg.root, "parts.ll");
  await writeLlvmSource(written, parts);
  expect(await readFile(written, "utf8")).toBe(parts.join(""));

  // The caller's .ll can be shared by a concurrent build of another entry
  // with the same stem, so the helper never reads it directly.
  const output = join(pkg.root, "private", "program.o");
  await emitNativeArtifact({
    ...request(pkg.root, pkg.packageJson, output),
    llvm: parts,
    cacheRoot: null,
  });
  const call = (await readFile(pkg.log, "utf8")).trim().split(" ");
  const input = call[call.indexOf("--input") + 1]!;
  expect(input).not.toBe(written);
  expect(dirname(input)).toBe(dirname(output));
  expect(await readFile(output, "utf8")).toBe(parts.join(""));
  await expect(stat(input)).rejects.toThrow();
});
