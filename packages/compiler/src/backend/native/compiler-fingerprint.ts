import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type CcDriver } from "./driver.js";
import { resolvedToolIdentity, resolvedTool } from "./tool-identity.js";
import { execFileAsync } from "./process.js";
import {
  parseMakeDependencies,
  fingerprintDependencyFiles,
  rememberFingerprintDependencies,
} from "./dependency-files.js";
import { existingDriverTracePaths, normalizedProbeInvocation } from "./trace-paths.js";
import { stableTestMemo } from "./session.js";
import {
  LRE_SOURCES,
  ZLIB_SOURCES,
  vendorEngineDir,
  vendorTlsDir,
  vendorZlibDir,
} from "./vendor.js";
import { nativeSourceFiles, runtimeSrcDir } from "./runtime-inputs.js";

interface ImplicitToolchainProbe {
  compilerIdentity: string;
  compilerInvocation: string;
  dependencies: string[];
  dependencyFingerprint: string;
  invocationPaths: string[];
  tools: { spelling: string; identity: string | null; path: string | null }[];
  compileToolSpellings: string[];
}

interface ImplicitToolchainFingerprints {
  /** Compiler inputs plus assembler identity: safe for compile-only objects. */
  compile: string;
  /** The compile identity plus the driver's selected linker identity. */
  complete: string;
}

interface EffectiveCompilerInvocationProbe {
  compilerIdentity: string;
  invocation: string;
  dependencies: string[];
  dependencyFingerprint: string;
  invocationPaths: string[];
}

/** The effective cc1 invocation and injected dependencies for the flags used
 * by real runtime/program compiles. The broad implicit-toolchain probe below
 * intentionally uses a target-wide synthetic TU so it can discover every
 * owned system header, but that generic command is not sufficient identity for
 * a wrapper that injects flags or preincluded files only for a particular build
 * flavor (for example, only when it sees -O2). */
