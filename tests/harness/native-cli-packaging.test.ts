import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";

const repository = join(import.meta.dirname, "../..");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(windows = true) {
  const directory = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-package-paths-"),
  );
  directories.push(directory);
  const packages = join(directory, "packages");
  const platform = windows ? "win32-x64-msvc" : "linux-x64-gnu";
  const target = windows ? "x86_64-windows-msvc" : "x86_64-linux-gnu";
  const cli = join(packages, `cli-${platform}`);
  const distribution = join(cli, "dist");
  const executable = windows ? "scriptc.exe" : "scriptc";
  const manifestPath = join(distribution, "bin", executable + ".json");
  const write = (path: string, data: string | Buffer) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  };
  const identity = { name: `@scriptc/cli-${platform}`, version: "1.2.3" };
  const runtimeIdentity = { name: `@scriptc/runtime-${platform}`, version: identity.version };
  const runtime = {
    schema: "scriptc.runtime-pack.v1",
    package: runtimeIdentity.name,
    version: identity.version,
    target: { name: target },
  };
  const asset = (path: string) => (windows ? path.replaceAll("/", "\\") : path);
  const manifest = {
    schema: "scriptc.native-toolchain.v1",
    compiler_version: identity.version,
    target,
    ts7: asset(`../lib/typescript/lib/tsc${windows ? ".exe" : ""}`),
    tsc_ts: asset(`../lib/tsc-ts/lib/tsc-ts${windows ? ".exe" : ""}`),
    llvm_package: asset("../lib/llvm"),
    runtime_pack: asset("../lib/runtime"),
    runtime_sources: asset("../lib/runtime-sources"),
    declarations: asset("../lib/declarations"),
    comptime: asset(`../lib/scriptc-comptime${windows ? ".exe" : ""}`),
    wasi_node_runner: asset("../lib/wasi/wasi-runner.js"),
    runtime_packs: [{ target, path: asset("../lib/runtime") }],
  };
  write(join(cli, "package.json"), JSON.stringify(identity));
  write(join(distribution, "bin", executable), Buffer.alloc(2048, 1));
  chmodSync(join(distribution, "bin", executable), 0o755);
  write(manifestPath, JSON.stringify(manifest));
  for (const path of [
    manifest.ts7,
    manifest.tsc_ts,
    manifest.comptime,
    manifest.wasi_node_runner,
  ]) {
    write(join(distribution, "bin", path.replaceAll("\\", "/")), "fixture");
  }
  write(
    join(
      distribution,
      "lib/llvm/bin",
      windows ? "scriptc-llvm-codegen.exe" : "scriptc-llvm-codegen",
    ),
    "fixture",
  );
  write(
    join(distribution, "lib/llvm/package.json"),
    JSON.stringify({ name: `@scriptc/llvm-${platform}`, version: identity.version }),
  );
  mkdirSync(join(distribution, "lib/runtime-sources/vendor"), { recursive: true });
  mkdirSync(join(distribution, "lib/declarations"), { recursive: true });
  for (const path of [join(distribution, "lib/runtime"), join(packages, `runtime-${platform}`)]) {
    write(join(path, "package.json"), JSON.stringify(runtimeIdentity));
    write(join(path, "runtime-pack.json"), JSON.stringify(runtime));
    write(join(path, "artifacts/runtime.o"), "runtime object");
  }
  for (const path of ["LICENSE", "THIRD_PARTY_NOTICES"]) write(join(distribution, path), "license");
  write(
    join(packages, "compiler/package.json"),
    JSON.stringify({
      version: identity.version,
      optionalDependencies: { [runtimeIdentity.name]: identity.version },
    }),
  );
  return { directory, packages, cli, platform, executable, manifestPath, manifest };
}

function run(script: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(repository, "scripts", script), ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

test.each([true, false])(
  "verify and archive a native distribution across packaging hosts (Windows=%s)",
  (windows) => {
    const f = fixture(windows);
    const original = readFileSync(f.manifestPath);
    const verified = run("verify-native-cli.mjs", f.cli);
    expect(verified.status, verified.stderr).toBe(0);
    const output = join(f.directory, "archives");
    const packed = run("package-native-cli.mjs", f.packages, output);
    expect(packed.status, packed.stderr).toBe(0);
    const filename = `scriptc-1.2.3-${f.platform}.tar.gz`;
    const archive = join(output, filename);
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    expect(readFileSync(join(output, "SHA256SUMS"), "utf8")).toBe(`${digest}  ${filename}\n`);
    const unpacked = join(f.directory, "unpacked");
    mkdirSync(unpacked);
    const extracted = spawnSync("tar", ["-xzf", archive, "-C", unpacked], { encoding: "utf8" });
    expect(extracted.status, extracted.stderr).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(unpacked, "bin", f.executable + ".json"), "utf8"),
    );
    expect(manifest.ts7).toBe(f.manifest.ts7);
    expect(manifest.tsc_ts).toBe(f.manifest.tsc_ts);
    const runtime = manifest.runtime_packs[0];
    expect(
      JSON.parse(
        readFileSync(
          join(unpacked, "bin", runtime.path.replaceAll("\\", "/"), "runtime-pack.json"),
          "utf8",
        ),
      ).target.name,
    ).toBe(f.manifest.target);
    expect(manifest.runtime_packs).toEqual(f.manifest.runtime_packs);
    expect(readFileSync(f.manifestPath)).toEqual(original);
  },
);

