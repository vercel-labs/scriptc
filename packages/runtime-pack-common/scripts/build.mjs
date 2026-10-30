#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { availableParallelism, tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { createRuntimePackMatrix } from "../runtime-pack-matrix.mjs";
import {
  RUNTIME_COMPILE_FLAGS,
  assertArtifactsExcludeStrings,
  runtimeForbiddenStrings,
} from "./artifact-policy.mjs";
import { createDeterministicArchive } from "./archive.mjs";
import { buildImportBitcode, buildRuntimeUnit, resolveRuntimeUnitHelper } from "./runtime-unit.mjs";
import { installRuntimePack, withBuildLock } from "./build-state.mjs";
import { shareIdenticalArtifacts } from "./share-artifacts.mjs";
import { parallelMap } from "./parallel-map.mjs";
import { zlibInputs } from "./zlib-inputs.mjs";
import { ICU_DATA_FILE, ensureIcuData, ensureIcuSources, icuSourceList } from "./icu-data.mjs";

const run = promisify(execFile);

/** Zig's library directory, which carries the libc++/libc++abi sources the ICU
 * archive merges: `ZIG_LIB_DIR` when the caller pins one, else the pinned
 * toolchain's own answer. */
async function zigLibDir() {
  if (process.env.ZIG_LIB_DIR) return process.env.ZIG_LIB_DIR;
  const { stdout } = await run("zig", ["env"]);
  const match = /\.lib_dir\s*=\s*"([^"]+)"/.exec(stdout);
  if (match === null) throw new Error("could not read zig's lib directory from `zig env`");
  return match[1];
}
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
// ICU (and so every ICU-answered Intl form) ships only in the packs that opt
// in with `icu: true` — linux-x64-gnu in this slice, the one pack whose build
// runs Zig's C++ driver for a glibc target. Every other pack omits the unit
// and the archive, and the compiler refuses Intl there (SC3002).
const matrix = createRuntimePackMatrix({
  ...config,
  omitOptionalSources: [
    ...(config.omitOptionalSources ?? []),
    ...(config.icu === true ? [] : ["scr_intl.c"]),
  ],
  omitArchives: [...(config.omitArchives ?? []), ...(config.icu === true ? [] : ["icu"])],
});

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
    ...RUNTIME_COMPILE_FLAGS,
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
  const brotli = join(vendorRoot, "brotli", "c");
  // ICU is fetched from its pinned release, not vendored (see icu-inputs.mjs),
  // and only a pack that ships it pays for the download.
  const icuSourceRoot = async () =>
    ensureIcuSources(join(repoRoot, "node_modules", ".cache", "scriptc-icu-sources"));
  const qjsSources = ["dtoa.c", "libregexp.c", "libunicode.c", "quickjs.c"];
  const lreSources = ["libregexp.c", "libunicode.c"];
  const zlibBuild = zlibInputs(config.target.llvm_triple);
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
  // so their object and import bitcode come from one promoted module. The
  // helper also reduces release units' bitcode to what programs can import.
  const unitHelper =
    config.bitcode === false
      ? null
      : await resolveRuntimeUnitHelper(repoRoot, matrix.target.llvm_triple);
  // Speed units that the LLVM helper optimizes with the target's committed
  // runtime profile (profiles/<target>.profdata.gz), or instruments for
  // scripts/refresh-runtime-profile.mjs (SCRIPTC_RUNTIME_PROFILE_GENERATE=1).
  // The runtime compiler then emits their bitcode unoptimized, and one LLVM,
  // the helper's, instruments, annotates and optimizes every profiled unit.
  // Release and library flavors keep the runtime compiler's optimization.
  const committedProfile = join(
    repoRoot,
    "packages",
    "runtime-pack-common",
    "profiles",
    `${config.target.name}.profdata.gz`,
  );
  // The committed profile is unpacked into the build directory once it exists.
  const unpackedProfile = join(buildRoot, "runtime.profdata");
  // Without a helper that optimizes units itself, speed units are built as
  // before, without the profile.
  const unitProfiles = unitHelper?.features.includes("runtime-unit-profile") === true;
  if (process.env.SCRIPTC_RUNTIME_PROFILE_GENERATE === "1" && !unitProfiles)
    throw new Error(
      "SCRIPTC_RUNTIME_PROFILE_GENERATE=1 needs an LLVM helper with runtime-unit profiles",
    );
  const speedProfile = !unitProfiles
    ? null
    : process.env.SCRIPTC_RUNTIME_PROFILE_GENERATE === "1"
      ? { args: ["--opt-level", "2", "--profile-generate", ""] }
      : existsSync(committedProfile)
        ? { args: ["--opt-level", "2", "--profile-use", unpackedProfile], unpack: true }
        : null;
  // Speed units the helper optimizes without the profile (at the same level).
  // scr_message.c: with the profile on its decoding, a program whose workers
  // each receive many small messages ran 5% slower in its workers' own code,
  // although that code and its data were unchanged; without it, the program
  // runs as fast as with an unprofiled runtime.
  const unprofiledUnits = new Set(["scr_message.c"]);
  // The instrumented units' functions, which SCRIPTC_RUNTIME_PROFILE_FUNCTIONS
  // names a file for; the refresh script keeps only their records.
  const profiledFunctions = new Set();
  const parallel = async (items, task) => {
    const width = Math.max(1, Math.min(8, availableParallelism()));
    return parallelMap(items, width, task);
  };
  // Archive members are named by basename, so a source in a subdirectory
  // (brotli's dec/ and enc/ share file names) is named after its path.
  const objectName = (source) => source.replaceAll("/", "-").replace(/\.c$/, ".o");
  const archive = async (id, sources, sourceRoot, flags) => {
    process.stdout.write(`building ${packageManifest.name} ${id} archive\n`);
    const root = join(stagedOutputRoot, "vendor", id);
    const objectRoot = join(root, "objects");
    await parallel(sources, async (source) =>
      compile(
        join(sourceRoot, source),
        join(objectRoot, objectName(source)),
        unalignedVendorSources.has(source)
          ? flags.filter((flag) => !codeAlignment.includes(flag))
          : flags,
      ),
    );
    const output = join(root, `libscriptc-${id}.a`);
    await createDeterministicArchive(
      archiver,
      output,
      sources.map((source) => join(objectRoot, objectName(source))),
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
  // ICU (Intl over ICU4C): the C++ units ICU's own source lists name, plus the
  // C++ standard library they need, merged INTO the archive so the final link
  // stays a plain C link with the pack's own `-lm`. Four things distinguish it
  // from every other vendored archive:
  //  - It is C++, so this pack's C driver cannot compile it: the TUs (and the
  //    standard library they use) build with Zig's C++ driver for the PACK'S
  //    OWN target. That target is the point. In C++ mode, glibc 2.38+ headers
  //    redirect strtol/strtoul to the C23 __isoc23_* names, and a host
  //    libstdc++ binds those names too, so a host-compiled C++ archive would
  //    raise the glibc floor above the pack's. Zig's bundled libc++ and
  //    libc++abi compile from the toolchain's own sources for the target and
  //    bind the target's names only; the pack's forbidden-artifact check
  //    proves it.
  //  - ICU requires RTTI (typeid and dynamic_cast in its source), so -fno-rtti
  //    is not available; -fno-exceptions is, and ICU, libc++, and libc++abi
  //    all build so. That also means libc++abi's Itanium personality routine
  //    (cxa_personality.cpp) is out: it is the one unit that needs exceptions,
  //    and nothing can throw into it.
  //  - Symbol renaming stays ON (the `_78` suffixes), which is what lets the
  //    zero-cost gate prove that non-Intl binaries link no ICU symbol.
  //  - Only a pack that opts in with `icu: true` ships the unit and this
  //    archive; the compiler refuses Intl in every other pack (SC3002).
  // packages/compiler/src/backend/vendor-archives.ts (ensureIcuArchive)
  // builds the same archive on the source-build path.
  const icuArchive = async () => {
    process.stdout.write(`building ${packageManifest.name} icu archive\n`);
    // The tarball extracts to `icu/source/...` with ICU's LICENSE beside it.
    const icu = join(await icuSourceRoot(), "source");
    const root = join(stagedOutputRoot, "vendor", "icu");
    const objectRoot = join(root, "objects");
    const libDir = await zigLibDir();
    const cxx = ["zig", "c++", ...config.targetArgs];
    const optimize = ["-Os"];
    const commonFlags = [
      "-std=c++17",
      ...optimize,
      "-fno-exceptions",
      "-ffunction-sections",
      "-fdata-sections",
    ];
    const icuFlags = [
      ...commonFlags,
      "-DU_STATIC_IMPLEMENTATION",
      "-DU_ATTRIBUTE_DEPRECATED=",
      "-DNDEBUG",
      "-Wno-deprecated-declarations",
      "-I",
      join(icu, "common"),
      "-I",
      join(icu, "i18n"),
    ];
    // libc++ 20 sources need C++20 (`constinit`, ranges) and libc++'s
    // charconv reads a header from `libcxx/libc`.
    const cxxLibraryFlags = [
      "-std=c++23",
      ...optimize,
      "-fno-exceptions",
      "-ffunction-sections",
      "-fdata-sections",
      "-I",
      join(libDir, "libcxx", "include"),
      "-I",
      join(libDir, "libcxx", "src"),
      "-I",
      join(libDir, "libcxx", "libc"),
      "-I",
      join(libDir, "libcxxabi", "include"),
      "-D_LIBCPP_BUILDING_LIBRARY",
      "-D_LIBCXXABI_BUILDING_LIBRARY",
      "-DLIBCXX_BUILDING_LIBCXXABI",
      "-Wno-unknown-warning-option",
    ];
    const cxxLibraryUnits = async (subdirectory, memberPrefix, skip) => {
      const sources = (await readdir(join(libDir, subdirectory, "src")))
        .filter((name) => name.endsWith(".cpp") && !skip.has(name))
        .sort();
      return sources.map((source) => ({
        path: join(libDir, subdirectory, "src", source),
        member: `${memberPrefix}${source}`,
        flags: cxxLibraryFlags,
      }));
    };
    const units = [
      ...icuSourceList(await readFile(join(icu, "common", "sources.txt"), "utf8")).map(
        (source) => ({
          path: join(icu, "common", source),
          member: `common-${source}`,
          flags: icuFlags,
          define: "U_COMMON_IMPLEMENTATION",
        }),
      ),
      {
        path: join(icu, "stubdata", "stubdata.cpp"),
        member: "stubdata-stubdata.cpp",
        flags: icuFlags,
        define: "U_COMMON_IMPLEMENTATION",
      },
      ...icuSourceList(await readFile(join(icu, "i18n", "sources.txt"), "utf8")).map((source) => ({
        path: join(icu, "i18n", source),
        member: `i18n-${source}`,
        flags: icuFlags,
        define: "U_I18N_IMPLEMENTATION",
      })),
      ...(await cxxLibraryUnits("libcxx", "cxx-libcxx-", new Set())),
      ...(await cxxLibraryUnits("libcxxabi", "cxx-libcxxabi-", new Set(["cxa_personality.cpp"]))),
    ];
    // Member order is fixed by the source lists (parallel() preserves it),
    // so the archive's bytes depend only on the inputs.
    const objects = await parallel(units, async (unit) => {
      const output = join(objectRoot, unit.member.replace(/\.cpp$/, ".o"));
      await mkdir(dirname(output), { recursive: true });
      await run(cxx[0], [
        ...cxx.slice(1),
        ...sourcePathFlags,
        ...unit.flags,
        ...(unit.define === undefined ? [] : [`-D${unit.define}`]),
        "-g0",
        "-c",
        unit.path,
        "-o",
        output,
      ]);
      return output;
    });
    const output = join(root, "libscriptc-icu.a");
    await createDeterministicArchive(archiver, output, objects, archiverArgs);
    await rm(objectRoot, { recursive: true, force: true });
    return {
      id: "icu",
      path: artifactPath(output),
      sha256: await sha256(output),
      size: (await stat(output)).size,
    };
  };

  await rm(buildRoot, { recursive: true, force: true });
  try {
    await mkdir(stagedOutputRoot, { recursive: true });
    if (speedProfile?.unpack)
      await writeFile(unpackedProfile, gunzipSync(await readFile(committedProfile)));
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
    // LLVM helper with import bitcode.
    const flavorPlan = [
      ...Object.entries(matrix.flavors),
      ...("release" in matrix.flavors && unitHelper !== null
        ? [["speed", matrix.flavors.release]]
        : []),
    ];
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
      const profileMatches = [];
      const units = await parallel(
        flavorSpec.runtime_units ?? matrix.runtime_units,
        async (unit) => {
          const variants = [];
          for (const baseVariant of unit.variants) {
            const variant = {
              ...baseVariant,
              defines: [...(flavorSpec.defines ?? []), ...baseVariant.defines],
            };
            const output = join(
              stagedOutputRoot,
              flavor,
              "runtime",
              variant.id,
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
              // scr_intl.c includes ICU's C API headers straight from the
              // fetched release: the core ones in source/common/unicode/*.h,
              // and the format ones (udat.h, unumberformatter.h) in
              // source/i18n/unicode/*.h.
              ...(unit.source === "scr_intl.c"
                ? [
                    "-I",
                    join(await icuSourceRoot(), "source", "common"),
                    "-I",
                    join(await icuSourceRoot(), "source", "i18n"),
                  ]
                : []),
            ];
            // Worker variants link only into executables, whose own TLS block
            // holds every runtime thread-local: on ELF the initial-exec model
            // makes each access one %fs-relative load, where the default
            // general-dynamic model compiles to a __tls_get_addr call (the
            // linker relaxes the call away, but the callers already spilled
            // their registers around it).
            const tlsFlags =
              variant.defines.includes("SCR_WORKERS") && matrix.target.object_format === "elf"
                ? ["-ftls-model=initial-exec"]
                : [];
            const unitFlags = [
              ...commonFlags,
              flavorSpec.optimization,
              ...debugFlags,
              ...variant.defines.map((define) => `-D${define}`),
              ...tlsFlags,
              ...includeFlags,
            ];
            let bitcode;
            const bitcodeOutput = output.replace(/\.o$/, ".bc");
            if (flavor === "speed") await mkdir(dirname(output), { recursive: true });
            let unitBuild = false;
            if (
              flavor === "speed" &&
              (unitBuild = await buildRuntimeUnit({
                helper: unitHelper,
                compileBitcode: (optimized) =>
                  run(compiler, [
                    ...compilerArgs,
                    ...sourcePathFlags,
                    ...unitFlags,
                    "-g0",
                    ...(speedProfile === null ? [] : ["-Xclang", "-disable-llvm-passes"]),
                    "-emit-llvm",
                    "-c",
                    join(runtimeSrc, unit.source),
                    "-o",
                    optimized,
                  ]),
                helperArgs:
                  speedProfile?.unpack && unprofiledUnits.has(unit.source)
                    ? ["--opt-level", "2"]
                    : (speedProfile?.args ?? []),
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
              if (unitBuild.profile !== undefined) profileMatches.push(unitBuild.profile);
              for (const name of unitBuild.functions ?? []) profiledFunctions.add(name);
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
      flavors[flavor] = {
        optimization: flavorSpec.optimization,
        runtime_units: units,
        // How the committed runtime profile matched the units it guided
        // (scripts/refresh-runtime-profile.mjs refreshes it).
        ...(profileMatches.length === 0
          ? {}
          : {
              runtime_profile: {
                annotated: profileMatches.reduce((sum, match) => sum + match.annotated, 0),
                mismatched: profileMatches.reduce((sum, match) => sum + match.mismatched, 0),
                missing: profileMatches.reduce((sum, match) => sum + match.missing, 0),
                ...profileWeights(profileMatches),
              },
            }),
      };
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
    // Vendored QuickJS reads `clock_gettime` for its monotonic clock. WASI
    // exposes that declaration only when its process-clock emulation ABI is
    // selected, so vendor sources inherit the target's runtime defines too.
    const vendorTarget = [
      ...config.targetArgs,
      ...(config.compilerFlags ?? []),
      ...RUNTIME_COMPILE_FLAGS,
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
                    // Section elimination keeps only the libunicode tables a
                    // program reaches: the URL host parser's NFC links the
                    // normalization tables without the regex property ones.
                    ...matrix.executable_section_elimination.compile_flags,
                    "-std=c11",
                    "-Os",
                    "-I",
                    quickjs,
                  ]),
                ]
              : []),
            ...(requestedArchives.has("zlib")
              ? [
                  await archive("zlib", zlibBuild.sources, zlib, [
                    ...vendorTarget,
                    "-std=c11",
                    "-O3",
                    ...zlibBuild.defines.map((define) => `-D${define}`),
                    "-I",
                    zlib,
                  ]),
                ]
              : []),
            ...(requestedArchives.has("brotli")
              ? [
                  await archive("brotli", brotliSources, brotli, [
                    ...vendorTarget,
                    "-std=c11",
                    "-Os",
                    "-I",
                    join(brotli, "include"),
                  ]),
                ]
              : []),
            ...(requestedArchives.has("icu") ? [await icuArchive()] : []),
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
    // ICU's data is a RUN-time input, not a link input: the executable loads
    // icudt78l.dat from beside itself (or ICU_DATA). `data` tells the
    // compiler where the pack keeps it, so every Intl build installs it
    // beside the binary it links.
    const data = [];
    if (requestedArchives.has("icu")) {
      process.stdout.write(`building ${packageManifest.name} icu data\n`);
      const source = await ensureIcuData(
        join(repoRoot, "node_modules", ".cache", "scriptc-icu-data"),
      );
      const destination = join(stagedOutputRoot, "icu", ICU_DATA_FILE);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      data.push({
        path: artifactPath(destination),
        sha256: await sha256(destination),
        size: (await stat(destination)).size,
      });
    }
    // A sanitized build (`--sanitize` in the native compiler) compiles the
    // runtime units from @scriptc/runtime's sources, and scr_intl.c includes
    // ICU's C API headers, which that package does not carry. The pack ships
    // the ICU headers scr_intl.c includes, as the compiler's dependency scan
    // lists them, under one include root beside the archive.
    const headers = [];
    if (requestedArchives.has("icu")) {
      const icu = join(await icuSourceRoot(), "source");
      const icuHeaderDirs = [join(icu, "common", "unicode"), join(icu, "i18n", "unicode")];
      const scan = await run(compiler, [
        ...compilerArgs,
        ...commonFlags,
        "-I",
        join(icu, "common"),
        "-I",
        join(icu, "i18n"),
        "-MM",
        join(runtimeSrc, "scr_intl.c"),
      ]);
      const included = scan.stdout
        .replaceAll("\\\n", " ")
        .split(/\s+/)
        .filter((path) => icuHeaderDirs.includes(dirname(path)))
        .sort((a, b) => basename(a).localeCompare(basename(b)));
      if (included.length === 0) throw new Error("scr_intl.c includes no ICU header");
      const includeRoot = join(stagedOutputRoot, "vendor", "icu", "include", "unicode");
      await mkdir(includeRoot, { recursive: true });
      for (const source of included) {
        const destination = join(includeRoot, basename(source));
        if (existsSync(destination))
          throw new Error(`two ICU headers are named ${basename(source)}`);
        await copyFile(source, destination);
        headers.push({
          path: artifactPath(destination),
          sha256: await sha256(destination),
          size: (await stat(destination)).size,
        });
      }
    }
    await assertArtifactsExcludeStrings(
      stagedOutputRoot,
      runtimeForbiddenStrings(config.forbiddenArtifactStrings),
    );
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
      [
        join(vendorRoot, "v8-ieee754", "LICENSE"),
        "artifacts/licenses/v8-ieee754.txt",
        "BSD-3-Clause",
      ],
      [join(zlib, "LICENSE"), "artifacts/licenses/zlib.txt", "Zlib"],
      [join(zlib, "LICENSE.chromium"), "artifacts/licenses/zlib-chromium.txt", "BSD-3-Clause"],
      [join(vendorRoot, "brotli", "LICENSE"), "artifacts/licenses/brotli.txt", "MIT"],
      [join(mbedtls, "LICENSE"), "artifacts/licenses/mbedtls.txt", "Apache-2.0"],
      // ICU's terms cover both the sources and the data file it ships; only a
      // pack that ships them carries its license.
      ...(requestedArchives.has("icu")
        ? [[join(await icuSourceRoot(), "LICENSE"), "artifacts/licenses/icu.txt", "Unicode-3.0"]]
        : []),
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
    await shareIdenticalArtifacts(flavors, buildRoot);
    const manifest = {
      schema: "scriptc.runtime-pack.v1",
      format: 1,
      package: packageManifest.name,
      version: packageManifest.version,
      target: matrix.target,
      runtime_abi: { version: 48, marker: "scr_runtime_abi_v48" },
      compiler: {
        command: compiler,
        identity: compilerVersion,
        target: matrix.target.llvm_triple,
        ...(unitHelper === null ? {} : { speed_codegen: unitHelper.identity }),
      },
      macros: {
        executable: [
          "SCR_TEXT_DECODER_LEGACY",
          "SCR_WARNING_REPLACE",
          "SCR_STDIO_EXTENDED",
          "SCR_STREAM_WRITE_ERRORS",
          "SCR_STDIO_WRITE_SLOT",
          "SCR_NATIVE_REACTIONS",
          "SCR_HANDLE_CLASSES",
          "SCR_YIN",
          "SCR_NODE_ISLANDS",
        ],
        excluded: ["SCR_RC_AUDIT", "SCR_ASAN_FIBERS"],
        sanitizer: "external-toolchain-required",
      },
      flavors,
      archives: archives.map((entry) => ({
        ...entry,
        predicate: archiveSpecs.get(entry.id).predicate,
      })),
      ...(data.length === 0 ? {} : { data }),
      ...(headers.length === 0 ? {} : { headers }),
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
    if (process.env.SCRIPTC_RUNTIME_PROFILE_FUNCTIONS !== undefined)
      await writeFile(
        process.env.SCRIPTC_RUNTIME_PROFILE_FUNCTIONS,
        [...profiledFunctions]
          .sort()
          .map((name) => `${name}\n`)
          .join(""),
      );
    process.stdout.write(
      `built ${packageManifest.name}@${packageManifest.version}: ${Object.keys(flavors).length} flavors, ${archives.length} vendor archives\n`,
    );
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
}
await withBuildLock(join(packageRoot, ".runtime-pack-build.lock"), build);

/** The profile's counters on the functions the speed units' annotation
 * matched (annotated_counts) and on the functions whose control flow changed
 * since the profile was collected (mismatched_counts), from helpers that
 * report them per function. A function the profile describes for one unit
 * variant (default or workers) only reads as mismatched in the other one, so
 * a name annotated in any unit counts as annotated. `stale` names the
 * mismatched functions with the most counts. */
function profileWeights(matches) {
  if (!matches.every((match) => match.annotated_counts !== undefined)) return {};
  const annotated = new Map();
  const mismatched = new Map();
  for (const match of matches) {
    for (const [name, counts] of Object.entries(match.annotated_counts))
      annotated.set(name, counts);
    for (const [name, counts] of Object.entries(match.mismatched_counts))
      mismatched.set(name, counts);
  }
  for (const name of annotated.keys()) mismatched.delete(name);
  const sum = (map) => [...map.values()].reduce((total, counts) => total + counts, 0);
  return {
    annotated_counts: sum(annotated),
    mismatched_counts: sum(mismatched),
    stale: [...mismatched]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name]) => name),
  };
}