async function effectiveCompilerInvocationFingerprintFresh(
  driver: Pick<CcDriver, "argv">,
  environmentFingerprint: string,
  compileArgs: readonly string[],
  sourceExtension: ".c" | ".ll" = ".c",
): Promise<string> {
  const compiler = driver.argv[0] ?? "clang";
  const compilerIdentity = await resolvedToolIdentity(compiler);
  if (compilerIdentity === null) {
    throw new Error("compiler unavailable before effective invocation identity was established");
  }
  let probe: EffectiveCompilerInvocationProbe;
  {
    const probeDir = await mkdtemp(join(tmpdir(), "scriptc-effective-cc-probe-"));
    try {
      const source = join(probeDir, `program${sourceExtension}`);
      const output = join(probeDir, "program.o");
      await writeFile(
        source,
        sourceExtension === ".ll"
          ? "define i32 @scriptc_effective_probe() { ret i32 0 }\n"
          : "int scriptc_effective_probe(void) { return 0; }\n",
      );
      const prefix = [...driver.argv.slice(1), ...compileArgs];
      const [invocation, dependencyResult] = await Promise.all([
        execFileAsync(compiler, [...prefix, "-###", "-c", source, "-o", output], {
          cwd: probeDir,
          maxBuffer: 16 * 1024 * 1024,
        }),
        sourceExtension === ".c"
          ? execFileAsync(compiler, [...prefix, "-M", source], {
              cwd: probeDir,
              maxBuffer: 16 * 1024 * 1024,
            })
          : Promise.resolve(null),
      ]);
      const dependencies =
        dependencyResult === null
          ? []
          : parseMakeDependencies(dependencyResult.stdout, probeDir).filter(
              (path) => path !== resolve(source),
            );
      probe = {
        compilerIdentity,
        invocation: normalizedProbeInvocation(invocation, probeDir),
        dependencies,
        dependencyFingerprint: await fingerprintDependencyFiles(dependencies),
        invocationPaths: await existingDriverTracePaths(
          `${invocation.stdout}\n${invocation.stderr}`,
          probeDir,
          probeDir,
        ),
      };
    } finally {
      await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const fingerprint = createHash("sha256")
    .update("effective-compiler-invocation-v2\0")
    .update(environmentFingerprint)
    .update("\0")
    .update(probe.compilerIdentity)
    .update("\0")
    .update(driver.argv.join("\x1f"))
    .update("\0")
    .update(compileArgs.join("\x1f"))
    .update("\0")
    .update(sourceExtension)
    .update("\0")
    .update(probe.invocation)
    .update("\0")
    .update(probe.dependencies.join("\x1f"))
    .update("\0")
    .update(probe.dependencyFingerprint)
    .digest("hex");
  return rememberFingerprintDependencies(
    fingerprint,
    [...probe.dependencies, ...probe.invocationPaths],
    probe.dependencies,
    probe.dependencyFingerprint,
  );
}

const stableEffectiveCompilerInvocationMemos = new Map<string, Promise<string>>();
export function effectiveCompilerInvocationFingerprint(
  driver: Pick<CcDriver, "argv">,
  environmentFingerprint: string,
  compileArgs: readonly string[],
  sourceExtension: ".c" | ".ll" = ".c",
): Promise<string> {
  const key = [
    environmentFingerprint,
    driver.argv.join("\x1f"),
    compileArgs.join("\x1f"),
    sourceExtension,
  ].join("\0");
  return stableTestMemo(stableEffectiveCompilerInvocationMemos, key, () =>
    effectiveCompilerInvocationFingerprintFresh(
      driver,
      environmentFingerprint,
      compileArgs,
      sourceExtension,
    ),
  );
}

/** Every system-header spelling consumed by a source tree scriptc owns. The
 * dependency probe preprocesses these spellings with the selected driver and
 * hashes the resolved files. Runtime-local and vendored source/header bytes
 * have their own content/version identities; scanning every owned file for
 * angle includes closes the system-header gap in separately built QuickJS,
 * libregexp, mbedTLS, zlib, and Ryū translation units. */
export async function implicitDependencyProbeIncludes(rtDir: string): Promise<string[]> {
  const vendor = join(rtDir, "..", "vendor");
  const quickjsSources = new Set<string>(LRE_SOURCES);
  const zlibSources = new Set<string>(ZLIB_SOURCES.map((source) => basename(source)));
  const fileGroups = await Promise.all([
    nativeSourceFiles(rtDir, false),
    nativeSourceFiles(join(vendor, "ryu"), false),
    nativeSourceFiles(
      join(vendor, "quickjs-ng"),
      false,
      (name) => name.endsWith(".h") || quickjsSources.has(name),
    ),
    nativeSourceFiles(join(vendor, "mbedtls", "include"), true),
    nativeSourceFiles(join(vendor, "mbedtls", "library"), true),
    nativeSourceFiles(
      join(vendor, "zlib"),
      true,
      (name) => name.endsWith(".h") || zlibSources.has(name),
    ),
  ]);
  const includes = new Set<string>();
  for (const path of fileGroups.flat()) {
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/^\s*#\s*include\s*<([^>]+)>/gm)) {
      includes.add(`<${match[1]!}>`);
    }
  }
  return [...includes].sort();
}

/** Compiler-provided x86 headers: clang ships them for every target, so
 * __has_include finds them on arm64 too, where including them is an
 * #error. Covers the SSE/AVX intrinsic families (<emmintrin.h>,
 * <immintrin.h>, ...), <x86intrin.h>, <x86gprintrin.h> and <cpuid.h>. */
/** clang's x86 intrinsic headers: every <...intrin.h> but the Windows
 * <intrin.h> (<xsaveintrin.h>, <immintrin.h>, ...), and <cpuid.h>. */
function x86OnlyHeader(include: string): boolean {
  return include === "<cpuid.h>" || /^<[a-z0-9_]+intrin\.h>$/.test(include);
}

/** One guarded line of the implicit-toolchain probe source: the header is
 * included only when the compiler can find it and it belongs to the target
 * being probed. clang ships <riscv_vector.h> for every target, and through
 * clang 18 including it without the RISC-V vector extension is an #error. */
export function implicitDependencyIncludeDirective(include: string): string {
  const targetCondition = x86OnlyHeader(include)
    ? " && (defined(__i386__) || defined(__x86_64__) || defined(_M_IX86) || defined(_M_X64))"
    : include === "<intrin.h>"
      ? " && defined(_WIN32)"
      : include === "<arm64_neon.h>" || include === "<arm_acle.h>" || include === "<arm_neon.h>"
        ? " && (defined(__arm__) || defined(__aarch64__) || defined(_M_ARM) || defined(_M_ARM64))"
        : include === "<riscv_vector.h>"
          ? " && defined(__riscv_vector)"
          : "";
  return `#if __has_include(${include})${targetCondition}\n#include ${include}\n#endif\n`;
}

interface TranslationUnitDependencyProbe {
  compilerIdentity: string;
  dependencies: string[];
  dependencyFingerprint: string;
}

/** Exact headers selected while preprocessing the caller's translation unit.
 * The shared toolchain probe covers the runtime/vendor trees, but compileC is
 * also a public API: an opted-in caller can include a system or header-only SDK
 * surface that no runtime source names. Probe an invocation-private snapshot
 * of the keyed bytes with the real compile flags, preserving the original
 * quote-include directory and compiler-visible source spelling. */
async function translationUnitDependencyFingerprintFresh(
  driver: Pick<CcDriver, "argv">,
  cflags: readonly string[],
  sourcePath: string,
  sourceBytes: Buffer,
  environmentFingerprint: string,
): Promise<string> {
  if (sourcePath.endsWith(".ll")) {
    return rememberFingerprintDependencies(
      createHash("sha256").update("translation-unit-dependencies-v1\0llvm-ir").digest("hex"),
      [],
    );
  }

  const compiler = driver.argv[0] ?? "clang";
  const compilerIdentity = await resolvedToolIdentity(compiler);
  if (compilerIdentity === null) {
    throw new Error("compiler unavailable before translation-unit dependencies were established");
  }
  let probe: TranslationUnitDependencyProbe;
  {
    const probeDir = await mkdtemp(join(tmpdir(), "scriptc-tu-probe-"));
    try {
      const snapshot = join(probeDir, "program.c");
      await writeFile(snapshot, sourceBytes);
      const result = await execFileAsync(
        compiler,
        [
          ...driver.argv.slice(1),
          // The real source directory is searched before every caller-supplied
          // -iquote/-I directory. Put its surrogate first to preserve that
          // precedence after moving the keyed bytes into the probe directory.
          "-iquote",
          dirname(resolve(sourcePath)),
          ...cflags,
          `-ffile-prefix-map=${snapshot}=${sourcePath}`,
          "-M",
          snapshot,
        ],
        { cwd: probeDir, maxBuffer: 16 * 1024 * 1024 },
      );
      const ownPaths = new Set([resolve(snapshot), resolve(sourcePath)]);
      const dependencies = parseMakeDependencies(result.stdout, probeDir).filter(
        (path) => !ownPaths.has(path),
      );
      probe = {
        compilerIdentity,
        dependencies,
        dependencyFingerprint: await fingerprintDependencyFiles(dependencies),
      };
    } finally {
      await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const fingerprint = createHash("sha256")
    .update("translation-unit-dependencies-v1\0")
    .update(environmentFingerprint)
    .update("\0")
    .update(probe.compilerIdentity)
    .update("\0")
    .update(probe.dependencies.join("\x1f"))
    .update("\0")
    .update(probe.dependencyFingerprint)
    .digest("hex");
  return rememberFingerprintDependencies(
    fingerprint,
    probe.dependencies,
    probe.dependencies,
    probe.dependencyFingerprint,
  );
}

const stableTranslationUnitDependencyMemos = new Map<string, Promise<string>>();
export function translationUnitDependencyFingerprint(
  driver: Pick<CcDriver, "argv">,
  cflags: readonly string[],
  sourcePath: string,
  sourceBytes: Buffer,
  environmentFingerprint: string,
): Promise<string> {
  const key = createHash("sha256")
    .update(environmentFingerprint)
    .update("\0")
    .update(driver.argv.join("\x1f"))
    .update("\0")
    .update(cflags.join("\x1f"))
    .update("\0")
    .update(sourcePath)
    .update("\0")
    .update(resolve(sourcePath))
    .update("\0")
    .update(sourceBytes)
    .digest("hex");
  return stableTestMemo(stableTranslationUnitDependencyMemos, key, () =>
    translationUnitDependencyFingerprintFresh(
      driver,
      cflags,
      sourcePath,
      sourceBytes,
      environmentFingerprint,
    ),
  );
}

/** Identity of implicit compiler inputs that do not appear in buildArgs:
 * default SDK/system headers and the assembler/linker selected by the driver.
 * Small preprocessor dependency probes include every header spelling used by
 * the runtime when it is available for the selected target (and therefore the
 * vendored headers those TUs consume), then hash the exact dependency bytes.
 * Vendored source snapshots remain keyed by their version pins. When the
 * compiler is available, dependency discovery runs afresh so an SDK/config
 * change that redirects includes cannot hide behind an unchanged old path
 * list. Dependency discovery must succeed on every cache-enabled invocation;
 * a prior path list cannot reveal a new higher-priority header. */
async function implicitToolchainFingerprintsFresh(
  driver: Pick<CcDriver, "argv" | "targetArgs" | "target">,
  environmentFingerprint: string,
): Promise<ImplicitToolchainFingerprints> {
  let probe: ImplicitToolchainProbe;
  const compiler = driver.argv[0] ?? "clang";
  const compilerIdentity = await resolvedToolIdentity(compiler);
  if (compilerIdentity === null) {
    throw new Error("compiler unavailable before implicit toolchain identity was established");
  }
  {
    const probeDir = await mkdtemp(join(tmpdir(), "scriptc-toolchain-probe-"));
    try {
      const dependencyIncludes = await implicitDependencyProbeIncludes(runtimeSrcDir());
      // Clang's GNU cpuid.h and Windows intrin.h both define `__cpuid` with
      // incompatible signatures. Real TUs select only one context; preserve
      // that isolation while still discovering both targets' dependency sets.
      const sourceGroups = [
        dependencyIncludes.filter((include) => include !== "<intrin.h>"),
        dependencyIncludes.filter((include) => include === "<intrin.h>"),
      ].filter((group) => group.length > 0);
      const sources = sourceGroups.map((_, index) => join(probeDir, `empty-${index}.c`));
      const driverSource = join(probeDir, "driver-empty.c");
      const driverOutput = join(probeDir, "driver-output.o");
      await Promise.all([
        ...sources.map((source, index) =>
          writeFile(source, sourceGroups[index]!.map(implicitDependencyIncludeDirective).join("")),
        ),
        writeFile(driverSource, "int scriptc_driver_probe;\n"),
      ]);
      const prefix = [...driver.argv.slice(1), ...driver.targetArgs];
      const probeArgs = [
        ...prefix,
        "-std=c11",
        "-D_GNU_SOURCE",
        "-D_XOPEN_SOURCE=700",
        "-I",
        runtimeSrcDir(),
        "-I",
        vendorEngineDir(),
        "-I",
        join(vendorTlsDir(), "include"),
        "-I",
        join(vendorTlsDir(), "library"),
        "-I",
        vendorZlibDir(),
        "-M",
      ];
      const [dependencyResults, linker, assembler, compilerInvocation] = await Promise.all([
        Promise.all(
          sources.map((source, index) =>
            probeIncludeDependencies(compiler, probeArgs, probeDir, source, sourceGroups[index]!),
          ),
        ),
        execFileAsync(compiler, [...prefix, "-print-prog-name=ld"], { cwd: probeDir }),
        execFileAsync(compiler, [...prefix, "-print-prog-name=as"], { cwd: probeDir }),
        // `-###` exposes the effective cc1 invocation after compiler-driver
        // config and ordinary wrappers have injected their implicit flags. A
        // wrapper can read environment variables unknown to scriptc; hashing
        // this trace keeps those flags from hiding behind an unchanged wrapper
        // executable/version and dependency set.
        execFileAsync(
          compiler,
          [...prefix, "-std=c11", "-###", "-c", driverSource, "-o", driverOutput],
          { cwd: probeDir, maxBuffer: 16 * 1024 * 1024 },
        ),
      ]);
      const assemblerSpelling = assembler.stdout.trim();
      const toolSpellings = [linker.stdout.trim(), assemblerSpelling].filter(
        (value, index, all) => value !== "" && all.indexOf(value) === index,
      );
      const dependencyPaths = [...new Set(dependencyResults.flat())].sort();
      probe = {
        compilerIdentity: compilerIdentity ?? `<unresolved>\0${compiler}`,
        compilerInvocation: normalizedProbeInvocation(compilerInvocation, probeDir),
        dependencies: dependencyPaths,
        dependencyFingerprint: await fingerprintDependencyFiles(dependencyPaths),
        invocationPaths: await existingDriverTracePaths(
          `${compilerInvocation.stdout}\n${compilerInvocation.stderr}`,
          probeDir,
          probeDir,
        ),
        tools: await Promise.all(
          toolSpellings.map(async (spelling) => {
            const resolved = await resolvedTool(spelling);
            return {
              spelling,
              identity: resolved?.cacheIdentity ?? null,
              path: resolved?.canonicalPath ?? null,
            };
          }),
        ),
        compileToolSpellings: assemblerSpelling === "" ? [] : [assemblerSpelling],
      };
    } finally {
      await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const tools = await Promise.all(
    probe.tools.map(async (tool) => ({
      ...tool,
      currentIdentity: await resolvedToolIdentity(tool.spelling),
    })),
  );
  const fingerprint = (
    domain: string,
    selectedTools: readonly (typeof tools)[number][],
  ): string => {
    const hash = createHash("sha256")
      .update(domain)
      .update(environmentFingerprint)
      .update("\0")
      .update(probe.compilerIdentity)
      .update("\0")
      .update(probe.compilerInvocation)
      .update("\0")
      .update(driver.argv.join("\x1f"))
      .update("\0")
      .update(driver.targetArgs.join("\x1f"))
      .update("\0")
      .update(probe.dependencies.join("\x1f"))
      .update("\0")
      .update(probe.dependencyFingerprint)
      .update("\0");
    for (const tool of selectedTools) {
      hash
        .update(tool.spelling)
        .update("\0")
        .update(tool.currentIdentity ?? tool.identity ?? "<unresolved>")
        .update("\0");
    }
    return rememberFingerprintDependencies(
      hash.digest("hex"),
      [
        ...probe.dependencies,
        ...probe.invocationPaths,
        ...selectedTools.flatMap((tool) => (tool.path === null ? [] : [tool.path])),
      ],
      probe.dependencies,
      probe.dependencyFingerprint,
    );
  };
  const compileSpellingSet = new Set(probe.compileToolSpellings);
  return {
    // Preserve the established complete fingerprint domain and byte stream.
    complete: fingerprint("implicit-toolchain-v2\0", tools),
    compile: fingerprint(
      "implicit-compile-toolchain-v1\0",
      tools.filter((tool) => compileSpellingSet.has(tool.spelling)),
    ),
  };
}

/** Headers the dependency probe preprocesses at a time when it probes them
 * one by one. */
const SINGLE_HEADER_PROBES = 8;

/** The files the compiler reads to preprocess `source`, a probe source that
 * includes `includes`, apart from the probe's own sources. When the compiler
 * rejects `source`, for example for a header it finds that is an #error
 * outside its target (<riscv_vector.h> through clang 18 without the RISC-V
 * vector extension), each header is preprocessed on its own, and a header
 * that the compiler rejects on its own is left out, as an absent one is.
 * Throws the compiler's error when it rejects every header. */
async function probeIncludeDependencies(
  compiler: string,
  probeArgs: readonly string[],
  probeDir: string,
  source: string,
  includes: readonly string[],
): Promise<string[]> {
  const dependencies = async (path: string): Promise<string[]> => {
    const result = await execFileAsync(compiler, [...probeArgs, path], {
      cwd: probeDir,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseMakeDependencies(result.stdout).filter((dependency) => dependency !== path);
  };
  try {
    return await dependencies(source);
  } catch (error) {
    const found: string[][] = [];
    for (let start = 0; start < includes.length; start += SINGLE_HEADER_PROBES) {
      const batch = includes.slice(start, start + SINGLE_HEADER_PROBES);
      const results = await Promise.all(
        batch.map(async (include, offset) => {
          const single = `${source.slice(0, -2)}-${start + offset}.c`;
          await writeFile(single, implicitDependencyIncludeDirective(include));
          return dependencies(single).catch(() => null);
        }),
      );
      for (const result of results) if (result !== null) found.push(result);
    }
    if (found.length === 0) throw error;
    return found.flat();
  }
}

const stableImplicitToolchainMemos = new Map<string, Promise<ImplicitToolchainFingerprints>>();
export function implicitToolchainFingerprints(
  driver: Pick<CcDriver, "argv" | "targetArgs" | "target">,
  environmentFingerprint: string,
): Promise<ImplicitToolchainFingerprints> {
  const key = [
    environmentFingerprint,
    driver.argv.join("\x1f"),
    driver.target ?? "<native>",
    driver.targetArgs.join("\x1f"),
    runtimeSrcDir(),
  ].join("\0");
  return stableTestMemo(stableImplicitToolchainMemos, key, () =>
    implicitToolchainFingerprintsFresh(driver, environmentFingerprint),
  );
}

export function implicitToolchainFingerprint(
  driver: Pick<CcDriver, "argv" | "targetArgs" | "target">,
  environmentFingerprint: string,
): Promise<string> {
  return implicitToolchainFingerprints(driver, environmentFingerprint).then(
    (fingerprints) => fingerprints.complete,
  );
}