test.each([true, false])(
  "a platform package depends on its helper and runtime pack, and its archive bundles them (Windows=%s)",
  (windows) => {
    const f = fixture(windows);
    const helper = `@scriptc/llvm-${f.platform}`;
    const runtime = `@scriptc/runtime-${f.platform}`;
    const manifest: Record<string, unknown> = { ...f.manifest };
    delete manifest.llvm_package;
    delete manifest.runtime_pack;
    delete manifest.runtime_packs;
    writeFileSync(f.manifestPath, JSON.stringify(manifest));
    const notices = join(f.cli, "dist/THIRD_PARTY_NOTICES");
    writeFileSync(
      notices,
      `LLVM licensing and notices: LICENSE and THIRD_PARTY_NOTICES in the ${helper} package.\n`,
    );
    rmSync(join(f.cli, "dist/lib/llvm"), { recursive: true });
    rmSync(join(f.cli, "dist/lib/runtime"), { recursive: true });
    const helperPackage = join(f.packages, `llvm-${f.platform}`);
    const codegen = windows ? "scriptc-llvm-codegen.exe" : "scriptc-llvm-codegen";
    mkdirSync(join(helperPackage, "bin"), { recursive: true });
    for (const [name, directory] of [
      [helper, helperPackage],
      [runtime, join(f.packages, `runtime-${f.platform}`)],
    ] as const) {
      writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version: "1.2.3" }));
      // pnpm links workspace dependencies into the package's node_modules.
      mkdirSync(join(f.cli, "node_modules/@scriptc"), { recursive: true });
      symlinkSync(directory, join(f.cli, "node_modules", name), "junction");
    }
    writeFileSync(join(helperPackage, "bin", codegen), "helper");
    const identity = { name: `@scriptc/cli-${f.platform}`, version: "1.2.3" };
    writeFileSync(join(f.cli, "package.json"), JSON.stringify(identity));
    const missing = run("verify-native-cli.mjs", f.cli);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(`must depend on its @scriptc/llvm-* package at 1.2.3`);
    writeFileSync(
      join(f.cli, "package.json"),
      JSON.stringify({
        ...identity,
        dependencies: { [helper]: "1.2.3", [runtime]: "workspace:*" },
      }),
    );
    const verified = run("verify-native-cli.mjs", f.cli);
    expect(verified.status, verified.stderr).toBe(0);
    const output = join(f.directory, "archives");
    const packed = run("package-native-cli.mjs", f.packages, output);
    expect(packed.status, packed.stderr).toBe(0);
    const unpacked = join(f.directory, "unpacked");
    mkdirSync(unpacked);
    const archive = join(output, `scriptc-1.2.3-${f.platform}.tar.gz`);
    const extracted = spawnSync("tar", ["-xzf", archive, "-C", unpacked], { encoding: "utf8" });
    expect(extracted.status, extracted.stderr).toBe(0);
    const bundled = JSON.parse(readFileSync(join(unpacked, "bin", f.executable + ".json"), "utf8"));
    const slash = windows ? "\\" : "/";
    expect(bundled.llvm_package).toBe(["..", "lib", "llvm"].join(slash));
    expect(bundled.runtime_pack).toBe(["..", "lib", `runtime-${f.platform}`].join(slash));
    expect(bundled.runtime_packs).toEqual([
      { target: f.manifest.target, path: bundled.runtime_pack },
    ]);
    expect(readFileSync(join(unpacked, "lib/llvm/bin", codegen), "utf8")).toBe("helper");
    expect(
      JSON.parse(
        readFileSync(join(unpacked, `lib/runtime-${f.platform}/runtime-pack.json`), "utf8"),
      ).target.name,
    ).toBe(f.manifest.target);
    expect(readFileSync(join(unpacked, "THIRD_PARTY_NOTICES"), "utf8")).toBe(
      "LLVM licensing and notices: lib/llvm/LICENSE and lib/llvm/THIRD_PARTY_NOTICES.\n",
    );
    // The npm package itself is unchanged.
    expect(JSON.parse(readFileSync(f.manifestPath, "utf8"))).toEqual(manifest);
  },
);

test.each([
  "C:\\outside\\tsc.exe",
  "C:tsc.exe",
  "\\outside\\tsc.exe",
  "\\\\server\\share\\tsc.exe",
  "/outside/tsc.exe",
])("reject Windows rooted asset paths: %s", (path) => {
  const f = fixture();
  writeFileSync(f.manifestPath, JSON.stringify({ ...f.manifest, ts7: path }));
  const result = run("verify-native-cli.mjs", f.cli);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("native toolchain needs a relative ts7");
});

test("reject Windows traversal outside the distribution", () => {
  const f = fixture();
  writeFileSync(join(f.cli, "outside.exe"), "outside");
  writeFileSync(f.manifestPath, JSON.stringify({ ...f.manifest, ts7: "..\\..\\outside.exe" }));
  const result = run("verify-native-cli.mjs", f.cli);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("distribution references external asset");
});

test("reject Windows rooted runtime-pack paths", () => {
  const f = fixture();
  writeFileSync(
    f.manifestPath,
    JSON.stringify({
      ...f.manifest,
      runtime_packs: [{ target: f.manifest.target, path: "C:\\runtime" }],
    }),
  );
  const result = run("verify-native-cli.mjs", f.cli);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("native runtime pack paths must be relative");
});
