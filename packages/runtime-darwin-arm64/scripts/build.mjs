#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { parallelMap } from "../../runtime-pack-common/scripts/parallel-map.mjs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RUNTIME_PACK_MATRIX } from "../runtime-pack-matrix.mjs";
import {
  buildImportBitcode,
  buildRuntimeUnit,
  resolveRuntimeUnitHelper,
} from "../../runtime-pack-common/scripts/runtime-unit.mjs";
import { createDeterministicArchive } from "./archive.mjs";
import { installRuntimePack, withBuildLock } from "./build-state.mjs";

const run = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const runtimeRoot = join(repoRoot, "packages/runtime");
const runtimeSrc = join(runtimeRoot, "src");
const vendorRoot = join(runtimeRoot, "vendor");
const outputRoot = join(packageRoot, "artifacts");
const manifestPath = join(packageRoot, "runtime-pack.json");

if (
  process.env.SCRIPTC_BUILD_CROSS !== "1" &&
  (process.platform !== "darwin" || process.arch !== "arm64")
) {
  process.stdout.write("@scriptc/runtime-darwin-arm64: skipped on this host\n");
  process.exit(0);
}

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
  const compiler = process.env.CC ?? "clang";
  const archiver = process.env.AR ?? "ar";
  const compilerVersion = (await run(compiler, ["--version"])).stdout.split("\n", 1)[0].trim();
  const commonFlags = [
    "-target",
    RUNTIME_PACK_MATRIX.target.llvm_triple,
    "-std=c11",
    "-pthread",
    "-fno-math-errno",
    "-fno-strict-aliasing",
    ...RUNTIME_PACK_MATRIX.executable_section_elimination.compile_flags,
    "-Wno-deprecated-declarations",
    "-I",
    runtimeSrc,
  ];
  // Vendored -Os archives start each function on a cache-line boundary so
  // their hot loops keep their placement when unrelated code changes size
  // (see the shared pack builder in runtime-pack-common).
  // libunicode's small table helpers are exempt (see runtime-pack-common).
  const codeAlignment = ["-falign-functions=64"];
  const unalignedVendorSources = new Set(["libunicode.c"]);
  const quickjs = join(vendorRoot, "quickjs-ng");
  const zlib = join(vendorRoot, "zlib");
  const mbedtls = join(vendorRoot, "mbedtls");
  const brotli = join(vendorRoot, "brotli", "c");
  const QJS_SOURCES = ["dtoa.c", "libregexp.c", "libunicode.c", "quickjs.c"];
  const LRE_SOURCES = ["libregexp.c", "libunicode.c"];
  const ZLIB_SOURCES = [
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

  // Speed-flavor executable units are emitted through the host LLVM helper
  // so their object and import bitcode come from one promoted module. The
  // helper also reduces release units' bitcode to what programs can import.
  const unitHelper = await resolveRuntimeUnitHelper(
    repoRoot,
    RUNTIME_PACK_MATRIX.target.llvm_triple,
  );

  async function sha256(path) {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }

  async function compile(source, output, flags) {
    await mkdir(dirname(output), { recursive: true });
    await run(compiler, [...sourcePathFlags, ...flags, "-c", source, "-o", output]);
  }

  async function parallel(items, task) {
    const width = Math.max(1, Math.min(8, availableParallelism()));
    return parallelMap(items, width, task);
  }

  // Archive members are named by basename, so a source in a subdirectory
  // (brotli's dec/ and enc/ share file names) is named after its path.
  const objectName = (source) => source.replaceAll("/", "-").replace(/\.c$/, ".o");
  async function archive(id, sources, sourceRoot, flags) {
    const root = join(stagedOutputRoot, "vendor", id);
    const objectRoot = join(root, "objects");
    await parallel(sources, async (source) => {
      await compile(
        join(sourceRoot, source),
        join(objectRoot, objectName(source)),
        unalignedVendorSources.has(source)
          ? flags.filter((flag) => !codeAlignment.includes(flag))
          : flags,
      );
    });
    const output = join(root, `libscriptc-${id}.a`);
    const objects = sources.map((source) => join(objectRoot, objectName(source)));
    await createDeterministicArchive(archiver, output, objects);
    await rm(objectRoot, { recursive: true, force: true });
    return {
      id,
      path: artifactPath(output),
      sha256: await sha256(output),
      size: (await stat(output)).size,
    };
  }

  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(stagedOutputRoot, { recursive: true });

  try {
    const flavors = {};
    // The executable `speed` flavor (--optimization=speed) exists only when
    // it differs from release: its static units are emitted through the host
    // LLVM helper with import bitcode.
    const flavorPlan = [
      ...Object.entries(RUNTIME_PACK_MATRIX.flavors),
      ...("release" in RUNTIME_PACK_MATRIX.flavors && unitHelper !== null
        ? [["speed", RUNTIME_PACK_MATRIX.flavors.release]]
        : []),
    ];
    for (const [flavor, flavorSpec] of flavorPlan) {
      const units = await parallel(
        flavorSpec.runtime_units ?? RUNTIME_PACK_MATRIX.runtime_units,
        async (unit) => {
          const variants = [];
          for (const baseVariant of unit.variants) {
            const variant = {
              ...baseVariant,
              defines: [...(flavorSpec.defines ?? []), ...baseVariant.defines],
            };
            const variantName = variant.id === "default" ? "default" : variant.id;
            const output = join(
              stagedOutputRoot,
              flavor,
              "runtime",
              variantName,
              unit.source.replace(/\.c$/, ".o"),
            );
            const includeFlags = [
              ...(unit.source === "scr_regex.c" ? ["-I", quickjs] : []),
              ...(unit.source === "scr_tls.c" ||
              unit.source === "scr_cipher.c" ||
              unit.source === "scr_ecdh.c" ||
              unit.source === "scr_dh.c" ||
              unit.source === "scr_pki.c" ||
              unit.source === "scr_webcrypto_aes.c"
                ? ["-I", join(mbedtls, "include")]
                : []),
              ...(unit.source === "scr_zlib.c" || unit.source === "scr_fetch.c"
                ? ["-I", zlib]
                : []),
              ...(unit.source === "scr_brotli.c" ? ["-I", join(brotli, "include")] : []),
            ];
            const unitFlags = [
              ...commonFlags,
              flavorSpec.optimization,
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
                    ...sourcePathFlags,
                    ...unitFlags,
                    "-emit-llvm",
                    "-c",
                    join(runtimeSrc, unit.source),
                    "-o",
                    optimized,
                  ]),
                object: output,
                bitcode: bitcodeOutput,
                triple: RUNTIME_PACK_MATRIX.target.llvm_triple,
                tag: unit.source.replace(/\.c$/, ""),
                sections:
                  RUNTIME_PACK_MATRIX.executable_section_elimination.compile_flags.includes(
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
              if (
                flavor === "release" &&
                unitHelper !== null &&
                (await buildImportBitcode({
                  helper: unitHelper,
                  compileBitcode: (optimized) =>
                    run(compiler, [
                      ...sourcePathFlags,
                      ...unitFlags,
                      "-emit-llvm",
                      "-c",
                      join(runtimeSrc, unit.source),
                      "-o",
                      optimized,
                    ]),
                  bitcode: bitcodeOutput,
                  tag: unit.source.replace(/\.c$/, ""),
                }))
              ) {
                bitcode = {
                  path: artifactPath(bitcodeOutput),
                  sha256: await sha256(bitcodeOutput),
                  size: (await stat(bitcodeOutput)).size,
                };
              }
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
    const brotliSources = (
      await Promise.all(
        ["common", "dec", "enc"].map(async (dir) =>
          (await readdir(join(brotli, dir)))
            .filter((name) => !name.startsWith(".") && name.endsWith(".c"))
            .map((name) => `${dir}/${name}`),
        ),
      )
    )
      .flat()
      .sort();
    const archives = [
      await archive("quickjs", QJS_SOURCES, quickjs, [
        "-target",
        RUNTIME_PACK_MATRIX.target.llvm_triple,
        "-std=gnu11",
        "-fvisibility=hidden",
        "-funsigned-char",
        "-DQUICKJS_NG_BUILD",
        "-D_GNU_SOURCE",
        "-DNDEBUG",
        "-Os",
        ...codeAlignment,
        "-I",
        quickjs,
      ]),
      await archive("libregexp", LRE_SOURCES, quickjs, [
        "-target",
        RUNTIME_PACK_MATRIX.target.llvm_triple,
        "-std=c11",
        "-Os",
        ...codeAlignment,
        "-I",
        quickjs,
      ]),
      await archive("zlib", ZLIB_SOURCES, zlib, [
        "-target",
        RUNTIME_PACK_MATRIX.target.llvm_triple,
        "-std=c11",
        "-Os",
        ...codeAlignment,
        "-I",
        zlib,
      ]),
      await archive("brotli", brotliSources, brotli, [
        "-target",
        RUNTIME_PACK_MATRIX.target.llvm_triple,
        "-std=c11",
        "-Os",
        ...codeAlignment,
        "-I",
        join(brotli, "include"),
      ]),
      await archive("mbedtls", mbedtlsSources, join(mbedtls, "library"), [
        "-target",
        RUNTIME_PACK_MATRIX.target.llvm_triple,
        "-std=c11",
        "-Os",
        ...codeAlignment,
        "-I",
        join(mbedtls, "include"),
        "-I",
        join(mbedtls, "library"),
      ]),
    ];
    const archiveSpecs = new Map(RUNTIME_PACK_MATRIX.archives.map((entry) => [entry.id, entry]));
    const licensed = [
      [join(runtimeRoot, "LICENSE"), "artifacts/licenses/scriptc-runtime.txt", "Apache-2.0"],
      [join(quickjs, "LICENSE"), "artifacts/licenses/quickjs-ng.txt", "MIT"],
      [join(vendorRoot, "ryu", "LICENSE-Boost"), "artifacts/licenses/ryu.txt", "BSL-1.0"],
      [
        join(vendorRoot, "v8-number-radix", "LICENSE"),
        "artifacts/licenses/v8-number-radix.txt",
        "BSD-3-Clause",
      ],
      [join(vendorRoot, "unicode", "LICENSE"), "artifacts/licenses/unicode.txt", "Unicode-3.0"],
      [join(zlib, "LICENSE"), "artifacts/licenses/zlib.txt", "Zlib"],
      [join(vendorRoot, "brotli", "LICENSE"), "artifacts/licenses/brotli.txt", "MIT"],
      [join(mbedtls, "LICENSE"), "artifacts/licenses/mbedtls.txt", "Apache-2.0"],
    ];
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
      target: RUNTIME_PACK_MATRIX.target,
      runtime_abi: { version: 38, marker: "scr_runtime_abi_v38" },
      compiler: {
        command: compiler,
        identity: compilerVersion,
        target: RUNTIME_PACK_MATRIX.target.llvm_triple,
        ...(unitHelper === null ? {} : { speed_codegen: unitHelper.identity }),
      },
      macros: {
        executable: [
          "SCR_TEXT_DECODER_LEGACY",
          "SCR_WARNING_REPLACE",
          "SCR_STDIO_EXTENDED",
          "SCR_YIN",
        ],
        excluded: ["SCR_RC_AUDIT", "SCR_ASAN_FIBERS"],
        sanitizer: "external-toolchain-required",
      },
      flavors,
      archives: archives.map((entry) => ({
        ...entry,
        predicate: archiveSpecs.get(entry.id).predicate,
      })),
      system_libraries: RUNTIME_PACK_MATRIX.system_libraries,
      licenses: licensed.map(([, path, license]) => ({ path, license })),
    };
    await writeFile(stagedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const backupSuffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    await installRuntimePack({
      outputRoot,
      manifestPath,
      stagedOutputRoot,
      stagedManifestPath,
      backupRoot: join(packageRoot, `.runtime-pack-artifacts-backup-${backupSuffix}`),
      backupManifestPath: join(packageRoot, `.runtime-pack-manifest-backup-${backupSuffix}`),
    });
    process.stdout.write(
      `built ${packageManifest.name}@${packageManifest.version}: ` +
        `${Object.keys(flavors).length} flavors, ${archives.length} vendor archives\n`,
    );
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
}

await withBuildLock(join(packageRoot, ".runtime-pack-build.lock"), build);
