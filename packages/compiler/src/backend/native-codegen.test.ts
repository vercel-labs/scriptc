import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { emitNativeArtifact, NativeCodegenError } from "./native-codegen.js";
import { MACOS_ARM64_TARGET } from "./targets.js";
import { compilerReleaseVersion } from "../library/sidecar.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fakePackage(options: {
  protocol?: string;
  packageVersion?: string;
  emitFailure?: boolean;
  emptyOutput?: boolean;
} = {}) {
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
    default_target: MACOS_ARM64_TARGET.llvmTriple,
    data_layout: MACOS_ARM64_TARGET.dataLayout,
  });
  await writeFile(bin, `#!/bin/sh
if [ "$1" = version ]; then
  printf '%s\\n' '${version}'
  exit 0
fi
printf '%s\\n' "$*" >> '${log}'
output=''
input=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then output="$2"; shift 2; continue; fi
  if [ "$1" = --input ]; then input="$2"; shift 2; continue; fi
  shift
done
${options.emitFailure === true
    ? "printf '%s\\n' '{\"ok\":false,\"code\":\"verification_failed\",\"message\":\"bad module\"}' >&2; exit 1"
    : options.emptyOutput === true
      ? ': > "$output"'
      : 'cp "$input" "$output"'}
`);
  await chmod(bin, 0o755);
  return { packageJson, log, root };
}

function request(root: string, packageJson: string, output = join(root, "program.o")) {
  return {
    outputPath: output,
    llvm: "define i32 @answer() { ret i32 42 }\n",
    outputKind: "obj" as const,
    sourcePath: "/source/app.ts",
    target: MACOS_ARM64_TARGET,
    resolvePackageJson: () => packageJson,
    cacheRoot: join(root, "cache"),
  };
}

test("resolves a package helper, emits atomically, and caches by all native inputs", async () => {
  const pkg = await fakePackage();
  const first = join(pkg.root, "first.o");
  const second = join(pkg.root, "second.o");
  await emitNativeArtifact(request(pkg.root, pkg.packageJson, first));
  await emitNativeArtifact(request(pkg.root, pkg.packageJson, second));
  expect(await readFile(first, "utf8")).toContain("define i32 @answer");
  expect(await readFile(second)).toEqual(await readFile(first));
  expect((await readFile(pkg.log, "utf8")).trim().split("\n")).toHaveLength(1);
});

test("reports a missing platform package as an actionable installation diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "scriptc-native-missing-test-"));
  dirs.push(root);
  await expect(emitNativeArtifact({
    ...request(root, join(root, "missing.json")),
    resolvePackageJson: () => { throw new Error("missing"); },
  })).rejects.toMatchObject({
    diagnosticCode: "SC3003",
    detailCode: "missing_package",
    message: expect.stringContaining("optional dependencies"),
  });
});

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
  await expect(emitNativeArtifact(request(pkg.root, pkg.packageJson, output))).rejects.toMatchObject({
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

test("sanitized native artifacts fail before helper resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "scriptc-native-sanitize-test-"));
  dirs.push(root);
  await expect(emitNativeArtifact({
    ...request(root, join(root, "unused.json")),
    sanitize: true,
    resolvePackageJson: () => { throw new Error("must not resolve"); },
  })).rejects.toBeInstanceOf(NativeCodegenError);
  await expect(emitNativeArtifact({
    ...request(root, join(root, "unused.json")),
    sanitize: true,
    resolvePackageJson: () => { throw new Error("must not resolve"); },
  })).rejects.toMatchObject({ diagnosticCode: "SC3002", detailCode: "sanitize_unsupported" });
});
