#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { availableParallelism, tmpdir } from "node:os";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRuntimePackMatrix } from "../runtime-pack-matrix.mjs";
import { assertArtifactsExcludeStrings } from "./artifact-policy.mjs";
import { createDeterministicArchive } from "./archive.mjs";
import { buildRuntimeUnit, resolveRuntimeUnitHelper } from "./runtime-unit.mjs";
import { installRuntimePack, withBuildLock } from "./build-state.mjs";
import { parallelMap } from "./parallel-map.mjs";

const run = promisify(execFile);
const packageRoot = process.env.SCRIPTC_RUNTIME_PACK_ROOT;
const configText = process.env.SCRIPTC_RUNTIME_PACK_CONFIG;
if (!packageRoot || !configText)
  throw new Error("runtime-pack build requires package wrapper configuration");
const config = JSON.parse(configText);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const runtimeRoot = join(repoRoot, "packages/runtime");
const runtimeSrc = join(runtimeRoot, "src");
const vendorRoot = join(runtimeRoot, "vendor");
const outputRoot = join(packageRoot, "artifacts");
const manifestPath = join(packageRoot, "runtime-pack.json");
const matrix = createRuntimePackMatrix(config);

async function build() {
  const buildRoot = join(
    packageRoot,
    `.runtime-pack-build-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  const stagedOutputRoot = join(buildRoot, "artifacts");
  const stagedManifestPath = join(buildRoot, "runtime-pack.json");
  const artifactPath = (path) =>
    ["artifacts", ...relative(stagedOutputRoot, path).split(sep)].join("/");
  const sourcePathFlags = [
    `-ffile-prefix-map=${buildRoot}=${packageRoot}`,
    `-ffile-prefix-map=${repoRoot}=.`,
  ];
  const packageManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const compiler = process.env.CC ?? config.compiler ?? "clang";
  const compilerArgs = config.compilerArgs ?? [];
  const archiver = process.env.AR ?? config.archiver ?? "ar";
  const archiverArgs = config.archiverArgs ?? [];
  const commonFlags = [
    ...config.targetArgs,
    ...(config.compilerFlags ?? []),
    "-std=c11",
    ...(config.threadArgs ?? []),
    "-fno-math-errno",
    "-fno-strict-aliasing",
    ...matrix.executable_section_elimination.compile_flags,
    "-Wno-deprecated-declarations",
    "-I",
    runtimeSrc,
    ...(config.runtimeDefines ?? []).map((define) => `-D${define}`),
  ];
  // Vendored archives build at -Os, which drops function alignment entirely,
  // so their hot loops (the regex interpreter's above all) land wherever
  // surrounding code puts them and run up to ~15% slower or faster as
  // unrelated code changes size. Starting each vendored function on a
  // cache-line boundary keeps their placement fixed; it costs size only in
  // programs that link the archive. WASM code has no addresses to align.
  // libunicode's many small table helpers are exempt: they are not hot
  // loops, and aligning them was most of the regex programs' padding.
  const codeAlignment = config.platform === "wasi" ? [] : ["-falign-functions=64"];
  const unalignedVendorSources = new Set(["libunicode.c"]);
  // On x86-64 the speed flavor aligns the runtime's own functions as well:
  // generated loops that call runtime helpers otherwise swing by several
  // percent with the helpers' offsets within their cache lines. Release and
  // library flavors keep the compiler's default alignment, because aligning
  // every runtime function cost 2-11 KB per program, the largest share of
  // the default build's size budget (results/h45-size-budget). The runtime is
  // linked before the program either way, so program size changes never
  // move runtime code.
  const speedRuntimeAlignment = config.target.architecture === "x64" ? codeAlignment : [];
  const quickjs = join(vendorRoot, "quickjs-ng");
  const zlib = join(vendorRoot, "zlib");
  const mbedtls = join(vendorRoot, "mbedtls");
  const qjsSources = ["dtoa.c", "libregexp.c", "libunicode.c", "quickjs.c"];
  const lreSources = ["libregexp.c", "libunicode.c"];
  const zlibSources = [
    "adler32.c",
    "compress.c",
    "crc32.c",
    "deflate.c",
    "infback.c",
    "inffast.c",
    "inflate.c",
    "inftrees.c",
    "trees.c",
    "uncompr.c",
    "zutil.c",
  ];
  const sha256 = async (path) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const compile = async (source, output, flags) => {
    await mkdir(dirname(output), { recursive: true });
    // Zig emits DWARF by default even for optimized C. Packaged runtime
    // objects omit source debug payload, matching clang's default; the
    // compiler owns the program's development debug information.
    await run(compiler, [
      ...compilerArgs,
      ...sourcePathFlags,
      ...flags,
      "-g0",
      "-c",
      source,
      "-o",
      output,
    ]);
  };
  // Speed-flavor executable units are emitted through the host LLVM helper
  // so their object and import bitcode come from one promoted module.
  const unitHelper =
    config.bitcode === false
      ? null
      : await resolveRuntimeUnitHelper(repoRoot, matrix.target.llvm_triple);
  const parallel = async (items, task) => {
    const width = Math.max(1, Math.min(8, availableParallelism()));
    return parallelMap(items, width, task);
  };
  const archive = async (id, sources, sourceRoot, flags) => {
    process.stdout.write(`building ${packageManifest.name} ${id} archive\n`);
    const root = join(stagedOutputRoot, "vendor", id);
    const objectRoot = join(root, "objects");
    await parallel(sources, async (source) =>
      compile(
        join(sourceRoot, source),
        join(objectRoot, source.replace(/\.c$/, ".o")),
        unalignedVendorSources.has(source)
          ? flags.filter((flag) => !codeAlignment.includes(flag))
          : flags,
      ),
    );
    const output = join(root, `libscriptc-${id}.a`);
    await createDeterministicArchive(
      archiver,
      output,
      sources.map((source) => join(objectRoot, source.replace(/\.c$/, ".o"))),
      archiverArgs,
    );
    await rm(objectRoot, { recursive: true, force: true });
    return {
      id,
      path: artifactPath(output),
      sha256: await sha256(output),
      size: (await stat(output)).size,
    };
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
      compilerVersion = (
        await run(compiler, [...compilerArgs, "--version"], {
          cwd: versionProbeRoot,
        })
      ).stdout
        .split("\n", 1)[0]
        .trim();
    } finally {
      await rm(versionProbeRoot, { recursive: true, force: true });
    }
    const flavors = {};
    // The executable `speed` flavor (--optimization=speed) exists only when
    // it differs from release: its static units are emitted through the host
    // LLVM helper with import bitcode. Its SCR_DYNAMIC variants are the
    // release objects themselves.
    const flavorPlan = [
      ...Object.entries(matrix.flavors),
      ...("release" in matrix.flavors && unitHelper !== null
        ? [["speed", matrix.flavors.release]]
        : []),
    ];
    const releaseVariants = new Map();
    for (const [flavor, flavorSpec] of flavorPlan) {
      process.stdout.write(`building ${packageManifest.name} ${flavor} runtime\n`);
      // Zig emits DWARF by default, including descriptions of functions
      // removed by section GC. Release packs must opt out explicitly.
      // Zig keeps frame pointers by default; Linux release (and speed) units
      // drop them (unwinding still uses .eh_frame), which measurably speeds
      // the small hot runtime leaves. Dev flavors keep them.
      const debugFlags =
        flavor.endsWith("release") || flavor === "speed"
          ? [
              "-g0",
              ...(flavor === "speed" ? speedRuntimeAlignment : []),
              ...(config.platform === "linux" ? ["-fomit-frame-pointer"] : []),
            ]
          : [];
      const units = await parallel(
        flavorSpec.runtime_units ?? matrix.runtime_units,
        async (unit) => {
          const variants = [];
          for (const baseVariant of unit.variants) {
            const variant = {
              ...baseVariant,
              defines: [...(flavorSpec.defines ?? []), ...baseVariant.defines],
            };
            const variantKey = `${unit.source}\0${variant.id}`;
            if (flavor === "speed" && variant.defines.includes("SCR_DYNAMIC")) {
              variants.push(releaseVariants.get(variantKey));
              continue;
            }
            const output = join(
              stagedOutputRoot,
              flavor,
              "runtime",
              variant.id,
              unit.source.replace(/\.c$/, ".o"),
            );
            const includeFlags = [
              ...(unit.source === "scr_regex.c" || variant.defines.includes("SCR_DYNAMIC")
                ? ["-I", quickjs]
                : []),
              ...(unit.source === "scr_tls.c" ? ["-I", join(mbedtls, "include")] : []),
              ...(unit.source === "scr_zlib.c" || unit.source === "scr_fetch.c"
                ? ["-I", zlib]
                : []),
            ];
            const unitFlags = [
              ...commonFlags,
              flavorSpec.optimization,
              ...debugFlags,
              ...variant.defines.map((define) => `-D${define}`),
              ...includeFlags,
            ];
            let bitcode;
            const bitcodeOutput = output.replace(/\.o$/, ".bc");
            if (flavor === "speed") await mkdir(dirname(output), { recursive: true });
            if (
              flavor === "speed" &&
              (await buildRuntimeUnit({
                helper: unitHelper,
                compileBitcode: (optimized) =>
                  run(compiler, [
                    ...compilerArgs,
                    ...sourcePathFlags,
                    ...unitFlags,
                    "-g0",
                    "-emit-llvm",
                    "-c",
                    join(runtimeSrc, unit.source),
                    "-o",
                    optimized,
                  ]),
                object: output,
                bitcode: bitcodeOutput,
                triple: matrix.target.llvm_triple,
                tag: unit.source.replace(/\.c$/, ""),
                sections:
                  matrix.executable_section_elimination.compile_flags.includes(
                    "-ffunction-sections",
                  ),
              }))
            ) {
              bitcode = {
                path: artifactPath(bitcodeOutput),
                sha256: await sha256(bitcodeOutput),
                size: (await stat(bitcodeOutput)).size,
              };
            } else {
              await compile(join(runtimeSrc, unit.source), output, unitFlags);
            }
            const built = {
              id: variant.id,
              when: variant.when,
              defines: variant.defines,
              path: artifactPath(output),
              sha256: await sha256(output),
              size: (await stat(output)).size,
              ...(bitcode === undefined ? {} : { bitcode }),
            };
            if (flavor === "release") releaseVariants.set(variantKey, built);
            variants.push(built);
          }
          return { source: unit.source, predicate: unit.predicate, variants };
        },
      );
      flavors[flavor] = { optimization: flavorSpec.optimization, runtime_units: units };
    }
    const mbedtlsSources = (await readdir(join(mbedtls, "library")))
      .filter((name) => !name.startsWith(".") && name.endsWith(".c"))
      .sort();
    // Vendored QuickJS reads `clock_gettime` for its monotonic clock. WASI
    // exposes that declaration only when its process-clock emulation ABI is
    // selected, so vendor sources inherit the target's runtime defines too.
    const vendorTarget = [
      ...config.targetArgs,
      ...(config.compilerFlags ?? []),
      "-g0",
      ...codeAlignment,
      ...(config.runtimeDefines ?? []).map((define) => `-D${define}`),
    ];
    const requestedArchives = new Set(matrix.archives.map((entry) => entry.id));
    const archives =
      config.vendorArchives === false
        ? []
        : [
            ...(requestedArchives.has("quickjs")
              ? [
                  await archive("quickjs", qjsSources, quickjs, [
                    ...vendorTarget,
                    "-std=gnu11",
                    "-fvisibility=hidden",
                    "-funsigned-char",
                    "-DQUICKJS_NG_BUILD",
                    "-D_GNU_SOURCE",
                    "-DNDEBUG",
                    "-Os",
                    "-I",
                    quickjs,
                  ]),
                ]
              : []),
            ...(requestedArchives.has("libregexp")
              ? [
                  await archive("libregexp", lreSources, quickjs, [
                    ...vendorTarget,
                    "-std=c11",
                    "-Os",
                    "-I",
                    quickjs,
                  ]),
                ]
              : []),
            ...(requestedArchives.has("zlib")
              ? [
                  await archive("zlib", zlibSources, zlib, [
                    ...vendorTarget,
                    "-std=c11",
                    "-Os",
                    "-I",
                    zlib,
                  ]),
                ]
              : []),
            ...(requestedArchives.has("mbedtls")
              ? [
                  await archive("mbedtls", mbedtlsSources, join(mbedtls, "library"), [
                    ...vendorTarget,
                    "-std=c11",
                    "-Os",
                    "-I",
                    join(mbedtls, "include"),
                    "-I",
                    join(mbedtls, "library"),
                  ]),
                ]
              : []),
          ];
    await assertArtifactsExcludeStrings(stagedOutputRoot, config.forbiddenArtifactStrings ?? []);
    const archiveSpecs = new Map(matrix.archives.map((entry) => [entry.id, entry]));
    const licensed = [
      [join(runtimeRoot, "LICENSE"), "artifacts/licenses/scriptc-runtime.txt", "Apache-2.0"],
      [join(quickjs, "LICENSE"), "artifacts/licenses/quickjs-ng.txt", "MIT"],
      [join(vendorRoot, "ryu", "LICENSE-Boost"), "artifacts/licenses/ryu.txt", "BSL-1.0"],
      [
        join(vendorRoot, "v8-number-radix", "LICENSE"),
        "artifacts/licenses/v8-number-radix.txt",
        "BSD-3-Clause",
      ],
      [join(zlib, "LICENSE"), "artifacts/licenses/zlib.txt", "Zlib"],
      [join(mbedtls, "LICENSE"), "artifacts/licenses/mbedtls.txt", "Apache-2.0"],
    ];
    licensed.push([
      join(vendorRoot, "unicode", "LICENSE"),
      "artifacts/licenses/unicode.txt",
      "Unicode-3.0",
    ]);
    await Promise.all(
      licensed.map(async ([source, destination]) => {
        const output = join(buildRoot, destination);
        await mkdir(dirname(output), { recursive: true });
        await copyFile(source, output);
      }),
    );
    const manifest = {
      schema: "scriptc.runtime-pack.v1",
      format: 1,
      package: packageManifest.name,
      version: packageManifest.version,
      target: matrix.target,
      runtime_abi: { version: 8, marker: "scr_runtime_abi_v8" },
      compiler: {
        command: compiler,
        identity: compilerVersion,
        target: matrix.target.llvm_triple,
        ...(unitHelper === null ? {} : { speed_codegen: unitHelper.identity }),
      },
      macros: {
        executable: ["SCR_DYNAMIC", "SCR_TEXT_DECODER_LEGACY"],
        excluded: ["SCR_RC_AUDIT", "SCR_ASAN_FIBERS"],
        sanitizer: "external-toolchain-required",
      },
      flavors,
      archives: archives.map((entry) => ({
        ...entry,
        predicate: archiveSpecs.get(entry.id).predicate,
      })),
      system_libraries: matrix.system_libraries,
      licenses: licensed.map(([, path, license]) => ({ path, license })),
    };
    await writeFile(stagedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    await installRuntimePack({
      outputRoot,
      manifestPath,
      stagedOutputRoot,
      stagedManifestPath,
      backupRoot: join(packageRoot, `.runtime-pack-artifacts-backup-${suffix}`),
      backupManifestPath: join(packageRoot, `.runtime-pack-manifest-backup-${suffix}`),
    });
    process.stdout.write(
      `built ${packageManifest.name}@${packageManifest.version}: ${Object.keys(flavors).length} flavors, ${archives.length} vendor archives\n`,
    );
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
}
await withBuildLock(join(packageRoot, ".runtime-pack-build.lock"), build);
