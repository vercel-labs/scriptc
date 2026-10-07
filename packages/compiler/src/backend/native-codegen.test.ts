import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  emitNativeArtifact,
  NativeCodegenError,
  validateNativeCodegenVersion,
} from "./native-codegen.js";
import { nativePartitionPaths, nativeProgramPartitions } from "./native-codegen-core.js";
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

test("program partitions depend only on optimized module size and target", () => {
  const megabyte = 1024 * 1024;
  expect(nativeProgramPartitions(LINUX_X64_GNU_TARGET, "release", megabyte - 1)).toBe(1);
  expect(nativeProgramPartitions(LINUX_X64_GNU_TARGET, "release", 3.5 * megabyte)).toBe(3);
  expect(nativeProgramPartitions(MACOS_ARM64_TARGET, "release", 100 * megabyte)).toBe(8);
  expect(nativeProgramPartitions(MACOS_ARM64_TARGET, "dev", 100 * megabyte)).toBe(1);
  expect(nativeProgramPartitions(WASM32_WASI_TARGET, "release", 100 * megabyte)).toBe(1);
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
  expect(calls[0]!.split(" ").filter((arg) => arg === "--output")).toHaveLength(3);

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
  expect((await readFile(pkg.log, "utf8")).trim().split("\n")).toHaveLength(2);
});
