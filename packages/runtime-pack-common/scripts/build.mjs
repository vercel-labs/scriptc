#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { availableParallelism, tmpdir } from "node:os";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRuntimePackMatrix } from "../runtime-pack-matrix.mjs";
import { createDeterministicArchive } from "./archive.mjs";
import { installRuntimePack, withBuildLock } from "./build-state.mjs";

const run = promisify(execFile);
const packageRoot = process.env.SCRIPTC_RUNTIME_PACK_ROOT;
const configText = process.env.SCRIPTC_RUNTIME_PACK_CONFIG;
if (!packageRoot || !configText) throw new Error("runtime-pack build requires package wrapper configuration");
const config = JSON.parse(configText);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const runtimeRoot = join(repoRoot, "packages/runtime");
const runtimeSrc = join(runtimeRoot, "src");
const vendorRoot = join(runtimeRoot, "vendor");
const outputRoot = join(packageRoot, "artifacts");
const manifestPath = join(packageRoot, "runtime-pack.json");
const matrix = createRuntimePackMatrix(config);

async function build() {
  const buildRoot = join(packageRoot, `.runtime-pack-build-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const stagedOutputRoot = join(buildRoot, "artifacts");
  const stagedManifestPath = join(buildRoot, "runtime-pack.json");
  const artifactPath = (path) => ["artifacts", ...relative(stagedOutputRoot, path).split(sep)].join("/");
  const sourcePathFlags = [`-ffile-prefix-map=${buildRoot}=${packageRoot}`, `-ffile-prefix-map=${repoRoot}=.`];
  const packageManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const compiler = process.env.CC ?? config.compiler ?? "clang";
  const compilerArgs = config.compilerArgs ?? [];
  const archiver = process.env.AR ?? config.archiver ?? "ar";
  const archiverArgs = config.archiverArgs ?? [];
  const commonFlags = [
    ...config.targetArgs, "-std=c11", ...(config.threadArgs ?? []), "-fno-math-errno", "-fno-strict-aliasing",
    ...matrix.executable_section_elimination.compile_flags, "-Wno-deprecated-declarations", "-I", runtimeSrc,
    ...(config.runtimeDefines ?? []).map((define) => `-D${define}`),
  ];
  const quickjs = join(vendorRoot, "quickjs-ng");
  const zlib = join(vendorRoot, "zlib");
  const mbedtls = join(vendorRoot, "mbedtls");
  const qjsSources = ["dtoa.c", "libregexp.c", "libunicode.c", "quickjs.c"];
  const lreSources = ["libregexp.c", "libunicode.c"];
  const zlibSources = ["adler32.c", "compress.c", "crc32.c", "deflate.c", "infback.c", "inffast.c", "inflate.c", "inftrees.c", "trees.c", "uncompr.c", "zutil.c"];
  const sha256 = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
  const compile = async (source, output, flags) => {
    await mkdir(dirname(output), { recursive: true });
    await run(compiler, [...compilerArgs, ...sourcePathFlags, ...flags, "-c", source, "-o", output]);
  };
  const parallel = async (items, task) => {
    const width = Math.max(1, Math.min(8, availableParallelism()));
    for (let i = 0; i < items.length; i += width) await Promise.all(items.slice(i, i + width).map(task));
  };
  const archive = async (id, sources, sourceRoot, flags) => {
    const root = join(stagedOutputRoot, "vendor", id);
    const objectRoot = join(root, "objects");
    await parallel(sources, async (source) => compile(join(sourceRoot, source), join(objectRoot, source.replace(/\.c$/, ".o")), flags));
    const output = join(root, `libscriptc-${id}.a`);
    await createDeterministicArchive(archiver, output, sources.map((source) => join(objectRoot, source.replace(/\.c$/, ".o"))), archiverArgs);
    await rm(objectRoot, { recursive: true, force: true });
    return { id, path: artifactPath(output), sha256: await sha256(output), size: (await stat(output)).size };
  };
  await rm(buildRoot, { recursive: true, force: true });
  try {
    await mkdir(stagedOutputRoot, { recursive: true });
    // Zig 0.16 creates a zero-byte `a.o` in its working directory for
    // `zig cc --version`. Probe from a private temporary directory so a
    // runtime-pack build never leaves that compiler byproduct in the package.
    const versionProbeRoot = await mkdtemp(join(tmpdir(), "scriptc-runtime-pack-version-"));
    let compilerVersion;
    try {
      compilerVersion = (await run(compiler, [...compilerArgs, "--version"], {
        cwd: versionProbeRoot,
      })).stdout.split("\n", 1)[0].trim();
    } finally {
      await rm(versionProbeRoot, { recursive: true, force: true });
    }
    const flavors = {};
    for (const [flavor, flavorSpec] of Object.entries(matrix.flavors)) {
      const units = [];
      for (const unit of matrix.runtime_units) {
        const variants = [];
        for (const variant of unit.variants) {
          const output = join(stagedOutputRoot, flavor, "runtime", variant.id, unit.source.replace(/\.c$/, ".o"));
          const includeFlags = [
            ...(unit.source === "scr_regex.c" || variant.defines.includes("SCR_DYNAMIC") ? ["-I", quickjs] : []),
            ...(unit.source === "scr_tls.c" ? ["-I", join(mbedtls, "include")] : []),
            ...(unit.source === "scr_zlib.c" || unit.source === "scr_fetch.c" ? ["-I", zlib] : []),
          ];
          await compile(join(runtimeSrc, unit.source), output, [...commonFlags, flavorSpec.optimization, ...variant.defines.map((define) => `-D${define}`), ...includeFlags]);
          variants.push({ id: variant.id, when: variant.when, defines: variant.defines, path: artifactPath(output), sha256: await sha256(output), size: (await stat(output)).size });
        }
        units.push({ source: unit.source, predicate: unit.predicate, variants });
      }
      flavors[flavor] = { optimization: flavorSpec.optimization, runtime_units: units };
    }
    const mbedtlsSources = (await readdir(join(mbedtls, "library"))).filter((name) => !name.startsWith(".") && name.endsWith(".c")).sort();
    // Vendored QuickJS reads `clock_gettime` for its monotonic clock. WASI
    // exposes that declaration only when its process-clock emulation ABI is
    // selected, so vendor sources inherit the target's runtime defines too.
    const vendorTarget = [
      ...config.targetArgs,
      ...(config.runtimeDefines ?? []).map((define) => `-D${define}`),
    ];
    const requestedArchives = new Set(matrix.archives.map((entry) => entry.id));
    const archives = config.vendorArchives === false ? [] : [
      ...(requestedArchives.has("quickjs") ? [await archive("quickjs", qjsSources, quickjs, [...vendorTarget, "-std=gnu11", "-fvisibility=hidden", "-funsigned-char", "-DQUICKJS_NG_BUILD", "-D_GNU_SOURCE", "-DNDEBUG", "-Os", "-I", quickjs])] : []),
      ...(requestedArchives.has("libregexp") ? [await archive("libregexp", lreSources, quickjs, [...vendorTarget, "-std=c11", "-Os", "-I", quickjs])] : []),
      ...(requestedArchives.has("zlib") ? [await archive("zlib", zlibSources, zlib, [...vendorTarget, "-std=c11", "-Os", "-I", zlib])] : []),
      ...(requestedArchives.has("mbedtls") ? [await archive("mbedtls", mbedtlsSources, join(mbedtls, "library"), [...vendorTarget, "-std=c11", "-Os", "-I", join(mbedtls, "include"), "-I", join(mbedtls, "library")])] : []),
    ];
    const archiveSpecs = new Map(matrix.archives.map((entry) => [entry.id, entry]));
    const licensed = [[join(runtimeRoot, "LICENSE"), "artifacts/licenses/scriptc-runtime.txt", "Apache-2.0"], [join(quickjs, "LICENSE"), "artifacts/licenses/quickjs-ng.txt", "MIT"], [join(vendorRoot, "ryu", "LICENSE-Boost"), "artifacts/licenses/ryu.txt", "BSL-1.0"], [join(zlib, "LICENSE"), "artifacts/licenses/zlib.txt", "Zlib"], [join(mbedtls, "LICENSE"), "artifacts/licenses/mbedtls.txt", "Apache-2.0"]];
    await Promise.all(licensed.map(async ([source, destination]) => { const output = join(buildRoot, destination); await mkdir(dirname(output), { recursive: true }); await copyFile(source, output); }));
    const manifest = { schema: "scriptc.runtime-pack.v1", format: 1, package: packageManifest.name, version: packageManifest.version, target: matrix.target, runtime_abi: { version: 1, marker: "scr_runtime_abi_v1" }, compiler: { command: compiler, identity: compilerVersion, target: matrix.target.llvm_triple }, macros: { executable: ["SCR_DYNAMIC", "SCR_TEXT_DECODER_LEGACY"], excluded: ["SCR_LIB", "SCR_THREAD_INSTANCES", "SCR_RC_AUDIT", "SCR_ASAN_FIBERS"], sanitizer: "external-toolchain-required" }, flavors, archives: archives.map((entry) => ({ ...entry, predicate: archiveSpecs.get(entry.id).predicate })), system_libraries: matrix.system_libraries, licenses: licensed.map(([, path, license]) => ({ path, license })) };
    await writeFile(stagedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    await installRuntimePack({ outputRoot, manifestPath, stagedOutputRoot, stagedManifestPath, backupRoot: join(packageRoot, `.runtime-pack-artifacts-backup-${suffix}`), backupManifestPath: join(packageRoot, `.runtime-pack-manifest-backup-${suffix}`) });
    process.stdout.write(`built ${packageManifest.name}@${packageManifest.version}: ${Object.keys(flavors).length} flavors, ${archives.length} vendor archives\n`);
  } finally { await rm(buildRoot, { recursive: true, force: true }); }
}
await withBuildLock(join(packageRoot, ".runtime-pack-build.lock"), build);
