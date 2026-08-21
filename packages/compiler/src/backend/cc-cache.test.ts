import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, expect, test as vitestTest } from "vitest";
import {
  cacheTargetIdentity,
  ccVersionOnce,
  compileC,
  compileLibArchive,
  executableNativeEnvironmentFingerprint,
  implicitDependencyProbeIncludes,
  parseLinkTraceFiles,
  resolveBuildCacheRoot,
  runtimeFingerprint,
  runtimeSrcDir,
  stageRuntimeObjects,
  supportedNativeCacheWarmProfiles,
  toolchainEnvironmentCachePolicy,
  toolchainEnvironmentFingerprint,
  vendorCacheBuildIdentity,
  vendorCacheTargetFlavor,
  warmNativeCaches,
} from "./cc.js";
import { splitLlvmProgram } from "./llvm/split.js";

const scratch: string[] = [];
const TEST_CACHE_IDENTITY = "cc-cache-tests-v1";
const originalStableToolchain = process.env["SCRIPTC_TEST_STABLE_TOOLCHAIN"];
// This file is the strict-path contract: its fixtures replace wrappers,
// headers, SDK selectors, and native inputs in place between invocations.
// The rest of the immutable differential harness may memoize those probes.
delete process.env["SCRIPTC_TEST_STABLE_TOOLCHAIN"];
const originalTrustedCompilerWrapper = process.env["SCRIPTC_TEST_TRUST_COMPILER_WRAPPER"];

/** The cache suite mutates process-wide compiler state and must stay serial
 * within one worker, but CI/Sandbox workers can safely divide its independent
 * tests across processes. Unset runs the complete file for ordinary focused
 * use; i/n uses the same stable hash partition as the corpus harness. */
function cacheTestSelected(name: string): boolean {
  const spec = process.env["SCRIPTC_CACHE_TEST_SHARD"];
  if (spec === undefined || spec === "") return true;
  const match = /^(\d+)\/(\d+)$/.exec(spec);
  if (match === null) throw new Error(`invalid SCRIPTC_CACHE_TEST_SHARD '${spec}' (expected i/n)`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (index < 1 || total < 1 || index > total) {
    throw new Error(`invalid SCRIPTC_CACHE_TEST_SHARD '${spec}' (expected 1 <= i <= n)`);
  }
  return createHash("sha1").update(name).digest().readUInt32BE(0) % total === index - 1;
}

const test = Object.assign(
  (name: string, ...args: unknown[]) =>
    Reflect.apply(cacheTestSelected(name) ? vitestTest : vitestTest.skip, undefined, [name, ...args]),
  {
    skipIf: (condition: boolean) => (name: string, ...args: unknown[]) =>
      Reflect.apply(condition || !cacheTestSelected(name) ? vitestTest.skip : vitestTest, undefined, [
        name,
        ...args,
      ]),
  },
) as typeof vitestTest;

const trustInstrumentedCompilerWrapper = (): void => {
  process.env["SCRIPTC_TEST_TRUST_COMPILER_WRAPPER"] = "1";
};
const executableOnPath = (name: string): string | undefined =>
  (process.env["PATH"] ?? "")
    .split(delimiter)
    .map((entry) => join(entry === "" ? process.cwd() : entry, name))
    .find((candidate) => existsSync(candidate));
const zigExecutable = executableOnPath("zig");
const clangExecutable = executableOnPath("clang");
const arExecutable = executableOnPath("ar");
const ldExecutable = executableOnPath("ld");
const objcopyExecutable = executableOnPath("objcopy");
const nativeShardMergeAvailable =
  process.platform === "darwin"
    ? ldExecutable !== undefined
    : process.platform === "linux"
      ? ldExecutable !== undefined && objcopyExecutable !== undefined
      : process.platform === "win32" && process.arch === "x64";
const completeArtifacts = async (root: string, kind: "bin" | "lib"): Promise<string[]> =>
  (await readdir(join(root, kind))).filter((name) => !name.endsWith(".sha256"));
const cacheTreeBytes = async (root: string): Promise<number> => {
  let total = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) total += (await stat(path)).size;
    }
  };
  await walk(root);
  return total;
};

afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
  if (originalStableToolchain === undefined) {
    delete process.env["SCRIPTC_TEST_STABLE_TOOLCHAIN"];
  } else {
    process.env["SCRIPTC_TEST_STABLE_TOOLCHAIN"] = originalStableToolchain;
  }
});

afterEach(() => {
  if (originalTrustedCompilerWrapper === undefined) {
    delete process.env["SCRIPTC_TEST_TRUST_COMPILER_WRAPPER"];
  } else {
    process.env["SCRIPTC_TEST_TRUST_COMPILER_WRAPPER"] = originalTrustedCompilerWrapper;
  }
});

test("the production cache root follows overrides, platform defaults, and the hard disable", () => {
  expect(resolveBuildCacheRoot({ SCRIPTC_NO_CACHE: "1" }, "linux", "/home/tester")).toBeNull();
  expect(resolveBuildCacheRoot({ SCRIPTC_CACHE_DIR: "" }, "linux", "/home/tester")).toBeNull();
  expect(resolveBuildCacheRoot({ SCRIPTC_CACHE_DIR: "/var/tmp/custom" }, "linux", "/home/tester")).toBe(
    "/var/tmp/custom",
  );
  expect(resolveBuildCacheRoot({ XDG_CACHE_HOME: "/var/tmp/xdg" }, "linux", "/home/tester")).toBe(
    "/var/tmp/xdg/scriptc/build",
  );
  expect(resolveBuildCacheRoot({}, "darwin", "/Users/tester")).toBe(
    "/Users/tester/Library/Caches/scriptc/build",
  );
  expect(resolveBuildCacheRoot({ LOCALAPPDATA: "/Users/tester/AppData/Local" }, "win32", "/Users/tester")).toBe(
    "/Users/tester/AppData/Local/scriptc/cache/build",
  );
});

test.skipIf(process.platform === "win32")(
  "the early executable identity follows a compiler selected behind a stable driver",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-effective-compiler-"));
    scratch.push(dir);
    const binDir = join(dir, "bin");
    const selector = join(dir, "selected");
    const firstCompiler = join(dir, "clang-first");
    const secondCompiler = join(dir, "clang-second");
    await mkdir(binDir);
    await Promise.all([
      writeFile(firstCompiler, "#!/bin/sh\nexit 0\n"),
      writeFile(secondCompiler, "#!/bin/sh\nexit 0\n"),
      writeFile(
        join(binDir, "clang"),
        "#!/bin/sh\nselected=$(cat \"$SCRIPTC_TEST_EFFECTIVE_COMPILER\")\nprintf '\"%s\" \"-cc1\"\\n' \"$selected\" >&2\n",
      ),
      writeFile(selector, `${firstCompiler}\n`),
    ]);
    await Promise.all([
      chmod(firstCompiler, 0o755),
      chmod(secondCompiler, 0o755),
      chmod(join(binDir, "clang"), 0o755),
    ]);
    const env = {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env["PATH"] ?? ""}`,
      SCRIPTC_TEST_EFFECTIVE_COMPILER: selector,
    };

    const first = await executableNativeEnvironmentFingerprint(env);
    expect(await executableNativeEnvironmentFingerprint(env)).toBe(first);
    await writeFile(selector, `${secondCompiler}\n`);
    const second = await executableNativeEnvironmentFingerprint(env);

    expect(second).not.toBe(first);
  },
);

test("native cache identities separate host architectures while cross targets remain explicit", () => {
  expect(cacheTargetIdentity({ target: null }, "darwin", "arm64")).toBe("native:darwin:arm64");
  expect(cacheTargetIdentity({ target: null }, "darwin", "x64")).toBe("native:darwin:x64");
  expect(cacheTargetIdentity({ target: "x86_64-linux-gnu.2.36" }, "darwin", "arm64")).toBe(
    "cross:x86_64-linux-gnu.2.36",
  );
  expect(vendorCacheTargetFlavor({ target: null }, "darwin", "arm64")).toBe(
    "native-darwin-arm64",
  );
  expect(vendorCacheTargetFlavor({ target: null }, "darwin", "x64")).toBe(
    "native-darwin-x64",
  );
  expect(
    vendorCacheTargetFlavor({ target: "x86_64-linux-gnu.2.36" }, "darwin", "arm64"),
  ).toBe("x86_64-linux-gnu.2.36");
});

test("Zig COFF dry-run parsing retains every linker input on its single command line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-link-trace-"));
  scratch.push(dir);
  const probeDir = join(dir, "probe");
  const first = join(dir, "crt2.obj");
  const second = join(dir, "compiler_rt.lib");
  const third = join(dir, "kernel32.lib");
  await mkdir(probeDir);
  await Promise.all([
    writeFile(join(probeDir, "empty.o"), "probe"),
    writeFile(first, "first"),
    writeFile(second, "second"),
    writeFile(third, "third"),
  ]);

  const output = [
    "lld-link",
    `\"${join(probeDir, "empty.o")}\"`,
    `\"${first}\"`,
    `\"${second}\"`,
    `\"${third}\"`,
  ].join(" ");
  expect(await parseLinkTraceFiles(output, probeDir, probeDir, true)).toEqual(
    [first, second, third].sort(),
  );
});

test("the toolchain environment joins cache identities", () => {
  const base = toolchainEnvironmentFingerprint({ PATH: "/usr/bin", CPATH: "/headers/one" });
  expect(toolchainEnvironmentFingerprint({ PATH: "/usr/bin", CPATH: "/headers/two" })).not.toBe(base);
  expect(toolchainEnvironmentFingerprint({ ZIG_LIB_DIR: "/zig/one" })).not.toBe(
    toolchainEnvironmentFingerprint({ ZIG_LIB_DIR: "/zig/two" }),
  );
  expect(toolchainEnvironmentFingerprint({ ZIG_LIBC: "/libc/one.conf" })).not.toBe(
    toolchainEnvironmentFingerprint({ ZIG_LIBC: "/libc/two.conf" }),
  );
  // PATH is deliberately absent from this generic environment hash: the
  // resolved executable identity is keyed separately, while the compiler
  // must still resolve on every cache-enabled call.
  expect(toolchainEnvironmentFingerprint({ PATH: "", CPATH: "/headers/one" })).toBe(base);
  expect(
    toolchainEnvironmentFingerprint({
      PATH: "/usr/bin",
      CPATH: "/headers/one",
      SCRIPTC_CACHE_MAX_MB: "1",
    }),
  ).toBe(base);

  expect(toolchainEnvironmentCachePolicy({ MACOSX_DEPLOYMENT_TARGET: "14.0" })).toEqual({
    completeArtifacts: true,
    runtimeObjects: true,
  });
  expect(toolchainEnvironmentCachePolicy({ LIBRARY_PATH: "/libraries" })).toEqual({
    completeArtifacts: false,
    runtimeObjects: true,
  });
  expect(toolchainEnvironmentCachePolicy({ CPATH: "/headers" })).toEqual({
    completeArtifacts: false,
    runtimeObjects: false,
  });
  // scriptc invokes its compiler and archiver directly; conventional build-
  // system variables do not alter those commands.
  expect(toolchainEnvironmentCachePolicy({ CFLAGS: "-I/headers" })).toEqual({
    completeArtifacts: true,
    runtimeObjects: true,
  });
  expect(toolchainEnvironmentCachePolicy({ ZIG_LIB_DIR: "/zig/lib" })).toEqual({
    completeArtifacts: false,
    runtimeObjects: false,
  });
  expect(toolchainEnvironmentCachePolicy({ ZIG_LIBC: "/zig/libc.conf" })).toEqual({
    completeArtifacts: false,
    runtimeObjects: false,
  });

  expect(vendorCacheBuildIdentity(base, "compiler-one", "sources-one")).not.toBe(
    vendorCacheBuildIdentity(base, "compiler-two", "sources-one"),
  );
  expect(vendorCacheBuildIdentity(base, "compiler-one", "sources-one")).not.toBe(
    vendorCacheBuildIdentity(
      toolchainEnvironmentFingerprint({ MACOSX_DEPLOYMENT_TARGET: "11.0" }),
      "compiler-one",
      "sources-one",
    ),
  );
  expect(vendorCacheBuildIdentity(base, "compiler-one", "sources-one")).not.toBe(
    vendorCacheBuildIdentity(base, "compiler-one", "sources-two"),
  );
});

test.skipIf(process.platform === "win32")(
  "compiler version probes use and remove a private working directory",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-version-probe-"));
    scratch.push(dir);
    const probeTmp = join(dir, "tmp");
    const fakeCompiler = join(dir, "fake-zig");
    await mkdir(probeTmp);
    await writeFile(
      fakeCompiler,
      `#!/bin/sh
: > a.o
printf 'fake zig cc version probe\n'
`,
    );
    await chmod(fakeCompiler, 0o755);
    const oldTmpdir = process.env["TMPDIR"];
    try {
      process.env["TMPDIR"] = probeTmp;
      // Zig 0.16 creates cwd/a.o for `zig cc --version`. Model that side
      // effect directly so this regression does not depend on Zig being
      // installed in every generic test shard.
      await ccVersionOnce([fakeCompiler, "cc"], `version-probe-${dir}`);
      expect(await readdir(probeTmp)).toEqual([]);
    } finally {
      if (oldTmpdir === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = oldTmpdir;
    }
  },
);

test("the runtime fingerprint includes the textually included Ryū sources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-runtime-fingerprint-"));
  scratch.push(dir);
  const rtDir = join(dir, "src");
  const ryuDir = join(dir, "vendor", "ryu");
  await Promise.all([mkdir(rtDir, { recursive: true }), mkdir(ryuDir, { recursive: true })]);
  const pinnedTime = new Date("2000-01-01T00:00:00.000Z");
  await Promise.all([
    writeFile(join(rtDir, "scr_number.c"), '#include "../vendor/ryu/d2s.c"\n'),
    writeFile(join(ryuDir, "d2s.c"), "int ryu_probe = 1;\n"),
  ]);
  await utimes(join(ryuDir, "d2s.c"), pinnedTime, pinnedTime);
  const first = await runtimeFingerprint(rtDir);
  // Timestamp-preserving sync/copy tools can replace bytes without changing
  // the old stat-memo signature. Content, not metadata, owns this identity.
  await writeFile(join(ryuDir, "d2s.c"), "int ryu_probe = 2;\n");
  await utimes(join(ryuDir, "d2s.c"), pinnedTime, pinnedTime);
  expect(await runtimeFingerprint(rtDir)).not.toBe(first);
});

test("the runtime fingerprint includes newly added nested headers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-runtime-fingerprint-nested-"));
  scratch.push(dir);
  const rtDir = join(dir, "src");
  const ryuDir = join(dir, "vendor", "ryu");
  await Promise.all([
    mkdir(join(rtDir, "sys"), { recursive: true }),
    mkdir(ryuDir, { recursive: true }),
  ]);
  await writeFile(join(rtDir, "scr_number.c"), "int scriptc_probe;\n");
  const first = await runtimeFingerprint(rtDir);

  // A new file below an existing include root can win resolution without
  // changing any path selected by the previous dependency scan.
  await writeFile(join(rtDir, "sys", "types.h"), "#define SCRIPTC_SHADOW 1\n");
  expect(await runtimeFingerprint(rtDir)).not.toBe(first);
});

test.skipIf(process.platform === "win32")(
  "the runtime fingerprint follows symlinked source files",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-runtime-fingerprint-symlink-"));
    scratch.push(dir);
    const rtDir = join(dir, "src");
    const ryuDir = join(dir, "vendor", "ryu");
    const target = join(dir, "runtime-target.h");
    await Promise.all([
      mkdir(rtDir, { recursive: true }),
      mkdir(ryuDir, { recursive: true }),
      writeFile(target, "#define SCRIPTC_SYMLINK 1\n"),
    ]);
    await symlink(target, join(rtDir, "linked.h"));
    const first = await runtimeFingerprint(rtDir);

    await writeFile(target, "#define SCRIPTC_SYMLINK 2\n");
    expect(await runtimeFingerprint(rtDir)).not.toBe(first);
  },
);

test.skipIf(process.platform === "win32")(
  "new nested runtime headers invalidate complete and output-local artifacts",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-runtime-shadow-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const fakeRuntime = join(dir, "runtime", "src");
    const projectDir = join(dir, "project");
    const originalRuntime = runtimeSrcDir();
    const cPath = join(projectDir, "program.c");
    const firstOut = join(projectDir, "first");
    const crossOutput = join(projectDir, "cross-output");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldRuntimeDir = process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"];

    try {
      await Promise.all([
        cp(originalRuntime, fakeRuntime, { recursive: true }),
        mkdir(projectDir),
        mkdir(join(dir, "runtime", "vendor"), { recursive: true }).then(() =>
          cp(
            join(originalRuntime, "..", "vendor", "ryu"),
            join(dir, "runtime", "vendor", "ryu"),
            { recursive: true },
          )
        ),
      ]);
      await mkdir(join(fakeRuntime, "sys"));
      const numberSource = join(fakeRuntime, "scr_number.c");
      await writeFile(
        numberSource,
        `${await readFile(numberSource, "utf8")}\n` +
          "#ifndef SCRIPTC_SHADOW_VALUE\n#define SCRIPTC_SHADOW_VALUE 1\n#endif\n" +
          "int scriptc_shadow_value(void) { return SCRIPTC_SHADOW_VALUE; }\n",
      );
      await writeFile(
        cPath,
        "#include <stdio.h>\nint scriptc_shadow_value(void);\n" +
          'int main(void) { printf("%d\\n", scriptc_shadow_value()); return 0; }\n',
      );
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"] = fakeRuntime;
      delete process.env["SCRIPTC_NO_CACHE"];

      await compileC({ cPath, outPath: firstOut, cacheIdentity: "scriptc-generated-v1" });
      expect(execFileSync(firstOut, { encoding: "utf8" }).trim()).toBe("1");

      // scr_runtime.h includes <sys/types.h>. This newly created header wins
      // the existing -I runtime search without changing any dependency path
      // selected during the first build.
      await writeFile(
        join(fakeRuntime, "sys", "types.h"),
        "#include_next <sys/types.h>\n#define SCRIPTC_SHADOW_VALUE 2\n",
      );

      // A new output path bypasses the output-local stamp and probes the
      // cross-output complete-artifact cache directly.
      await compileC({
        cPath,
        outPath: crossOutput,
        cacheIdentity: "scriptc-generated-v1",
      });
      expect(execFileSync(crossOutput, { encoding: "utf8" }).trim()).toBe("2");

      // The original output has an output-local stamp from the first build;
      // it must invalidate for the same namespace change.
      await compileC({ cPath, outPath: firstOut, cacheIdentity: "scriptc-generated-v1" });
      expect(execFileSync(firstOut, { encoding: "utf8" }).trim()).toBe("2");
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldRuntimeDir === undefined) delete process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"];
      else process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"] = oldRuntimeDir;
    }
  },
);

test("implicit dependency seeds include separately compiled vendor system headers", async () => {
  const includes = await implicitDependencyProbeIncludes(runtimeSrcDir());
  // zlib's crc32.c is compiled independently and is not textually reachable
  // from packages/runtime/src. Its ambient C-library dependency still belongs
  // to the native object/cache identity.
  expect(includes).toContain("<stdatomic.h>");
});

test.skipIf(process.platform === "win32")(
  "opaque compiler wrappers bypass persistent caches",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-compiler-wrapper-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const binDir = join(dir, "bin");
    const helperSource = join(dir, "helper.c");
    const helperObject = join(dir, "helper.o");
    const cPath = join(dir, "program.c");
    const outPath = join(dir, "program");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldDisableCcache = process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
    const oldPath = process.env["PATH"];
    const oldRealClang = process.env["SCRIPTC_TEST_REAL_CLANG"];
    const oldProgramSource = process.env["SCRIPTC_TEST_PROGRAM_SOURCE"];
    const oldWrapperObject = process.env["SCRIPTC_TEST_WRAPPER_OBJECT"];
    const originalClang = (oldPath ?? "")
      .split(delimiter)
      .map((entry) => join(entry === "" ? process.cwd() : entry, "clang"))
      .find((candidate) => existsSync(candidate));
    expect(originalClang).toBeDefined();

    const buildHelper = async (value: number): Promise<void> => {
      await writeFile(helperSource, `int scriptc_wrapper_helper(void) { return ${value}; }\n`);
      execFileSync(originalClang!, ["-c", helperSource, "-o", helperObject]);
    };

    try {
      await mkdir(binDir);
      const wrapper = join(binDir, "clang");
      await writeFile(
        wrapper,
        `#!/bin/sh
link=1
real_build=0
for arg in "$@"; do
  case "$arg" in
    -c|-M|-MM|-E|-S) link=0 ;;
    "$SCRIPTC_TEST_PROGRAM_SOURCE"|*/scriptc-cache-build-*/program.c) real_build=1 ;;
  esac
done
if [ "$link" = 1 ] && [ "$real_build" = 1 ]; then
  exec "$SCRIPTC_TEST_REAL_CLANG" "$SCRIPTC_TEST_WRAPPER_OBJECT" "$@"
fi
exec "$SCRIPTC_TEST_REAL_CLANG" "$@"
`,
      );
      await chmod(wrapper, 0o755);
      await writeFile(
        cPath,
        '#include <stdio.h>\nint scriptc_wrapper_helper(void);\nint main(void) { printf("%d\\n", scriptc_wrapper_helper()); return 0; }\n',
      );
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = "1";
      process.env["SCRIPTC_TEST_REAL_CLANG"] = originalClang!;
      process.env["SCRIPTC_TEST_PROGRAM_SOURCE"] = cPath;
      process.env["SCRIPTC_TEST_WRAPPER_OBJECT"] = helperObject;
      process.env["PATH"] = `${binDir}${delimiter}${oldPath ?? ""}`;
      delete process.env["SCRIPTC_NO_CACHE"];

      await buildHelper(1);
      await compileC({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(outPath, { encoding: "utf8" }).trim()).toBe("1");

      // The wrapper injects this same-path object only for the actual program
      // link, not for scriptc's synthetic metadata probes. Reusing the first
      // complete artifact here would return the stale value.
      await buildHelper(2);
      await compileC({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(outPath, { encoding: "utf8" }).trim()).toBe("2");
      await expect(stat(cacheRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldDisableCcache === undefined) delete process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
      else process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = oldDisableCcache;
      if (oldPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = oldPath;
      if (oldRealClang === undefined) delete process.env["SCRIPTC_TEST_REAL_CLANG"];
      else process.env["SCRIPTC_TEST_REAL_CLANG"] = oldRealClang;
      if (oldProgramSource === undefined) delete process.env["SCRIPTC_TEST_PROGRAM_SOURCE"];
      else process.env["SCRIPTC_TEST_PROGRAM_SOURCE"] = oldProgramSource;
      if (oldWrapperObject === undefined) delete process.env["SCRIPTC_TEST_WRAPPER_OBJECT"];
      else process.env["SCRIPTC_TEST_WRAPPER_OBJECT"] = oldWrapperObject;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "opaque archiver wrappers rebuild library archives while retaining runtime objects",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-archiver-wrapper-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const binDir = join(dir, "bin");
    const helperSource = join(dir, "helper.c");
    const helperObject = join(dir, "helper.o");
    const cPath = join(dir, "program.c");
    const archivePath = join(dir, "program.lib.a");
    const probeSource = join(dir, "probe.c");
    const probePath = join(dir, "probe");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldDisableCcache = process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
    const oldPath = process.env["PATH"];
    const oldRealAr = process.env["SCRIPTC_TEST_REAL_AR"];
    const oldArExtra = process.env["SCRIPTC_TEST_AR_EXTRA"];
    const originalClang = (oldPath ?? "")
      .split(delimiter)
      .map((entry) => join(entry === "" ? process.cwd() : entry, "clang"))
      .find((candidate) => existsSync(candidate));
    const originalAr = (oldPath ?? "")
      .split(delimiter)
      .map((entry) => join(entry === "" ? process.cwd() : entry, "ar"))
      .find((candidate) => existsSync(candidate));
    expect(originalClang).toBeDefined();
    expect(originalAr).toBeDefined();

    const buildHelper = async (value: number): Promise<void> => {
      await writeFile(helperSource, `int scriptc_archiver_helper(void) { return ${value}; }\n`);
      execFileSync(originalClang!, ["-c", helperSource, "-o", helperObject]);
    };
    const runProbe = (): string => {
      execFileSync(originalClang!, [probeSource, archivePath, "-o", probePath]);
      return execFileSync(probePath, { encoding: "utf8" }).trim();
    };

    try {
      await mkdir(binDir);
      await writeFile(
        join(binDir, "ar"),
        `#!/bin/sh
if [ "$1" = "--version" ]; then
  exec "$SCRIPTC_TEST_REAL_AR" "$@"
fi
exec "$SCRIPTC_TEST_REAL_AR" "$@" "$SCRIPTC_TEST_AR_EXTRA"
`,
      );
      await chmod(join(binDir, "ar"), 0o755);
      await writeFile(cPath, "int scriptc_program_member = 1;\n");
      await writeFile(
        probeSource,
        '#include <stdio.h>\nint scriptc_archiver_helper(void);\nint main(void) { printf("%d\\n", scriptc_archiver_helper()); return 0; }\n',
      );
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = "1";
      process.env["SCRIPTC_TEST_REAL_AR"] = originalAr!;
      process.env["SCRIPTC_TEST_AR_EXTRA"] = helperObject;
      process.env["PATH"] = `${binDir}${delimiter}${oldPath ?? ""}`;
      delete process.env["SCRIPTC_NO_CACHE"];

      await buildHelper(1);
      await compileLibArchive({
        cPath,
        outPath: archivePath,
        cacheIdentity: TEST_CACHE_IDENTITY,
      });
      expect(runProbe()).toBe("1");
      const objectSets = (await readdir(join(cacheRoot, "obj"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("build-"));
      expect(objectSets).toHaveLength(1);
      await expect(stat(join(cacheRoot, "lib"))).rejects.toMatchObject({ code: "ENOENT" });

      // The wrapper executable/version and every scriptc-owned input remain
      // unchanged. Only the mutable object it injects into `ar rcs` changes.
      // A complete archive hit would silently retain the first definition.
      await buildHelper(2);
      await compileLibArchive({
        cPath,
        outPath: archivePath,
        cacheIdentity: TEST_CACHE_IDENTITY,
      });
      expect(runProbe()).toBe("2");
      expect(
        (await readdir(join(cacheRoot, "obj"), { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("build-")),
      ).toHaveLength(1);
      await expect(stat(join(cacheRoot, "lib"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldDisableCcache === undefined) delete process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
      else process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = oldDisableCcache;
      if (oldPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = oldPath;
      if (oldRealAr === undefined) delete process.env["SCRIPTC_TEST_REAL_AR"];
      else process.env["SCRIPTC_TEST_REAL_AR"] = oldRealAr;
      if (oldArExtra === undefined) delete process.env["SCRIPTC_TEST_AR_EXTRA"];
      else process.env["SCRIPTC_TEST_AR_EXTRA"] = oldArExtra;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "build-flavor-specific compiler-wrapper flags join the cache identity",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-wrapper-env-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const binDir = join(dir, "bin");
    const cPath = join(dir, "program.c");
    const outPath = join(dir, "program");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldDisableCcache = process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
    const oldPath = process.env["PATH"];
    const oldRealClang = process.env["SCRIPTC_TEST_REAL_CLANG"];
    const oldWrapperValue = process.env["SCRIPTC_TEST_WRAPPER_VALUE"];
    const realClang = (oldPath ?? "")
      .split(delimiter)
      .map((entry) => join(entry === "" ? process.cwd() : entry, "clang"))
      .find((candidate) => existsSync(candidate));
    expect(realClang).toBeDefined();

    try {
      await mkdir(binDir);
      const wrapper = join(binDir, "clang");
      await writeFile(
        wrapper,
        `#!/bin/sh
if [ "$1" = "--version" ]; then
  exec "$SCRIPTC_TEST_REAL_CLANG" "$@"
fi
inject=0
for arg in "$@"; do
  if [ "$arg" = "-O2" ]; then inject=1; fi
done
if [ "$inject" = 1 ]; then
  exec "$SCRIPTC_TEST_REAL_CLANG" "-DSCRIPTC_WRAPPER_VALUE=$SCRIPTC_TEST_WRAPPER_VALUE" "$@"
fi
exec "$SCRIPTC_TEST_REAL_CLANG" "$@"
`,
      );
      await chmod(wrapper, 0o755);
      await writeFile(
        cPath,
        '#include <stdio.h>\nint main(void) { printf("%d\\n", SCRIPTC_WRAPPER_VALUE); return 0; }\n',
      );
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = "1";
      process.env["SCRIPTC_TEST_REAL_CLANG"] = realClang!;
      process.env["PATH"] = `${binDir}${delimiter}${oldPath ?? ""}`;
      trustInstrumentedCompilerWrapper();
      delete process.env["SCRIPTC_NO_CACHE"];

      process.env["SCRIPTC_TEST_WRAPPER_VALUE"] = "1";
      await compileC({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(outPath, { encoding: "utf8" }).trim()).toBe("1");

      // This variable is intentionally absent from scriptc's fixed environment
      // allowlist, and the wrapper injects it only for the real -O2 build
      // flavor. A generic metadata-probe trace must not hide the change.
      process.env["SCRIPTC_TEST_WRAPPER_VALUE"] = "2";
      await compileC({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(outPath, { encoding: "utf8" }).trim()).toBe("2");
      expect(await completeArtifacts(cacheRoot, "bin")).toHaveLength(2);
      const objectSets = (await readdir(join(cacheRoot, "obj"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("build-"));
      expect(objectSets).toHaveLength(2);
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldDisableCcache === undefined) delete process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
      else process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = oldDisableCcache;
      if (oldPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = oldPath;
      if (oldRealClang === undefined) delete process.env["SCRIPTC_TEST_REAL_CLANG"];
      else process.env["SCRIPTC_TEST_REAL_CLANG"] = oldRealClang;
      if (oldWrapperValue === undefined) delete process.env["SCRIPTC_TEST_WRAPPER_VALUE"];
      else process.env["SCRIPTC_TEST_WRAPPER_VALUE"] = oldWrapperValue;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "build-flavor-specific compiler-wrapper headers key runtime objects by content",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-wrapper-header-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const binDir = join(dir, "bin");
    const fakeRuntime = join(dir, "runtime", "src");
    const header = join(dir, "wrapper-input.h");
    const cPath = join(dir, "program.c");
    const outPath = join(dir, "program");
    const originalRuntime = runtimeSrcDir();
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldRuntimeDir = process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"];
    const oldDisableCcache = process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
    const oldPath = process.env["PATH"];
    const oldRealClang = process.env["SCRIPTC_TEST_REAL_CLANG"];
    const oldWrapperHeader = process.env["SCRIPTC_TEST_WRAPPER_HEADER"];
    const realClang = (oldPath ?? "")
      .split(delimiter)
      .map((entry) => join(entry === "" ? process.cwd() : entry, "clang"))
      .find((candidate) => existsSync(candidate));
    expect(realClang).toBeDefined();

    try {
      await Promise.all([
        mkdir(binDir),
        cp(originalRuntime, fakeRuntime, { recursive: true }),
        mkdir(join(dir, "runtime", "vendor"), { recursive: true }).then(() =>
          cp(join(originalRuntime, "..", "vendor", "ryu"), join(dir, "runtime", "vendor", "ryu"), {
            recursive: true,
          }),
        ),
      ]);
      const numberSource = join(fakeRuntime, "scr_number.c");
      await writeFile(
        numberSource,
        `${await readFile(numberSource, "utf8")}\nint scriptc_wrapper_runtime_value(void) { return SCRIPTC_WRAPPER_HEADER_VALUE; }\n`,
      );
      const wrapper = join(binDir, "clang");
      await writeFile(
        wrapper,
        `#!/bin/sh
case "$1" in
  --version|-print-prog-name=*) exec "$SCRIPTC_TEST_REAL_CLANG" "$@" ;;
esac
flavor=0
for arg in "$@"; do
  if [ "$arg" = "-O2" ]; then flavor=1; fi
done
if [ "$flavor" = 1 ]; then
  exec "$SCRIPTC_TEST_REAL_CLANG" -include "$SCRIPTC_TEST_WRAPPER_HEADER" "$@"
fi
exec "$SCRIPTC_TEST_REAL_CLANG" "$@"
`,
      );
      await chmod(wrapper, 0o755);
      await writeFile(
        cPath,
        '#include <stdio.h>\nint scriptc_wrapper_runtime_value(void);\nint main(void) { printf("%d\\n", scriptc_wrapper_runtime_value()); return 0; }\n',
      );
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"] = fakeRuntime;
      process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = "1";
      process.env["SCRIPTC_TEST_REAL_CLANG"] = realClang!;
      process.env["SCRIPTC_TEST_WRAPPER_HEADER"] = header;
      process.env["PATH"] = `${binDir}${delimiter}${oldPath ?? ""}`;
      trustInstrumentedCompilerWrapper();
      delete process.env["SCRIPTC_NO_CACHE"];

      await writeFile(header, "#define SCRIPTC_WRAPPER_HEADER_VALUE 1\n");
      await compileC({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(outPath, { encoding: "utf8" }).trim()).toBe("1");

      // The wrapper's -### text still names the same -include path. Its bytes,
      // not merely that spelling, must re-key every runtime object it affects.
      await writeFile(header, "#define SCRIPTC_WRAPPER_HEADER_VALUE 2\n");
      await compileC({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(outPath, { encoding: "utf8" }).trim()).toBe("2");
      const objectSets = (await readdir(join(cacheRoot, "obj"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("build-"));
      expect(objectSets).toHaveLength(2);
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldRuntimeDir === undefined) delete process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"];
      else process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"] = oldRuntimeDir;
      if (oldDisableCcache === undefined) delete process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
      else process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = oldDisableCcache;
      if (oldPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = oldPath;
      if (oldRealClang === undefined) delete process.env["SCRIPTC_TEST_REAL_CLANG"];
      else process.env["SCRIPTC_TEST_REAL_CLANG"] = oldRealClang;
      if (oldWrapperHeader === undefined) delete process.env["SCRIPTC_TEST_WRAPPER_HEADER"];
      else process.env["SCRIPTC_TEST_WRAPPER_HEADER"] = oldWrapperHeader;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "build-flavor-specific compiler-wrapper link flags join the artifact identity",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-wrapper-link-env-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const binDir = join(dir, "bin");
    const cPath = join(dir, "program.c");
    const outPath = join(dir, "program");
    const firstRpath = join(dir, "rpath-one");
    const secondRpath = join(dir, "rpath-two");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldDisableCcache = process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
    const oldPath = process.env["PATH"];
    const oldRealClang = process.env["SCRIPTC_TEST_REAL_CLANG"];
    const oldWrapperRpath = process.env["SCRIPTC_TEST_WRAPPER_RPATH"];
    const realClang = (oldPath ?? "")
      .split(delimiter)
      .map((entry) => join(entry === "" ? process.cwd() : entry, "clang"))
      .find((candidate) => existsSync(candidate));
    expect(realClang).toBeDefined();

    try {
      await mkdir(binDir);
      const wrapper = join(binDir, "clang");
      await writeFile(
        wrapper,
        `#!/bin/sh
case "$1" in
  --version|-print-prog-name=*) exec "$SCRIPTC_TEST_REAL_CLANG" "$@" ;;
esac
link=1
flavor=0
for arg in "$@"; do
  case "$arg" in
    -c|-M|-MM|-E|-S) link=0 ;;
    -O2) flavor=1 ;;
  esac
done
if [ "$link" = 1 ] && [ "$flavor" = 1 ]; then
  exec "$SCRIPTC_TEST_REAL_CLANG" "-Wl,-rpath,$SCRIPTC_TEST_WRAPPER_RPATH" "$@"
fi
exec "$SCRIPTC_TEST_REAL_CLANG" "$@"
`,
      );
      await chmod(wrapper, 0o755);
      await writeFile(cPath, "int main(void) { return 0; }\n");
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = "1";
      process.env["SCRIPTC_TEST_REAL_CLANG"] = realClang!;
      process.env["PATH"] = `${binDir}${delimiter}${oldPath ?? ""}`;
      trustInstrumentedCompilerWrapper();
      delete process.env["SCRIPTC_NO_CACHE"];

      process.env["SCRIPTC_TEST_WRAPPER_RPATH"] = firstRpath;
      await compileC({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
      expect((await readFile(outPath)).includes(Buffer.from(firstRpath))).toBe(true);

      // The wrapper's generic link trace and resolved linker inputs are
      // unchanged; only the real -O2 link flavor exposes this value.
      process.env["SCRIPTC_TEST_WRAPPER_RPATH"] = secondRpath;
      await compileC({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
      const secondBinary = await readFile(outPath);
      expect(secondBinary.includes(Buffer.from(secondRpath))).toBe(true);
      expect(secondBinary.includes(Buffer.from(firstRpath))).toBe(false);
      expect(await completeArtifacts(cacheRoot, "bin")).toHaveLength(2);
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldDisableCcache === undefined) delete process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
      else process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = oldDisableCcache;
      if (oldPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = oldPath;
      if (oldRealClang === undefined) delete process.env["SCRIPTC_TEST_REAL_CLANG"];
      else process.env["SCRIPTC_TEST_REAL_CLANG"] = oldRealClang;
      if (oldWrapperRpath === undefined) delete process.env["SCRIPTC_TEST_WRAPPER_RPATH"];
      else process.env["SCRIPTC_TEST_WRAPPER_RPATH"] = oldWrapperRpath;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "build-flavor-specific compiler-wrapper link inputs join by content",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-wrapper-link-input-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const binDir = join(dir, "bin");
    const helperSource = join(dir, "helper.c");
    const helperObject = join(dir, "helper.o");
    const cPath = join(dir, "program.c");
    const outPath = join(dir, "program");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldDisableCcache = process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
    const oldPath = process.env["PATH"];
    const oldRealClang = process.env["SCRIPTC_TEST_REAL_CLANG"];
    const oldWrapperObject = process.env["SCRIPTC_TEST_WRAPPER_OBJECT"];
    const realClang = (oldPath ?? "")
      .split(delimiter)
      .map((entry) => join(entry === "" ? process.cwd() : entry, "clang"))
      .find((candidate) => existsSync(candidate));
    expect(realClang).toBeDefined();

    const buildHelper = async (value: number): Promise<void> => {
      await writeFile(helperSource, `int scriptc_wrapper_helper(void) { return ${value}; }\n`);
      execFileSync(realClang!, ["-c", helperSource, "-o", helperObject]);
    };

    try {
      await mkdir(binDir);
      const wrapper = join(binDir, "clang");
      await writeFile(
        wrapper,
        `#!/bin/sh
case "$1" in
  --version|-print-prog-name=*) exec "$SCRIPTC_TEST_REAL_CLANG" "$@" ;;
esac
link=1
flavor=0
for arg in "$@"; do
  case "$arg" in
    -c|-M|-MM|-E|-S) link=0 ;;
    -O2) flavor=1 ;;
  esac
done
if [ "$link" = 1 ] && [ "$flavor" = 1 ]; then
  exec "$SCRIPTC_TEST_REAL_CLANG" "$SCRIPTC_TEST_WRAPPER_OBJECT" "$@"
fi
exec "$SCRIPTC_TEST_REAL_CLANG" "$@"
`,
      );
      await chmod(wrapper, 0o755);
      await writeFile(
        cPath,
        '#include <stdio.h>\nint scriptc_wrapper_helper(void);\nint main(void) { printf("%d\\n", scriptc_wrapper_helper()); return 0; }\n',
      );
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = "1";
      process.env["SCRIPTC_TEST_REAL_CLANG"] = realClang!;
      process.env["SCRIPTC_TEST_WRAPPER_OBJECT"] = helperObject;
      process.env["PATH"] = `${binDir}${delimiter}${oldPath ?? ""}`;
      trustInstrumentedCompilerWrapper();
      delete process.env["SCRIPTC_NO_CACHE"];

      await buildHelper(1);
      await compileC({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(outPath, { encoding: "utf8" }).trim()).toBe("1");

      // The injected path remains stable while the object is rebuilt in place.
      // A flavor-mismatched trace sees neither edit and would return a stale hit.
      await buildHelper(2);
      await compileC({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(outPath, { encoding: "utf8" }).trim()).toBe("2");
      expect(await completeArtifacts(cacheRoot, "bin")).toHaveLength(2);
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldDisableCcache === undefined) delete process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
      else process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = oldDisableCcache;
      if (oldPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = oldPath;
      if (oldRealClang === undefined) delete process.env["SCRIPTC_TEST_REAL_CLANG"];
      else process.env["SCRIPTC_TEST_REAL_CLANG"] = oldRealClang;
      if (oldWrapperObject === undefined) delete process.env["SCRIPTC_TEST_WRAPPER_OBJECT"];
      else process.env["SCRIPTC_TEST_WRAPPER_OBJECT"] = oldWrapperObject;
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "cached Darwin executables preserve the requested code-signature identifier",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-darwin-identifier-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const cPath = join(dir, "program.c");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];

    const codeSignatureIdentifier = (path: string): string | undefined => {
      const result = spawnSync("codesign", ["-d", "-vv", path], { encoding: "utf8" });
      expect(result.status).toBe(0);
      return /^Identifier=(.+)$/m.exec(`${result.stdout}\n${result.stderr}`)?.[1];
    };

    try {
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      delete process.env["SCRIPTC_NO_CACHE"];
      await writeFile(cPath, "int main(void) { return 0; }\n");

      const firstOut = join(dir, "requested-one");
      await compileC({ cPath, outPath: firstOut, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(codeSignatureIdentifier(firstOut)).toBe("requested-one");

      const secondOut = join(dir, "requested-two");
      await compileC({ cPath, outPath: secondOut, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(codeSignatureIdentifier(secondOut)).toBe("requested-two");
      expect(await completeArtifacts(cacheRoot, "bin")).toHaveLength(2);
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "implicit system-header changes invalidate complete artifacts and runtime objects",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-system-header-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const binDir = join(dir, "bin");
    const header = join(dir, "implicit-probe.h");
    const cPath = join(dir, "program.c");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldPath = process.env["PATH"];
    const oldRealClang = process.env["SCRIPTC_TEST_REAL_CLANG"];
    const oldImplicitHeader = process.env["SCRIPTC_TEST_IMPLICIT_HEADER"];
    const realClang = (oldPath ?? "")
      .split(delimiter)
      .map((entry) => join(entry === "" ? process.cwd() : entry, "clang"))
      .find((candidate) => existsSync(candidate));
    expect(realClang).toBeDefined();

    try {
      await mkdir(binDir);
      const wrapper = join(binDir, "clang");
      await writeFile(
        wrapper,
        `#!/bin/sh
exec "$SCRIPTC_TEST_REAL_CLANG" -include "$SCRIPTC_TEST_IMPLICIT_HEADER" "$@"
`,
      );
      await chmod(wrapper, 0o755);
      await writeFile(
        cPath,
        '#include <stdio.h>\nint main(void) { puts(SCRIPTC_IMPLICIT_PROBE); return 0; }\n',
      );
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      process.env["SCRIPTC_TEST_REAL_CLANG"] = realClang!;
      process.env["SCRIPTC_TEST_IMPLICIT_HEADER"] = header;
      process.env["PATH"] = `${binDir}${delimiter}${oldPath ?? ""}`;
      trustInstrumentedCompilerWrapper();
      delete process.env["SCRIPTC_NO_CACHE"];

      await writeFile(header, '#define SCRIPTC_IMPLICIT_PROBE "one"\n');
      const firstOut = join(dir, "first");
      await compileC({ cPath, outPath: firstOut, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(firstOut, { encoding: "utf8" }).trim()).toBe("one");

      // The compiler executable, PATH, source, and environment spellings are
      // unchanged; only a header in the driver's implicit dependency graph moves.
      await writeFile(header, '#define SCRIPTC_IMPLICIT_PROBE "two"\n');
      const secondOut = firstOut;
      await compileC({ cPath, outPath: secondOut, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(secondOut, { encoding: "utf8" }).trim()).toBe("two");
      expect(await completeArtifacts(cacheRoot, "bin")).toHaveLength(2);
      const objectSets = (await readdir(join(cacheRoot, "obj"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("build-"));
      expect(objectSets).toHaveLength(2);
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = oldPath;
      if (oldRealClang === undefined) delete process.env["SCRIPTC_TEST_REAL_CLANG"];
      else process.env["SCRIPTC_TEST_REAL_CLANG"] = oldRealClang;
      if (oldImplicitHeader === undefined) delete process.env["SCRIPTC_TEST_IMPLICIT_HEADER"];
      else process.env["SCRIPTC_TEST_IMPLICIT_HEADER"] = oldImplicitHeader;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "headers selected only by the caller translation unit invalidate complete artifacts",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-program-header-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const binDir = join(dir, "bin");
    const headers = join(dir, "system-headers");
    const header = join(headers, "scriptc_program_probe.h");
    const cPath = join(dir, "program.c");
    const outPath = join(dir, "program");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldDisableCcache = process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
    const oldPath = process.env["PATH"];
    const oldRealClang = process.env["SCRIPTC_TEST_REAL_CLANG"];
    const oldHeaderDir = process.env["SCRIPTC_TEST_PROGRAM_HEADER_DIR"];
    const realClang = (oldPath ?? "")
      .split(delimiter)
      .map((entry) => join(entry === "" ? process.cwd() : entry, "clang"))
      .find((candidate) => existsSync(candidate));
    expect(realClang).toBeDefined();

    try {
      await Promise.all([mkdir(binDir), mkdir(headers)]);
      const wrapper = join(binDir, "clang");
      await writeFile(
        wrapper,
        `#!/bin/sh
case "$1" in
  --version|-print-prog-name=*) exec "$SCRIPTC_TEST_REAL_CLANG" "$@" ;;
esac
exec "$SCRIPTC_TEST_REAL_CLANG" -isystem "$SCRIPTC_TEST_PROGRAM_HEADER_DIR" "$@"
`,
      );
      await chmod(wrapper, 0o755);
      await writeFile(
        cPath,
        '#include <stdio.h>\n#include <scriptc_program_probe.h>\nint main(void) { puts(SCRIPTC_PROGRAM_HEADER); return 0; }\n',
      );
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = "1";
      process.env["SCRIPTC_TEST_REAL_CLANG"] = realClang!;
      process.env["SCRIPTC_TEST_PROGRAM_HEADER_DIR"] = headers;
      process.env["PATH"] = `${binDir}${delimiter}${oldPath ?? ""}`;
      trustInstrumentedCompilerWrapper();
      delete process.env["SCRIPTC_NO_CACHE"];

      await writeFile(header, '#define SCRIPTC_PROGRAM_HEADER "one"\n');
      await compileC({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(outPath, { encoding: "utf8" }).trim()).toBe("one");

      // The runtime/vendor seed probe never includes this spelling; only a
      // dependency pass over the caller TU can observe its bytes.
      await writeFile(header, '#define SCRIPTC_PROGRAM_HEADER "two"\n');
      await compileC({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(outPath, { encoding: "utf8" }).trim()).toBe("two");
      expect(await completeArtifacts(cacheRoot, "bin")).toHaveLength(2);

      await writeFile(header, '#define SCRIPTC_PROGRAM_HEADER "lib-one-unique"\n');
      const archivePath = join(dir, "program.lib.a");
      await compileLibArchive({ cPath, outPath: archivePath, cacheIdentity: TEST_CACHE_IDENTITY });
      await writeFile(header, '#define SCRIPTC_PROGRAM_HEADER "lib-two-unique"\n');
      await compileLibArchive({ cPath, outPath: archivePath, cacheIdentity: TEST_CACHE_IDENTITY });
      const archive = await readFile(archivePath);
      expect(archive.includes(Buffer.from("lib-two-unique"))).toBe(true);
      expect(archive.includes(Buffer.from("lib-one-unique"))).toBe(false);
      expect(await completeArtifacts(cacheRoot, "lib")).toHaveLength(2);
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldDisableCcache === undefined) delete process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
      else process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = oldDisableCcache;
      if (oldPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = oldPath;
      if (oldRealClang === undefined) delete process.env["SCRIPTC_TEST_REAL_CLANG"];
      else process.env["SCRIPTC_TEST_REAL_CLANG"] = oldRealClang;
      if (oldHeaderDir === undefined) delete process.env["SCRIPTC_TEST_PROGRAM_HEADER_DIR"];
      else process.env["SCRIPTC_TEST_PROGRAM_HEADER_DIR"] = oldHeaderDir;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "fresh dependency discovery detects an implicit include redirected to a new path",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-header-redirect-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const binDir = join(dir, "bin");
    const selector = join(dir, "selected-header");
    const firstHeader = join(dir, "implicit-one.h");
    const secondHeader = join(dir, "implicit-two.h");
    const cPath = join(dir, "program.c");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldDisableCcache = process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
    const oldPath = process.env["PATH"];
    const oldRealClang = process.env["SCRIPTC_TEST_REAL_CLANG"];
    const oldSelector = process.env["SCRIPTC_TEST_IMPLICIT_SELECTOR"];
    const realClang = (oldPath ?? "")
      .split(delimiter)
      .map((entry) => join(entry === "" ? process.cwd() : entry, "clang"))
      .find((candidate) => existsSync(candidate));
    expect(realClang).toBeDefined();

    try {
      await mkdir(binDir);
      const wrapper = join(binDir, "clang");
      await writeFile(
        wrapper,
        `#!/bin/sh
IFS= read -r selected < "$SCRIPTC_TEST_IMPLICIT_SELECTOR"
exec "$SCRIPTC_TEST_REAL_CLANG" -include "$selected" "$@"
`,
      );
      await chmod(wrapper, 0o755);
      await Promise.all([
        writeFile(firstHeader, '#define SCRIPTC_IMPLICIT_REDIRECT "one"\n'),
        writeFile(secondHeader, '#define SCRIPTC_IMPLICIT_REDIRECT "two"\n'),
        writeFile(
          cPath,
          '#include <stdio.h>\nint main(void) { puts(SCRIPTC_IMPLICIT_REDIRECT); return 0; }\n',
        ),
      ]);
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = "1";
      process.env["SCRIPTC_TEST_REAL_CLANG"] = realClang!;
      process.env["SCRIPTC_TEST_IMPLICIT_SELECTOR"] = selector;
      process.env["PATH"] = `${binDir}${delimiter}${oldPath ?? ""}`;
      trustInstrumentedCompilerWrapper();
      delete process.env["SCRIPTC_NO_CACHE"];

      await writeFile(selector, `${firstHeader}\n`);
      const firstOut = join(dir, "first");
      await compileC({ cPath, outPath: firstOut, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(firstOut, { encoding: "utf8" }).trim()).toBe("one");

      // Keep the old header and every cache/environment spelling unchanged.
      // Only a fresh `clang -M` can observe that the wrapper now selects a
      // different path whose bytes belong to a different cache identity.
      await writeFile(selector, `${secondHeader}\n`);
      const secondOut = firstOut;
      await compileC({ cPath, outPath: secondOut, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(secondOut, { encoding: "utf8" }).trim()).toBe("two");
      expect(await completeArtifacts(cacheRoot, "bin")).toHaveLength(2);
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldDisableCcache === undefined) delete process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
      else process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = oldDisableCcache;
      if (oldPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = oldPath;
      if (oldRealClang === undefined) delete process.env["SCRIPTC_TEST_REAL_CLANG"];
      else process.env["SCRIPTC_TEST_REAL_CLANG"] = oldRealClang;
      if (oldSelector === undefined) delete process.env["SCRIPTC_TEST_IMPLICIT_SELECTOR"];
      else process.env["SCRIPTC_TEST_IMPLICIT_SELECTOR"] = oldSelector;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a missing compiler cannot reuse a dependency list that may have new higher-priority headers",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-missing-compiler-header-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const cPath = join(dir, "program.c");
    const outPath = join(dir, "program");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldDisableCcache = process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
    const oldPath = process.env["PATH"];

    try {
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = "1";
      delete process.env["SCRIPTC_NO_CACHE"];
      await writeFile(
        cPath,
        '#include "scr_runtime.h"\n#include <stdio.h>\n#ifndef SHADOW_VALUE\n#define SHADOW_VALUE "old"\n#endif\nint main(void) { puts(SHADOW_VALUE); return 0; }\n',
      );
      await compileC({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(outPath, { encoding: "utf8" }).trim()).toBe("old");

      // The old runtime header remains byte-identical, but this new local
      // header wins quote-include resolution. Without a compiler, rehashing
      // only the old dependency path cannot discover the new selection.
      await writeFile(join(dir, "scr_runtime.h"), '#define SHADOW_VALUE "new"\n');
      process.env["PATH"] = "";
      await rm(outPath, { force: true });
      await expect(
        compileC({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY }),
      ).rejects.toThrow(/failed compiling/);

      process.env["PATH"] = oldPath;
      await compileC({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(outPath, { encoding: "utf8" }).trim()).toBe("new");
      expect(await completeArtifacts(cacheRoot, "bin")).toHaveLength(2);
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldDisableCcache === undefined) delete process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
      else process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = oldDisableCcache;
      if (oldPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = oldPath;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "implicit linker inputs join the complete artifact identity",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-implicit-link-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const binDir = join(dir, "bin");
    const helperSource = join(dir, "implicit-helper.c");
    const helperObject = join(dir, "implicit-helper.o");
    const cPath = join(dir, "program.c");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldDisableCcache = process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
    const oldPath = process.env["PATH"];
    const oldRealClang = process.env["SCRIPTC_TEST_REAL_CLANG"];
    const oldImplicitObject = process.env["SCRIPTC_TEST_IMPLICIT_OBJECT"];
    const realClang = (oldPath ?? "")
      .split(delimiter)
      .map((entry) => join(entry === "" ? process.cwd() : entry, "clang"))
      .find((candidate) => existsSync(candidate));
    expect(realClang).toBeDefined();

    const buildHelper = async (value: number): Promise<void> => {
      await writeFile(helperSource, `int scriptc_implicit_helper(void) { return ${value}; }\n`);
      execFileSync(realClang!, ["-c", helperSource, "-o", helperObject]);
    };

    try {
      await mkdir(binDir);
      const wrapper = join(binDir, "clang");
      await writeFile(
        wrapper,
        `#!/bin/sh
compile_only=0
dependency_only=0
has_output=0
for arg in "$@"; do
  case "$arg" in
    -c) compile_only=1 ;;
    -M|-MM) dependency_only=1 ;;
    -o) has_output=1 ;;
  esac
done
if [ "$has_output" = 1 ] && [ "$compile_only" = 0 ] && [ "$dependency_only" = 0 ]; then
  exec "$SCRIPTC_TEST_REAL_CLANG" "$@" "$SCRIPTC_TEST_IMPLICIT_OBJECT"
fi
exec "$SCRIPTC_TEST_REAL_CLANG" "$@"
`,
      );
      await chmod(wrapper, 0o755);
      await writeFile(
        cPath,
        '#include <stdio.h>\nint scriptc_implicit_helper(void);\nint main(void) { printf("%d\\n", scriptc_implicit_helper()); return 0; }\n',
      );
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = "1";
      process.env["SCRIPTC_TEST_REAL_CLANG"] = realClang!;
      process.env["SCRIPTC_TEST_IMPLICIT_OBJECT"] = helperObject;
      process.env["PATH"] = `${binDir}${delimiter}${oldPath ?? ""}`;
      trustInstrumentedCompilerWrapper();
      delete process.env["SCRIPTC_NO_CACHE"];

      await buildHelper(1);
      const firstOut = join(dir, "first");
      await compileC({ cPath, outPath: firstOut, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(firstOut, { encoding: "utf8" }).trim()).toBe("1");

      await buildHelper(2);
      const secondOut = firstOut;
      await compileC({ cPath, outPath: secondOut, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(secondOut, { encoding: "utf8" }).trim()).toBe("2");
      expect(await completeArtifacts(cacheRoot, "bin")).toHaveLength(2);
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldDisableCcache === undefined) delete process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
      else process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = oldDisableCcache;
      if (oldPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = oldPath;
      if (oldRealClang === undefined) delete process.env["SCRIPTC_TEST_REAL_CLANG"];
      else process.env["SCRIPTC_TEST_REAL_CLANG"] = oldRealClang;
      if (oldImplicitObject === undefined) delete process.env["SCRIPTC_TEST_IMPLICIT_OBJECT"];
      else process.env["SCRIPTC_TEST_IMPLICIT_OBJECT"] = oldImplicitObject;
    }
  },
);

test.skipIf(process.platform === "win32" || zigExecutable === undefined)(
  "zig COFF dry-run inputs retain complete cross-target cache hits",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-zig-coff-link-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const cPath = join(dir, "program.c");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldCc = process.env["SCRIPTC_CC"];
    const oldTarget = process.env["SCRIPTC_TARGET"];
    const oldPath = process.env["PATH"];

    try {
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      process.env["SCRIPTC_CC"] = "zigcc";
      process.env["SCRIPTC_TARGET"] = "x86_64-windows-gnu";
      delete process.env["SCRIPTC_NO_CACHE"];
      await writeFile(cPath, "int main(void) { return 0; }\n");

      const firstOut = join(dir, "first.exe");
      await compileC({ cPath, outPath: firstOut, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(await completeArtifacts(cacheRoot, "bin")).toHaveLength(1);

      // lld-link rejects GNU ld's `-t`; the Zig `-###` fallback must still
      // capture every absolute CRT/import-library input. Pin the object-cache
      // mtimes: a complete hit never stages them, while a miss promotes them.
      const [objectSet] = (await readdir(join(cacheRoot, "obj"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("build-"));
      expect(objectSet).toBeDefined();
      const objectDir = join(cacheRoot, "obj", objectSet!.name);
      const objectNames = (await readdir(objectDir)).filter((name) => name.endsWith(".o"));
      const pinnedTime = new Date("2000-01-01T00:00:00.000Z");
      await Promise.all(objectNames.map((name) => utimes(join(objectDir, name), pinnedTime, pinnedTime)));
      const hitOut = join(dir, "hit.exe");
      await compileC({ cPath, outPath: hitOut, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(await readFile(hitOut)).toEqual(await readFile(firstOut));
      for (const name of objectNames) {
        expect((await stat(join(objectDir, name))).mtimeMs).toBe(pinnedTime.getTime());
      }
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldCc === undefined) delete process.env["SCRIPTC_CC"];
      else process.env["SCRIPTC_CC"] = oldCc;
      if (oldTarget === undefined) delete process.env["SCRIPTC_TARGET"];
      else process.env["SCRIPTC_TARGET"] = oldTarget;
      if (oldPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = oldPath;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "compiler metadata-probe failures fall back to a normal build",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-probe-fallback-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const binDir = join(dir, "bin");
    const cPath = join(dir, "program.c");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldPath = process.env["PATH"];
    const oldRealClang = process.env["SCRIPTC_TEST_REAL_CLANG"];
    const realClang = (oldPath ?? "")
      .split(delimiter)
      .map((entry) => join(entry === "" ? process.cwd() : entry, "clang"))
      .find((candidate) => existsSync(candidate));
    expect(realClang).toBeDefined();

    try {
      await mkdir(binDir);
      const wrapper = join(binDir, "clang");
      await writeFile(
        wrapper,
        `#!/bin/sh
if [ "$1" = "--version" ]; then exit 7; fi
exec "$SCRIPTC_TEST_REAL_CLANG" "$@"
`,
      );
      await chmod(wrapper, 0o755);
      await writeFile(cPath, "int main(void) { return 0; }\n");
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      process.env["SCRIPTC_TEST_REAL_CLANG"] = realClang!;
      process.env["PATH"] = `${binDir}${delimiter}${oldPath ?? ""}`;
      delete process.env["SCRIPTC_NO_CACHE"];

      const outPath = join(dir, "out");
      await compileC({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
      expect((await stat(outPath)).isFile()).toBe(true);
      await expect(stat(join(cacheRoot, "bin"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = oldPath;
      if (oldRealClang === undefined) delete process.env["SCRIPTC_TEST_REAL_CLANG"];
      else process.env["SCRIPTC_TEST_REAL_CLANG"] = oldRealClang;
    }
  },
);

test("staged runtime objects survive removal of their cache names and are promoted in the LRU", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-object-stage-"));
  scratch.push(dir);
  const cachedObject = join(dir, "cache", "scr_number.o");
  const source = join(dir, "runtime", "scr_number.c");
  await mkdir(join(dir, "cache"), { recursive: true });
  await writeFile(cachedObject, "cached object bytes");
  const pinnedTime = new Date("2000-01-01T00:00:00.000Z");
  await utimes(cachedObject, pinnedTime, pinnedTime);
  const staged = await stageRuntimeObjects(new Map([[source, cachedObject]]), join(dir, "stage"));
  expect((await stat(cachedObject)).mtimeMs).toBeGreaterThan(pinnedTime.getTime());
  await rm(cachedObject);
  expect(await readFile(staged.get(source)!)).toEqual(Buffer.from("cached object bytes"));
});

test("cache hits honor the current umask", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-environment-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const cPath = join(dir, "program.c");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldUmask = process.umask();

  try {
    await writeFile(cPath, '#include <stdio.h>\nint main(void) { puts("one"); return 0; }\n');
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];

    process.umask(0o022);
    const firstOut = join(dir, "first");
    await compileC({ cPath, outPath: firstOut, cacheIdentity: TEST_CACHE_IDENTITY });
    expect(execFileSync(firstOut, { encoding: "utf8" }).trim()).toBe("one");
    if (process.platform !== "win32") {
      expect((await stat(firstOut)).mode & 0o777).toBe(0o755);
      expect((await stat(cacheRoot)).mode & 0o777).toBe(0o700);
      const [cachedBinary] = await completeArtifacts(cacheRoot, "bin");
      expect((await stat(join(cacheRoot, "bin", cachedBinary!))).mode & 0o777).toBe(0o600);
    }

    // A hit populated under a permissive umask adopts the current restrictive
    // one instead of restoring the cached file's broader mode.
    process.umask(0o077);
    const hitOut = firstOut;
    await compileC({ cPath, outPath: hitOut, cacheIdentity: TEST_CACHE_IDENTITY });
    expect(execFileSync(hitOut, { encoding: "utf8" }).trim()).toBe("one");
    if (process.platform !== "win32") expect((await stat(hitOut)).mode & 0o777).toBe(0o700);
    expect(await completeArtifacts(cacheRoot, "bin")).toHaveLength(1);

    process.umask(0o022);
    const firstArchivePath = join(dir, "first.lib.a");
    await compileLibArchive({ cPath, outPath: firstArchivePath, cacheIdentity: TEST_CACHE_IDENTITY });
    const firstArchive = await readFile(firstArchivePath);
    if (process.platform !== "win32") {
      const [cachedArchive] = await completeArtifacts(cacheRoot, "lib");
      expect((await stat(join(cacheRoot, "lib", cachedArchive!))).mode & 0o777).toBe(0o600);
    }
    process.umask(0o077);
    const hitArchivePath = join(dir, "hit.lib.a");
    await compileLibArchive({ cPath, outPath: hitArchivePath, cacheIdentity: TEST_CACHE_IDENTITY });
    expect(await readFile(hitArchivePath)).toEqual(firstArchive);
    if (process.platform !== "win32") expect((await stat(hitArchivePath)).mode & 0o777).toBe(0o600);
    expect(await completeArtifacts(cacheRoot, "lib")).toHaveLength(1);
  } finally {
    process.umask(oldUmask);
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
  }
});

test.skipIf(process.platform === "win32")(
  "an existing cache override is never made private by mutating its permissions",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-existing-root-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "shared-cache");
    const cPath = join(dir, "program.c");
    const outPath = join(dir, "program");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];

    try {
      await mkdir(cacheRoot);
      await chmod(cacheRoot, 0o755);
      await writeFile(cPath, "int main(void) { return 0; }\n");
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      delete process.env["SCRIPTC_NO_CACHE"];

      await compileC({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
      expect((await stat(outPath)).isFile()).toBe(true);
      expect((await stat(cacheRoot)).mode & 0o777).toBe(0o755);
      await expect(stat(join(cacheRoot, "bin"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "cache installs support destination basenames near NAME_MAX",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-long-output-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const cPath = join(dir, "program.c");
    const executablePath = join(dir, "x".repeat(235));
    const archivePath = join(dir, `${"a".repeat(229)}.lib.a`);
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];

    try {
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      delete process.env["SCRIPTC_NO_CACHE"];
      await writeFile(cPath, "int main(void) { return 0; }\n");

      await compileC({ cPath, outPath: executablePath, cacheIdentity: TEST_CACHE_IDENTITY });
      expect((await stat(executablePath)).isFile()).toBe(true);
      await compileC({ cPath, outPath: executablePath, cacheIdentity: TEST_CACHE_IDENTITY });
      expect((await stat(executablePath)).isFile()).toBe(true);

      await compileLibArchive({ cPath, outPath: archivePath, cacheIdentity: TEST_CACHE_IDENTITY });
      const firstArchive = await readFile(archivePath);
      await compileLibArchive({ cPath, outPath: archivePath, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(await readFile(archivePath)).toEqual(firstArchive);
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    }
  },
);

test("the configured cache maximum is enforced after writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-cap-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const cPath = join(dir, "program.c");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldMax = process.env["SCRIPTC_CACHE_MAX_MB"];
  const capBytes = 0.5 * 1024 * 1024;

  try {
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    process.env["SCRIPTC_CACHE_MAX_MB"] = "0.5";
    delete process.env["SCRIPTC_NO_CACHE"];
    await writeFile(cPath, "int main(void) { return 0; }\n");
    await compileC({
      cPath,
      outPath: join(dir, "out"),
      cacheIdentity: TEST_CACHE_IDENTITY,
    });
    expect(await cacheTreeBytes(cacheRoot)).toBeLessThanOrEqual(capBytes);

    // Long-lived callers write repeatedly through one process. Every write,
    // not only the first or a periodic sample, must leave the tree under cap.
    await writeFile(cPath, "int main(void) { return 1; }\n");
    await compileC({
      cPath,
      outPath: join(dir, "out"),
      cacheIdentity: TEST_CACHE_IDENTITY,
    });
    expect(await cacheTreeBytes(cacheRoot)).toBeLessThanOrEqual(capBytes);
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    if (oldMax === undefined) delete process.env["SCRIPTC_CACHE_MAX_MB"];
    else process.env["SCRIPTC_CACHE_MAX_MB"] = oldMax;
  }
});

test("mutable compiler inputs bypass caches when files change in place", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-ambient-input-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const vendorCacheRoot = join(dir, "vendor-cache");
  const headers = join(dir, "headers");
  const headerPath = join(headers, "cache_probe.h");
  const cPath = join(dir, "program.c");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldCpath = process.env["CPATH"];
  const oldVendorCacheDir = process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];

  try {
    await mkdir(headers);
    await writeFile(
      cPath,
      '#include <stdio.h>\n#include <cache_probe.h>\nint main(void) { puts(CACHE_PROBE); return 0; }\n',
    );
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"] = vendorCacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    process.env["CPATH"] = headers;

    await writeFile(headerPath, '#define CACHE_PROBE "one"\n');
    const firstOut = join(dir, "first");
    await compileC({
      cPath,
      outPath: firstOut,
      cacheIdentity: TEST_CACHE_IDENTITY,
      regex: true,
    });
    expect(execFileSync(firstOut, { encoding: "utf8" }).trim()).toBe("one");

    // The environment spelling is unchanged; only a file behind it moves.
    await writeFile(headerPath, '#define CACHE_PROBE "two"\n');
    const secondOut = join(dir, "second");
    await compileC({
      cPath,
      outPath: secondOut,
      cacheIdentity: TEST_CACHE_IDENTITY,
      regex: true,
    });
    expect(execFileSync(secondOut, { encoding: "utf8" }).trim()).toBe("two");

    const firstArchivePath = join(dir, "first.lib.a");
    await compileLibArchive({ cPath, outPath: firstArchivePath, cacheIdentity: TEST_CACHE_IDENTITY });
    const firstArchive = await readFile(firstArchivePath);
    await writeFile(headerPath, '#define CACHE_PROBE "three"\n');
    const secondArchivePath = join(dir, "second.lib.a");
    await compileLibArchive({ cPath, outPath: secondArchivePath, cacheIdentity: TEST_CACHE_IDENTITY });
    expect(await readFile(secondArchivePath)).not.toEqual(firstArchive);

    // CPATH can mutate behind a stable string, so no cache tier is populated.
    await expect(stat(cacheRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(vendorCacheRoot)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    if (oldCpath === undefined) delete process.env["CPATH"];
    else process.env["CPATH"] = oldCpath;
    if (oldVendorCacheDir === undefined) delete process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
    else process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"] = oldVendorCacheDir;
  }
});

test("the hard disable bypasses vendor prerequisite caches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-no-cache-vendor-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const vendorCacheRoot = join(dir, "vendor-cache");
  const cPath = join(dir, "program.c");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldVendorCacheDir = process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
  const corruption = Buffer.from("scriptc-corrupt-vendor-object\n");

  try {
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"] = vendorCacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    await writeFile(cPath, "int main(void) { return 0; }\n");

    await compileC({
      cPath,
      outPath: join(dir, "populated"),
      cacheIdentity: TEST_CACHE_IDENTITY,
      regex: true,
    });
    const lreCache = (await readdir(vendorCacheRoot)).find((name) => name.includes("-lre-"));
    expect(lreCache).toBeDefined();
    const cachedObject = join(vendorCacheRoot, lreCache!, "libregexp.o");
    await writeFile(cachedObject, corruption);

    process.env["SCRIPTC_NO_CACHE"] = "1";
    await compileC({
      cPath,
      outPath: join(dir, "disabled"),
      cacheIdentity: TEST_CACHE_IDENTITY,
      regex: true,
    });
    await compileLibArchive({
      cPath,
      outPath: join(dir, "disabled.lib.a"),
      cacheIdentity: TEST_CACHE_IDENTITY,
      regex: true,
    });

    // Neither disabled build consulted or repaired the package-local entry;
    // each built its prerequisite in a private, disposable temp root instead.
    expect(await readFile(cachedObject)).toEqual(corruption);
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    if (oldVendorCacheDir === undefined) delete process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
    else process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"] = oldVendorCacheDir;
  }
});

test.skipIf(process.platform === "win32")(
  "shared vendor prerequisites re-key when vendored source bytes change",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-vendor-source-identity-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const fakeRuntimeRoot = join(dir, "runtime");
    const fakeRuntime = join(fakeRuntimeRoot, "src");
    const originalRuntime = runtimeSrcDir();
    const cPath = join(dir, "program.c");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldRuntimeDir = process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"];
    const oldVendorCacheDir = process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];

    try {
      await Promise.all([
        cp(originalRuntime, fakeRuntime, { recursive: true }),
        mkdir(join(fakeRuntimeRoot, "vendor"), { recursive: true }).then(() =>
          Promise.all(["quickjs-ng", "ryu"].map((name) =>
            cp(
              join(originalRuntime, "..", "vendor", name),
              join(fakeRuntimeRoot, "vendor", name),
              { recursive: true },
            )
          ))
        ),
      ]);
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"] = fakeRuntime;
      delete process.env["SCRIPTC_NO_CACHE"];
      delete process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
      await writeFile(cPath, "int main(void) { return 0; }\n");

      await compileC({
        cPath,
        outPath: join(dir, "first"),
        cacheIdentity: TEST_CACHE_IDENTITY,
        regex: true,
      });
      const vendorRoot = join(cacheRoot, "vendor");
      expect((await readdir(vendorRoot)).filter((name) => name.includes("-lre-"))).toHaveLength(1);

      const libregexp = join(fakeRuntimeRoot, "vendor", "quickjs-ng", "libregexp.c");
      await writeFile(libregexp, `${await readFile(libregexp, "utf8")}\n/* cache identity probe */\n`);
      await writeFile(cPath, "int main(void) { return 0; } /* second */\n");
      await compileC({
        cPath,
        outPath: join(dir, "second"),
        cacheIdentity: TEST_CACHE_IDENTITY,
        regex: true,
      });
      expect((await readdir(vendorRoot)).filter((name) => name.includes("-lre-"))).toHaveLength(2);
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldRuntimeDir === undefined) delete process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"];
      else process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"] = oldRuntimeDir;
      if (oldVendorCacheDir === undefined) delete process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
      else process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"] = oldVendorCacheDir;
    }
  },
  120_000,
);

test.skipIf(process.platform === "win32")(
  "uncached arbitrary C keeps vendor prerequisites outside a read-only runtime package",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-readonly-runtime-"));
    scratch.push(dir);
    const fakeRuntimeRoot = join(dir, "runtime");
    const fakeRuntime = join(fakeRuntimeRoot, "src");
    const fakeVendor = join(fakeRuntimeRoot, "vendor");
    const originalRuntime = runtimeSrcDir();
    const cPath = join(dir, "program.c");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldRuntimeDir = process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"];
    const oldVendorCacheDir = process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];

    try {
      await Promise.all([
        cp(originalRuntime, fakeRuntime, { recursive: true }),
        mkdir(fakeVendor, { recursive: true }).then(() =>
          Promise.all(["quickjs-ng", "ryu"].map((name) =>
            cp(join(originalRuntime, "..", "vendor", name), join(fakeVendor, name), {
              recursive: true,
            })
          ))
        ),
      ]);
      process.env["SCRIPTC_CACHE_DIR"] = join(dir, "cache");
      process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"] = fakeRuntime;
      delete process.env["SCRIPTC_NO_CACHE"];
      delete process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
      await writeFile(cPath, "int main(void) { return 0; }\n");
      await chmod(fakeVendor, 0o555);

      const outPath = join(dir, "program");
      await compileC({ cPath, outPath, regex: true });
      expect((await stat(outPath)).isFile()).toBe(true);
      await expect(stat(join(fakeVendor, ".cache"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(fakeVendor, 0o755).catch(() => undefined);
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldRuntimeDir === undefined) delete process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"];
      else process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"] = oldRuntimeDir;
      if (oldVendorCacheDir === undefined) delete process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
      else process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"] = oldVendorCacheDir;
    }
  },
  120_000,
);

test("native cache warming seeds exact runtime and vendor families without complete binaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-warm-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const vendorCacheRoot = join(cacheRoot, "vendor");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldVendorCacheDir = process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
  try {
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
    delete process.env["SCRIPTC_NO_CACHE"];
    const warmed = await warmNativeCaches({ profiles: ["runtime", "tls", "dynamic"] });
    expect(warmed.cacheRoot).toBe(cacheRoot);
    expect(warmed.profiles.map(({ profile }) => profile)).toEqual(["runtime", "tls", "dynamic"]);
    expect(warmed.profiles.every(({ elapsedMs }) => elapsedMs >= 0)).toBe(true);
    expect((await readdir(join(cacheRoot, "obj"), { withFileTypes: true })).filter((e) => e.isDirectory())).toHaveLength(3);
    expect(await readdir(join(cacheRoot, "bin")).catch(() => [])).toEqual([]);
    const vendorEntries = await readdir(vendorCacheRoot);
    const tlsEntry = vendorEntries.find((name) => name.startsWith("mbedtls-"));
    const engineEntry = vendorEntries.find((name) => /^3c8f3d689539-plain-/.test(name));
    expect(tlsEntry).toBeDefined();
    expect(engineEntry).toBeDefined();
    expect((await stat(join(vendorCacheRoot, tlsEntry!, "libmbedtls.a.sha256"))).isFile()).toBe(true);
    expect((await stat(join(vendorCacheRoot, engineEntry!, "libqjs.a.sha256"))).isFile()).toBe(true);
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    if (oldVendorCacheDir === undefined) delete process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
    else process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"] = oldVendorCacheDir;
  }
}, 120_000);

test("damaged shared vendor archives are rejected and rebuilt before linking", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-vendor-integrity-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const cPath = join(dir, "program.c");
  const outPath = join(dir, "program");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldVendorCacheDir = process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
  const corruption = Buffer.from("scriptc-corrupt-vendor-archive\n");
  try {
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    delete process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
    await writeFile(cPath, "int main(void) { return 0; }\n");
    await warmNativeCaches({ profiles: ["dynamic"] });

    const vendorRoot = join(cacheRoot, "vendor");
    const engineDir = (await readdir(vendorRoot)).find((name) =>
      /^3c8f3d689539-plain-/.test(name)
    );
    expect(engineDir).toBeDefined();
    const engineArchive = join(vendorRoot, engineDir!, "libqjs.a");
    expect((await stat(`${engineArchive}.sha256`)).isFile()).toBe(true);
    await writeFile(engineArchive, corruption);

    await compileC({
      cPath,
      outPath,
      cacheIdentity: TEST_CACHE_IDENTITY,
      dynamic: true,
    });

    expect((await stat(outPath)).isFile()).toBe(true);
    const repaired = await readFile(engineArchive);
    expect(repaired).not.toEqual(corruption);
    expect((await readFile(`${engineArchive}.sha256`, "utf8")).trim()).toBe(
      createHash("sha256").update(repaired).digest("hex"),
    );
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    if (oldVendorCacheDir === undefined) delete process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
    else process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"] = oldVendorCacheDir;
  }
}, 120_000);

test("dynamic builds promote staged vendor archives before bounded LRU eviction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-vendor-lru-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const cPath = join(dir, "program.c");
  const outPath = join(dir, "program");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldMax = process.env["SCRIPTC_CACHE_MAX_MB"];
  const oldVendorCacheDir = process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
  try {
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    delete process.env["SCRIPTC_CACHE_MAX_MB"];
    delete process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
    await writeFile(cPath, "int main(void) { return 0; }\n");
    await warmNativeCaches({ profiles: ["dynamic"] });

    const vendorRoot = join(cacheRoot, "vendor");
    const engineDir = (await readdir(vendorRoot)).find((name) =>
      /^3c8f3d689539-plain-/.test(name)
    );
    expect(engineDir).toBeDefined();
    const engineArchive = join(vendorRoot, engineDir!, "libqjs.a");
    const initialBytes = await cacheTreeBytes(cacheRoot);
    const capMb = Math.max(4, Math.ceil(initialBytes * 2 / (1024 * 1024)));
    const filler = join(cacheRoot, "filler.bin");
    const staleArchiveTime = new Date("2000-01-01T00:00:00.000Z");
    const fillerTime = new Date("2001-01-01T00:00:00.000Z");
    await writeFile(filler, Buffer.alloc(capMb * 1024 * 1024));
    await utimes(engineArchive, staleArchiveTime, staleArchiveTime);
    await utimes(filler, fillerTime, fillerTime);
    process.env["SCRIPTC_CACHE_MAX_MB"] = String(capMb);

    await compileC({
      cPath,
      outPath,
      cacheIdentity: TEST_CACHE_IDENTITY,
      dynamic: true,
    });

    expect((await stat(outPath)).isFile()).toBe(true);
    expect((await stat(engineArchive)).mtimeMs).toBeGreaterThan(fillerTime.getTime());
    expect(await cacheTreeBytes(cacheRoot)).toBeLessThanOrEqual(capMb * 1024 * 1024);
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    if (oldMax === undefined) delete process.env["SCRIPTC_CACHE_MAX_MB"];
    else process.env["SCRIPTC_CACHE_MAX_MB"] = oldMax;
    if (oldVendorCacheDir === undefined) delete process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
    else process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"] = oldVendorCacheDir;
  }
}, 120_000);

test("native cache warming follows the hard cache disable", async () => {
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  try {
    process.env["SCRIPTC_NO_CACHE"] = "1";
    await expect(warmNativeCaches({ profiles: ["runtime"] })).rejects.toThrow(
      "native build cache is disabled",
    );
  } finally {
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
  }
});

test("native cache warming refuses environments that disable persistent objects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-warm-disabled-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldCpath = process.env["CPATH"];
  try {
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    process.env["CPATH"] = dir;
    await expect(warmNativeCaches({ profiles: ["runtime"] })).rejects.toThrow(
      "requires a persistently cacheable compiler environment",
    );
    expect(await readdir(cacheRoot)).toEqual([]);
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldCpath === undefined) delete process.env["CPATH"];
    else process.env["CPATH"] = oldCpath;
  }
});

test("native cache warm profiles follow target capabilities", () => {
  expect(supportedNativeCacheWarmProfiles({
    argv: ["zig", "cc"],
    target: "wasm32-wasi",
    zigTarget: "wasm32-wasi",
    targetArgs: [],
    linkArgs: [],
  })).toEqual([]);
  expect(supportedNativeCacheWarmProfiles({
    argv: ["zig", "cc"],
    target: "aarch64-apple-ios",
    zigTarget: "aarch64-ios.15.0",
    targetArgs: [],
    linkArgs: [],
  })).toEqual([]);
});

test("parallel native cache warming fails cleanly when the bounded cache cannot retain its profiles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-warm-cap-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldMax = process.env["SCRIPTC_CACHE_MAX_MB"];
  try {
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    process.env["SCRIPTC_CACHE_MAX_MB"] = "2.5";
    await expect(warmNativeCaches()).rejects.toThrow(
      "SCRIPTC_CACHE_MAX_MB is too small to retain the requested native cache warm profiles",
    );
    expect(await readdir(cacheRoot)).not.toEqual([]);
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldMax === undefined) delete process.env["SCRIPTC_CACHE_MAX_MB"];
    else process.env["SCRIPTC_CACHE_MAX_MB"] = oldMax;
  }
}, 120_000);

test.skipIf(process.platform !== "darwin")(
  "vendor object caches separate deployment-target environments",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-vendor-environment-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const vendorCacheRoot = join(dir, "vendor-cache");
    const cPath = join(dir, "program.c");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldVendorCacheDir = process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
    const oldDeploymentTarget = process.env["MACOSX_DEPLOYMENT_TARGET"];

    try {
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"] = vendorCacheRoot;
      delete process.env["SCRIPTC_NO_CACHE"];
      await writeFile(cPath, "int main(void) { return 0; }\n");

      process.env["MACOSX_DEPLOYMENT_TARGET"] = "14.0";
      await compileC({
        cPath,
        outPath: join(dir, "newer"),
        cacheIdentity: TEST_CACHE_IDENTITY,
        regex: true,
      });
      process.env["MACOSX_DEPLOYMENT_TARGET"] = "11.0";
      await compileC({
        cPath,
        outPath: join(dir, "older"),
        cacheIdentity: TEST_CACHE_IDENTITY,
        regex: true,
      });

      const lreCaches = (await readdir(vendorCacheRoot)).filter((name) => name.includes("-lre-"));
      expect(lreCaches).toHaveLength(2);
      const minVersions = lreCaches.map((cache) =>
        execFileSync("vtool", ["-show-build", join(vendorCacheRoot, cache, "libregexp.o")], {
          encoding: "utf8",
        }).match(/minos\s+(\S+)/)?.[1],
      );
      expect(new Set(minVersions)).toEqual(new Set(["11.0", "14.0"]));
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldVendorCacheDir === undefined) delete process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
      else process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"] = oldVendorCacheDir;
      if (oldDeploymentTarget === undefined) delete process.env["MACOSX_DEPLOYMENT_TARGET"];
      else process.env["MACOSX_DEPLOYMENT_TARGET"] = oldDeploymentTarget;
    }
  },
);

test("complete binary hits precede missing vendor prerequisite materialization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-vendor-hit-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const vendorCacheRoot = join(dir, "vendor-cache");
  const cPath = join(dir, "program.c");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldVendorCacheDir = process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];

  try {
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"] = vendorCacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    await writeFile(cPath, '#include <stdio.h>\nint main(void) { puts("cached"); return 0; }\n');

    const firstOut = join(dir, "first");
    await compileC({
      cPath,
      outPath: firstOut,
      cacheIdentity: TEST_CACHE_IDENTITY,
      regex: true,
    });
    expect(execFileSync(firstOut, { encoding: "utf8" }).trim()).toBe("cached");
    expect(await completeArtifacts(cacheRoot, "bin")).toHaveLength(1);
    expect((await stat(vendorCacheRoot)).isDirectory()).toBe(true);

    // Simulate a package reinstall: the per-package vendor build disappears,
    // while the per-user complete executable remains. The hit must not
    // recreate that directory even though the compiler remains available for
    // fresh dependency discovery.
    await rm(vendorCacheRoot, { recursive: true, force: true });
    const hitOut = firstOut;
    await compileC({
      cPath,
      outPath: hitOut,
      cacheIdentity: TEST_CACHE_IDENTITY,
      regex: true,
    });
    expect(execFileSync(hitOut, { encoding: "utf8" }).trim()).toBe("cached");
    await expect(stat(vendorCacheRoot)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    if (oldVendorCacheDir === undefined) delete process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
    else process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"] = oldVendorCacheDir;
  }
});

test("arbitrary C bypasses persistent artifacts so same-path header edits cannot go stale", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-arbitrary-c-cache-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const cPath = join(dir, "program.c");
  const headerPath = join(dir, "value.h");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];

  try {
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    await writeFile(
      cPath,
      '#include <stdio.h>\n#include "value.h"\nint main(void) { puts(VALUE); return 0; }\n',
    );
    await writeFile(headerPath, '#define VALUE "one"\n');
    const firstOut = join(dir, "first");
    await compileC({ cPath, outPath: firstOut });
    expect(execFileSync(firstOut, { encoding: "utf8" }).trim()).toBe("one");

    await writeFile(headerPath, '#define VALUE "two"\n');
    const secondOut = join(dir, "second");
    await compileC({ cPath, outPath: secondOut });
    expect(execFileSync(secondOut, { encoding: "utf8" }).trim()).toBe("two");
    await expect(stat(join(cacheRoot, "bin"))).rejects.toMatchObject({ code: "ENOENT" });

    const archiveOut = join(dir, "program.lib.a");
    await compileLibArchive({ cPath, outPath: archiveOut });
    expect((await stat(archiveOut)).isFile()).toBe(true);
    await expect(stat(join(cacheRoot, "lib"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
  }
});

test("cached translation units keep the compiler-visible source path in their identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-source-path-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const aPath = join(dir, "a.c");
  const bPath = join(dir, "b.c");
  const headerPath = join(dir, "cache_path_header.h");
  const source =
    '#include <stdio.h>\n#include "cache_path_header.h"\nint main(void) { puts(__FILE__); puts(CACHE_PATH_HEADER); return 0; }\n';
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];

  try {
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    await Promise.all([
      writeFile(aPath, source),
      writeFile(bPath, source),
      writeFile(headerPath, '#define CACHE_PATH_HEADER "header"\n'),
    ]);
    const aOut = join(dir, "a-out", "program");
    const bOut = join(dir, "b-out", "program");
    await Promise.all([mkdir(join(dir, "a-out")), mkdir(join(dir, "b-out"))]);
    await compileC({ cPath: aPath, outPath: aOut, cacheIdentity: TEST_CACHE_IDENTITY });
    await compileC({ cPath: bPath, outPath: bOut, cacheIdentity: TEST_CACHE_IDENTITY });
    expect(execFileSync(aOut, { encoding: "utf8" }).trim()).toBe(`${aPath}\nheader`);
    expect(execFileSync(bOut, { encoding: "utf8" }).trim()).toBe(`${bPath}\nheader`);
    expect(await completeArtifacts(cacheRoot, "bin")).toHaveLength(2);
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
  }
});

test.skipIf(process.platform === "win32")(
  "cache publication compiles the exact translation-unit bytes used by its key",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-tu-race-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const binDir = join(dir, "bin");
    const cPath = join(dir, "program.c");
    const signal = join(dir, "compile-started");
    const release = join(dir, "compile-release");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldPath = process.env["PATH"];
    const oldRealClang = process.env["SCRIPTC_TEST_REAL_CLANG"];
    const oldRaceSource = process.env["SCRIPTC_TEST_RACE_SOURCE"];
    const oldRaceSignal = process.env["SCRIPTC_TEST_RACE_SIGNAL"];
    const oldRaceRelease = process.env["SCRIPTC_TEST_RACE_RELEASE"];
    const originalClang = (oldPath ?? "")
      .split(delimiter)
      .map((entry) => join(entry === "" ? process.cwd() : entry, "clang"))
      .find((candidate) => existsSync(candidate));
    expect(originalClang).toBeDefined();

    const source = (value: string): string =>
      `#include <stdio.h>\nint main(void) { puts("${value}"); return 0; }\n`;
    const waitForSignal = async (): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (!existsSync(signal)) {
        if (Date.now() > deadline) throw new Error("timed out waiting for the compiler wrapper");
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    };

    try {
      await mkdir(binDir);
      const wrapper = join(binDir, "clang");
      await writeFile(
        wrapper,
        `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    "$SCRIPTC_TEST_RACE_SOURCE"|"-ffile-prefix-map="*"$SCRIPTC_TEST_RACE_SOURCE")
      : > "$SCRIPTC_TEST_RACE_SIGNAL"
      while [ ! -e "$SCRIPTC_TEST_RACE_RELEASE" ]; do sleep 0.01; done
      break
      ;;
  esac
done
exec "$SCRIPTC_TEST_REAL_CLANG" "$@"
`,
      );
      // ccache availability is memoized across this file. If an earlier test
      // found it, keep the controlled compiler wrapper in the path by making
      // a cache shim that simply forwards its compiler argv.
      const ccacheWrapper = join(binDir, "ccache");
      await writeFile(
        ccacheWrapper,
        `#!/bin/sh
if [ "$1" = "--version" ]; then exit 1; fi
exec "$@"
`,
      );
      await Promise.all([chmod(wrapper, 0o755), chmod(ccacheWrapper, 0o755)]);
      await writeFile(cPath, source("one"));
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      process.env["SCRIPTC_TEST_REAL_CLANG"] = originalClang!;
      process.env["SCRIPTC_TEST_RACE_SOURCE"] = cPath;
      process.env["SCRIPTC_TEST_RACE_SIGNAL"] = signal;
      process.env["SCRIPTC_TEST_RACE_RELEASE"] = release;
      process.env["PATH"] = `${binDir}${delimiter}${oldPath ?? ""}`;
      trustInstrumentedCompilerWrapper();
      delete process.env["SCRIPTC_NO_CACHE"];

      const firstOut = join(dir, "first");
      const firstBuild = compileC({
        cPath,
        outPath: firstOut,
        cacheIdentity: TEST_CACHE_IDENTITY,
      });
      await Promise.race([
        waitForSignal(),
        firstBuild.then(() => {
          throw new Error("compile completed without reaching the race barrier");
        }),
      ]);
      // The caller-visible generated path changes after its bytes have joined
      // the key but before clang is allowed to read its input.
      await writeFile(cPath, source("two"));
      await writeFile(release, "go");
      await firstBuild;
      expect(execFileSync(firstOut, { encoding: "utf8" }).trim()).toBe("one");

      const secondOut = join(dir, "second");
      await compileC({ cPath, outPath: secondOut, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(secondOut, { encoding: "utf8" }).trim()).toBe("two");

      await writeFile(cPath, source("one"));
      const hitOut = firstOut;
      await compileC({ cPath, outPath: hitOut, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(hitOut, { encoding: "utf8" }).trim()).toBe("one");
      expect(await completeArtifacts(cacheRoot, "bin")).toHaveLength(2);

      await Promise.all([rm(signal, { force: true }), rm(release, { force: true })]);
      const libPath = join(dir, "library.c");
      const libOne = "const char *scriptc_cache_race_value = \"lib-race-one-unique\";\n";
      const libTwo = "const char *scriptc_cache_race_value = \"lib-race-two-unique\";\n";
      process.env["SCRIPTC_TEST_RACE_SOURCE"] = libPath;
      await writeFile(libPath, libOne);
      const firstArchivePath = join(dir, "first.lib.a");
      const firstArchiveBuild = compileLibArchive({
        cPath: libPath,
        outPath: firstArchivePath,
        cacheIdentity: TEST_CACHE_IDENTITY,
      });
      await Promise.race([
        waitForSignal(),
        firstArchiveBuild.then(() => {
          throw new Error("archive compile completed without reaching the race barrier");
        }),
      ]);
      await writeFile(libPath, libTwo);
      await writeFile(release, "go");
      await firstArchiveBuild;
      const firstArchive = await readFile(firstArchivePath);
      expect(firstArchive.includes(Buffer.from("lib-race-one-unique"))).toBe(true);
      expect(firstArchive.includes(Buffer.from("lib-race-two-unique"))).toBe(false);

      await writeFile(libPath, libOne);
      const hitArchivePath = join(dir, "hit.lib.a");
      await compileLibArchive({
        cPath: libPath,
        outPath: hitArchivePath,
        cacheIdentity: TEST_CACHE_IDENTITY,
      });
      expect(await readFile(hitArchivePath)).toEqual(firstArchive);
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = oldPath;
      if (oldRealClang === undefined) delete process.env["SCRIPTC_TEST_REAL_CLANG"];
      else process.env["SCRIPTC_TEST_REAL_CLANG"] = oldRealClang;
      if (oldRaceSource === undefined) delete process.env["SCRIPTC_TEST_RACE_SOURCE"];
      else process.env["SCRIPTC_TEST_RACE_SOURCE"] = oldRaceSource;
      if (oldRaceSignal === undefined) delete process.env["SCRIPTC_TEST_RACE_SIGNAL"];
      else process.env["SCRIPTC_TEST_RACE_SIGNAL"] = oldRaceSignal;
      if (oldRaceRelease === undefined) delete process.env["SCRIPTC_TEST_RACE_RELEASE"];
      else process.env["SCRIPTC_TEST_RACE_RELEASE"] = oldRaceRelease;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "implicit headers changed during the final compile cannot poison the old key",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-final-header-race-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const binDir = join(dir, "bin");
    const header = join(dir, "implicit-race.h");
    const cPath = join(dir, "program.c");
    const signal = join(dir, "final-compile-started");
    const release = join(dir, "final-compile-release");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldDisableCcache = process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
    const oldPath = process.env["PATH"];
    const oldRealClang = process.env["SCRIPTC_TEST_REAL_CLANG"];
    const oldImplicitHeader = process.env["SCRIPTC_TEST_IMPLICIT_HEADER"];
    const oldRaceSignal = process.env["SCRIPTC_TEST_FINAL_RACE_SIGNAL"];
    const oldRaceRelease = process.env["SCRIPTC_TEST_FINAL_RACE_RELEASE"];
    const realClang = (oldPath ?? "")
      .split(delimiter)
      .map((entry) => join(entry === "" ? process.cwd() : entry, "clang"))
      .find((candidate) => existsSync(candidate));
    expect(realClang).toBeDefined();

    const waitForSignal = async (): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (!existsSync(signal)) {
        if (Date.now() > deadline) throw new Error("timed out waiting for final compilation");
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    };

    try {
      await mkdir(binDir);
      const wrapper = join(binDir, "clang");
      await writeFile(
        wrapper,
        `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    */scriptc-cache-build-*/program.c|*/scriptc-cache-build-*/program.ll)
      if [ ! -e "$SCRIPTC_TEST_FINAL_RACE_SIGNAL" ]; then
        : > "$SCRIPTC_TEST_FINAL_RACE_SIGNAL"
        while [ ! -e "$SCRIPTC_TEST_FINAL_RACE_RELEASE" ]; do sleep 0.01; done
      fi
      break
      ;;
  esac
done
exec "$SCRIPTC_TEST_REAL_CLANG" -include "$SCRIPTC_TEST_IMPLICIT_HEADER" "$@"
`,
      );
      await chmod(wrapper, 0o755);
      await writeFile(
        cPath,
        '#include <stdio.h>\nint main(void) { puts(SCRIPTC_IMPLICIT_RACE); return 0; }\n',
      );
      await writeFile(header, '#define SCRIPTC_IMPLICIT_RACE "one"\n');
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = "1";
      process.env["SCRIPTC_TEST_REAL_CLANG"] = realClang!;
      process.env["SCRIPTC_TEST_IMPLICIT_HEADER"] = header;
      process.env["SCRIPTC_TEST_FINAL_RACE_SIGNAL"] = signal;
      process.env["SCRIPTC_TEST_FINAL_RACE_RELEASE"] = release;
      process.env["PATH"] = `${binDir}${delimiter}${oldPath ?? ""}`;
      trustInstrumentedCompilerWrapper();
      delete process.env["SCRIPTC_NO_CACHE"];

      const firstOut = join(dir, "first");
      const firstBuild = compileC({
        cPath,
        outPath: firstOut,
        cacheIdentity: TEST_CACHE_IDENTITY,
      });
      await Promise.race([
        waitForSignal(),
        firstBuild.then(() => {
          throw new Error("compile completed without reaching the final-build barrier");
        }),
      ]);
      await writeFile(header, '#define SCRIPTC_IMPLICIT_RACE "two"\n');
      await writeFile(release, "go");
      await firstBuild;
      expect(execFileSync(firstOut, { encoding: "utf8" }).trim()).toBe("two");

      // The first executable was compiled from `two` after its key captured
      // `one`, so it must not be published. Restoring `one` must rebuild it.
      await writeFile(header, '#define SCRIPTC_IMPLICIT_RACE "one"\n');
      const secondOut = join(dir, "second");
      await compileC({ cPath, outPath: secondOut, cacheIdentity: TEST_CACHE_IDENTITY });
      expect(execFileSync(secondOut, { encoding: "utf8" }).trim()).toBe("one");
      expect(await completeArtifacts(cacheRoot, "bin")).toHaveLength(1);
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldDisableCcache === undefined) delete process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
      else process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = oldDisableCcache;
      if (oldPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = oldPath;
      if (oldRealClang === undefined) delete process.env["SCRIPTC_TEST_REAL_CLANG"];
      else process.env["SCRIPTC_TEST_REAL_CLANG"] = oldRealClang;
      if (oldImplicitHeader === undefined) delete process.env["SCRIPTC_TEST_IMPLICIT_HEADER"];
      else process.env["SCRIPTC_TEST_IMPLICIT_HEADER"] = oldImplicitHeader;
      if (oldRaceSignal === undefined) delete process.env["SCRIPTC_TEST_FINAL_RACE_SIGNAL"];
      else process.env["SCRIPTC_TEST_FINAL_RACE_SIGNAL"] = oldRaceSignal;
      if (oldRaceRelease === undefined) delete process.env["SCRIPTC_TEST_FINAL_RACE_RELEASE"];
      else process.env["SCRIPTC_TEST_FINAL_RACE_RELEASE"] = oldRaceRelease;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "runtime edits during object compilation cannot poison the old fingerprint",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-runtime-cache-race-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const fakeRuntime = join(dir, "runtime", "src");
    const originalRuntime = runtimeSrcDir();
    await Promise.all([
      cp(originalRuntime, fakeRuntime, { recursive: true }),
      mkdir(join(dir, "runtime", "vendor"), { recursive: true }).then(() =>
        cp(join(originalRuntime, "..", "vendor", "ryu"), join(dir, "runtime", "vendor", "ryu"), {
          recursive: true,
        }),
      ),
    ]);

    const binDir = join(dir, "bin");
    const cPath = join(dir, "program.c");
    const raceSource = join(fakeRuntime, "scr_number.c");
    const signal = join(dir, "runtime-compile-started");
    const release = join(dir, "runtime-compile-release");
    const marker = "scriptc-runtime-race-marker-unique";
    const originalRuntimeSource = await readFile(raceSource, "utf8");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldRuntimeDir = process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"];
    const oldDisableCcache = process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
    const oldPath = process.env["PATH"];
    const oldRealClang = process.env["SCRIPTC_TEST_REAL_CLANG"];
    const oldRaceSource = process.env["SCRIPTC_TEST_RUNTIME_RACE_SOURCE"];
    const oldRaceSignal = process.env["SCRIPTC_TEST_RUNTIME_RACE_SIGNAL"];
    const oldRaceRelease = process.env["SCRIPTC_TEST_RUNTIME_RACE_RELEASE"];
    const realClang = (oldPath ?? "")
      .split(delimiter)
      .map((entry) => join(entry === "" ? process.cwd() : entry, "clang"))
      .find((candidate) => existsSync(candidate));
    expect(realClang).toBeDefined();

    try {
      await mkdir(binDir);
      const wrapper = join(binDir, "clang");
      await writeFile(
        wrapper,
        `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "$SCRIPTC_TEST_RUNTIME_RACE_SOURCE" ]; then
    : > "$SCRIPTC_TEST_RUNTIME_RACE_SIGNAL"
    while [ ! -e "$SCRIPTC_TEST_RUNTIME_RACE_RELEASE" ]; do sleep 0.01; done
    break
  fi
done
exec "$SCRIPTC_TEST_REAL_CLANG" "$@"
`,
      );
      await chmod(wrapper, 0o755);
      await writeFile(cPath, "int main(void) { return 0; }\n");
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"] = fakeRuntime;
      process.env["SCRIPTC_TEST_REAL_CLANG"] = realClang!;
      process.env["SCRIPTC_TEST_RUNTIME_RACE_SOURCE"] = raceSource;
      process.env["SCRIPTC_TEST_RUNTIME_RACE_SIGNAL"] = signal;
      process.env["SCRIPTC_TEST_RUNTIME_RACE_RELEASE"] = release;
      // Keep ccache out of this controlled race: its own object store is not
      // the cache under test and can obscure which compiler read happened.
      process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = "1";
      process.env["PATH"] = `${binDir}${delimiter}/usr/bin${delimiter}/bin`;
      trustInstrumentedCompilerWrapper();
      delete process.env["SCRIPTC_NO_CACHE"];

      const firstOut = join(dir, "first");
      const firstBuild = compileC({
        cPath,
        outPath: firstOut,
        cacheIdentity: TEST_CACHE_IDENTITY,
      });
      const deadline = Date.now() + 10_000;
      while (!existsSync(signal)) {
        if (Date.now() > deadline) throw new Error("timed out waiting for runtime compile");
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      await writeFile(
        raceSource,
        `${originalRuntimeSource}\nconst char scriptc_runtime_race_marker[] = "${marker}";\n`,
      );
      await writeFile(release, "go");
      await firstBuild;
      expect((await readFile(firstOut)).includes(Buffer.from(marker))).toBe(true);

      // Restore the fingerprint, then force a program-cache miss. The old
      // fingerprint must not have retained the object built from edited bytes.
      await writeFile(raceSource, originalRuntimeSource);
      await writeFile(cPath, "int main(void) { return 0; } /* second */\n");
      const secondOut = join(dir, "second");
      await compileC({
        cPath,
        outPath: secondOut,
        cacheIdentity: TEST_CACHE_IDENTITY,
      });
      expect((await readFile(secondOut)).includes(Buffer.from(marker))).toBe(false);
      expect(await completeArtifacts(cacheRoot, "bin")).toHaveLength(1);
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldRuntimeDir === undefined) delete process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"];
      else process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"] = oldRuntimeDir;
      if (oldDisableCcache === undefined) delete process.env["SCRIPTC_TEST_DISABLE_CCACHE"];
      else process.env["SCRIPTC_TEST_DISABLE_CCACHE"] = oldDisableCcache;
      if (oldPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = oldPath;
      if (oldRealClang === undefined) delete process.env["SCRIPTC_TEST_REAL_CLANG"];
      else process.env["SCRIPTC_TEST_REAL_CLANG"] = oldRealClang;
      if (oldRaceSource === undefined) delete process.env["SCRIPTC_TEST_RUNTIME_RACE_SOURCE"];
      else process.env["SCRIPTC_TEST_RUNTIME_RACE_SOURCE"] = oldRaceSource;
      if (oldRaceSignal === undefined) delete process.env["SCRIPTC_TEST_RUNTIME_RACE_SIGNAL"];
      else process.env["SCRIPTC_TEST_RUNTIME_RACE_SIGNAL"] = oldRaceSignal;
      if (oldRaceRelease === undefined) delete process.env["SCRIPTC_TEST_RUNTIME_RACE_RELEASE"];
      else process.env["SCRIPTC_TEST_RUNTIME_RACE_RELEASE"] = oldRaceRelease;
    }
  },
);

test("explicit native link inputs relink while runtime objects remain cached", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-link-input-cache-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const cPath = join(dir, "program.c");
  const nativeSource = join(dir, "probe.c");
  const nativeObject = join(dir, "probe.o");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];

  const rebuildObject = async (value: number): Promise<void> => {
    await writeFile(nativeSource, `int scriptc_cache_probe(void) { return ${value}; }\n`);
    execFileSync("clang", ["-c", nativeSource, "-o", nativeObject]);
  };

  try {
    await writeFile(
      cPath,
      '#include <stdio.h>\nextern int scriptc_cache_probe(void);\nint main(void) { printf("%d\\n", scriptc_cache_probe()); return 0; }\n',
    );
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];

    await rebuildObject(1);
    const firstOut = join(dir, "first");
    await compileC({
      cPath,
      outPath: firstOut,
      cacheIdentity: TEST_CACHE_IDENTITY,
      linkInputs: [nativeObject],
    });
    expect(execFileSync(firstOut, { encoding: "utf8" }).trim()).toBe("1");

    await rebuildObject(2);
    const secondOut = join(dir, "second");
    await compileC({
      cPath,
      outPath: secondOut,
      cacheIdentity: TEST_CACHE_IDENTITY,
      linkInputs: [nativeObject],
    });
    expect(execFileSync(secondOut, { encoding: "utf8" }).trim()).toBe("2");

    // A path may name a thin archive or linker script whose own bytes do not
    // cover its dependencies, so every native-input build performs this link.
    await expect(stat(join(cacheRoot, "bin"))).rejects.toMatchObject({ code: "ENOENT" });
    const objectSets = await readdir(join(cacheRoot, "obj"), { withFileTypes: true });
    expect(objectSets.some((entry) => entry.isDirectory() && !entry.name.startsWith("build-"))).toBe(true);
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
  }
});

test("system libraries relink after an in-place rebuild while runtime objects remain cached", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-system-library-cache-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const libDir = join(dir, "lib");
  const cPath = join(dir, "program.c");
  const libSource = join(dir, "probe.c");
  const libObject = join(dir, "probe.o");
  const library = join(libDir, "libscriptc_cache_probe.a");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldLibraryPath = process.env["LIBRARY_PATH"];

  const rebuildLibrary = async (value: number): Promise<void> => {
    await writeFile(libSource, `int scriptc_cache_probe(void) { return ${value}; }\n`);
    execFileSync("clang", ["-c", libSource, "-o", libObject]);
    execFileSync("ar", ["rcs", library, libObject]);
  };

  try {
    await mkdir(libDir);
    await writeFile(
      cPath,
      '#include <stdio.h>\nextern int scriptc_cache_probe(void);\nint main(void) { printf("%d\\n", scriptc_cache_probe()); return 0; }\n',
    );
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    process.env["LIBRARY_PATH"] = libDir;

    await rebuildLibrary(1);
    const firstOut = join(dir, "first");
    await compileC({
      cPath,
      outPath: firstOut,
      cacheIdentity: TEST_CACHE_IDENTITY,
      systemLibraries: ["scriptc_cache_probe"],
    });
    expect(execFileSync(firstOut, { encoding: "utf8" }).trim()).toBe("1");

    await rebuildLibrary(2);
    const secondOut = join(dir, "second");
    await compileC({
      cPath,
      outPath: secondOut,
      cacheIdentity: TEST_CACHE_IDENTITY,
      systemLibraries: ["scriptc_cache_probe"],
    });
    expect(execFileSync(secondOut, { encoding: "utf8" }).trim()).toBe("2");

    // The ambient library prevents a stale complete-binary hit, but the safe
    // runtime-object half of the persistent cache remains active.
    await expect(stat(join(cacheRoot, "bin"))).rejects.toMatchObject({ code: "ENOENT" });
    const objectSets = await readdir(join(cacheRoot, "obj"), { withFileTypes: true });
    expect(objectSets.some((entry) => entry.isDirectory() && !entry.name.startsWith("build-"))).toBe(true);
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    if (oldLibraryPath === undefined) delete process.env["LIBRARY_PATH"];
    else process.env["LIBRARY_PATH"] = oldLibraryPath;
  }
});

test("frontend-generated same-output builds no-op only while output and dependency stamp are valid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-local-artifact-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const cPath = join(dir, "program.c");
  const outPath = join(dir, "program");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldUmask = process.umask();

  try {
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    await writeFile(cPath, '#include <stdio.h>\nint main(void) { puts("valid"); return 0; }\n');

    await compileC({ cPath, outPath, cacheIdentity: "scriptc-generated-v1" });
    const stampPath = join(
      cacheRoot,
      "local",
      createHash("sha256").update(outPath).digest("hex"),
    );
    const stamp = JSON.parse(await readFile(stampPath, "utf8")) as {
      dependencies: { path: string; kind: "file" | "directory"; size: number; mtimeMs: number; ctimeMs: number }[];
      integrity: string;
    };
    expect(stamp.dependencies.length).toBeGreaterThan(0);

    const pinnedTime = new Date("2001-01-01T00:00:00.000Z");
    await utimes(outPath, pinnedTime, pinnedTime);
    await compileC({ cPath, outPath, cacheIdentity: "scriptc-generated-v1" });
    expect((await stat(outPath)).mtimeMs).toBe(pinnedTime.getTime());

    process.umask(0o077);
    await compileC({ cPath, outPath, cacheIdentity: "scriptc-generated-v1" });
    expect((await stat(outPath)).mode & 0o777).toBe(0o700);
    process.umask(oldUmask);
    await compileC({ cPath, outPath, cacheIdentity: "scriptc-generated-v1" });
    expect((await stat(outPath)).mode & 0o777).toBe(0o777 & ~oldUmask);

    // Generated TU bytes join the key: an actual source edit must replace the
    // output even though its path, runtime, and toolchain are unchanged.
    await writeFile(cPath, '#include <stdio.h>\nint main(void) { puts("edited"); return 0; }\n');
    await compileC({ cPath, outPath, cacheIdentity: "scriptc-generated-v1" });
    expect(execFileSync(outPath, { encoding: "utf8" }).trim()).toBe("edited");
    await writeFile(cPath, '#include <stdio.h>\nint main(void) { puts("valid"); return 0; }\n');
    await compileC({ cPath, outPath, cacheIdentity: "scriptc-generated-v1" });

    // A damaged output cannot no-op even when every build input is unchanged.
    await writeFile(outPath, "damaged\n");
    await compileC({ cPath, outPath, cacheIdentity: "scriptc-generated-v1" });
    expect(execFileSync(outPath, { encoding: "utf8" }).trim()).toBe("valid");

    // The stamp is disposable cache data. A changed SDK/linker dependency
    // metadata record must take the strict CAS path, which reinstalls output.
    const damagedStamp = JSON.parse(await readFile(stampPath, "utf8")) as typeof stamp;
    damagedStamp.dependencies[0]!.size++;
    await writeFile(stampPath, `${JSON.stringify(damagedStamp)}\n`);
    await utimes(outPath, pinnedTime, pinnedTime);
    await compileC({ cPath, outPath, cacheIdentity: "scriptc-generated-v1" });
    expect((await stat(outPath)).mtimeMs).toBeGreaterThan(pinnedTime.getTime());
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    process.umask(oldUmask);
  }
});

test("artifact-ready callbacks expose native dependencies on builds and validated hits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-artifact-ready-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const cPath = join(dir, "program.c");
  const outPath = join(dir, "program");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  try {
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    await writeFile(cPath, "int main(void) { return 0; }\n");
    const observations: string[][] = [];
    const build = (): Promise<void> => compileC({
      cPath,
      outPath,
      cacheIdentity: "scriptc-generated-v1",
      onArtifactReady: async ({ dependencies }) => {
        observations.push(dependencies.map((dependency) => dependency.path));
      },
    });
    await build();
    await build();
    expect(observations).toHaveLength(2);
    expect(observations[0]!.length).toBeGreaterThan(0);
    expect(observations[1]).toEqual(observations[0]);
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
  }
});

test.skipIf(process.platform === "win32")(
  "output-local hits follow symlinked header targets",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-local-artifact-symlink-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const cPath = join(dir, "program.c");
    const header = join(dir, "value.h");
    const target = join(dir, "target.h");
    const outPath = join(dir, "program");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];

    try {
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      delete process.env["SCRIPTC_NO_CACHE"];
      await writeFile(target, '#define VALUE "one"\n');
      await symlink(target, header);
      await writeFile(
        cPath,
        '#include <stdio.h>\n#include "value.h"\nint main(void) { puts(VALUE); return 0; }\n',
      );
      await compileC({ cPath, outPath, cacheIdentity: "scriptc-generated-v1" });
      expect(execFileSync(outPath, { encoding: "utf8" }).trim()).toBe("one");

      // clang's dependency file names the symlink path. The local stamp must
      // also follow that path and invalidate when only the target changes.
      await writeFile(target, '#define VALUE "two"\n');
      await compileC({ cPath, outPath, cacheIdentity: "scriptc-generated-v1" });
      expect(execFileSync(outPath, { encoding: "utf8" }).trim()).toBe("two");
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "output-local hits detect newly shadowing nested headers",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-local-artifact-shadow-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const cPath = join(dir, "program.c");
    const outPath = join(dir, "program");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];

    try {
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      delete process.env["SCRIPTC_NO_CACHE"];
      await mkdir(join(dir, "sys"));
      await writeFile(
        cPath,
        '#include <stdio.h>\n#include "sys/param.h"\nint main(void) { printf("%d\\n", MAXPATHLEN); return 0; }\n',
      );
      await compileC({ cPath, outPath, cacheIdentity: "scriptc-generated-v1" });
      expect(execFileSync(outPath, { encoding: "utf8" }).trim()).not.toBe("7");

      // The source directory itself does not necessarily change metadata when
      // a child directory gains a file. Its recursive namespace digest must.
      await writeFile(join(dir, "sys", "param.h"), "#define MAXPATHLEN 7\n");
      await compileC({ cPath, outPath, cacheIdentity: "scriptc-generated-v1" });
      expect(execFileSync(outPath, { encoding: "utf8" }).trim()).toBe("7");
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    }
  },
);

test("fresh processes preserve output-local dependency coverage after source edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-local-artifact-process-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const cPath = join(dir, "program.c");
  const outPath = join(dir, "program");
  const helperPath = join(dir, "compile.mjs");
  const childEnv: NodeJS.ProcessEnv = { ...process.env, SCRIPTC_CACHE_DIR: cacheRoot };
  delete childEnv["SCRIPTC_NO_CACHE"];
  delete childEnv["SCRIPTC_TEST_STABLE_TOOLCHAIN"];
  delete childEnv["SCRIPTC_TEST_TRUST_COMPILER_WRAPPER"];

  await writeFile(
    helperPath,
    `import { compileC } from ${JSON.stringify(new URL("./cc.ts", import.meta.url).href)};\n` +
      `await compileC({ cPath: process.argv[2], outPath: process.argv[3], cacheIdentity: "scriptc-generated-v1" });\n`,
  );
  const compileInFreshProcess = (): void => {
    execFileSync(process.execPath, ["--import", "tsx", helperPath, cPath, outPath], {
      env: childEnv,
      stdio: "pipe",
    });
  };
  const stampPath = join(
    cacheRoot,
    "local",
    createHash("sha256").update(outPath).digest("hex"),
  );
  const dependencyPaths = async (): Promise<string[]> => {
    const stamp = JSON.parse(await readFile(stampPath, "utf8")) as {
      dependencies: { path: string }[];
    };
    return stamp.dependencies.map((dependency) => dependency.path);
  };

  await writeFile(cPath, '#include <stdio.h>\nint main(void) { puts("one"); return 0; }\n');
  compileInFreshProcess();
  const firstPaths = await dependencyPaths();
  expect(firstPaths.length).toBeGreaterThan(2);

  // The metadata fingerprints are restored from cache files in this second
  // Node process; their in-memory fingerprint-to-path map starts empty.
  await writeFile(cPath, '#include <stdio.h>\nint main(void) { puts("two"); return 0; }\n');
  compileInFreshProcess();
  expect(execFileSync(outPath, { encoding: "utf8" }).trim()).toBe("two");
  expect(await dependencyPaths()).toEqual(firstPaths);
});

test("native metadata snapshots survive source edits and repair after tampering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-native-metadata-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const cPath = join(dir, "program.c");
  const outPath = join(dir, "program");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];

  try {
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    await writeFile(cPath, '#include <stdio.h>\nint main(void) { puts("one"); return 0; }\n');
    await compileC({ cPath, outPath, cacheIdentity: "scriptc-generated-v1" });

    const metadataDir = join(cacheRoot, "meta");
    const metadataNames = await readdir(metadataDir);
    expect(metadataNames.length).toBeGreaterThanOrEqual(3);
    const pinnedTime = new Date("2002-01-01T00:00:00.000Z");
    await Promise.all(metadataNames.map((name) => utimes(join(metadataDir, name), pinnedTime, pinnedTime)));

    // Program bytes are not toolchain identity. A source edit should reuse the
    // validated target/compiler/link snapshots without republishing them.
    await writeFile(cPath, '#include <stdio.h>\nint main(void) { puts("two"); return 0; }\n');
    await compileC({ cPath, outPath, cacheIdentity: "scriptc-generated-v1" });
    expect(execFileSync(outPath, { encoding: "utf8" }).trim()).toBe("two");
    for (const name of metadataNames) {
      expect((await stat(join(metadataDir, name))).mtimeMs).toBe(pinnedTime.getTime());
    }

    // Snapshot files are disposable cache data. Tampering invalidates one,
    // strict discovery repairs it, and the requested source edit still lands.
    const damagedPath = join(metadataDir, metadataNames[0]!);
    const damaged = JSON.parse(await readFile(damagedPath, "utf8")) as { integrity: string };
    damaged.integrity = "0".repeat(64);
    await writeFile(damagedPath, `${JSON.stringify(damaged)}\n`);
    await utimes(damagedPath, pinnedTime, pinnedTime);
    await writeFile(cPath, '#include <stdio.h>\nint main(void) { puts("three"); return 0; }\n');
    await compileC({ cPath, outPath, cacheIdentity: "scriptc-generated-v1" });
    expect(execFileSync(outPath, { encoding: "utf8" }).trim()).toBe("three");
    expect((await stat(damagedPath)).mtimeMs).toBeGreaterThan(pinnedTime.getTime());
    const repaired = JSON.parse(await readFile(damagedPath, "utf8")) as { integrity: string };
    expect(repaired.integrity).not.toBe("0".repeat(64));
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
  }
});

test("damaged complete artifacts are rejected and rebuilt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-artifact-integrity-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const cPath = join(dir, "program.c");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const corruption = Buffer.from("scriptc-corrupt-complete-artifact\n");

  try {
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    await writeFile(cPath, '#include <stdio.h>\nint main(void) { puts("valid"); return 0; }\n');

    await compileC({
      cPath,
      outPath: join(dir, "program"),
      cacheIdentity: TEST_CACHE_IDENTITY,
    });
    const [cachedBinary] = await completeArtifacts(cacheRoot, "bin");
    expect(cachedBinary).toBeDefined();
    expect((await stat(`${join(cacheRoot, "bin", cachedBinary!)}.sha256`)).isFile()).toBe(true);
    await writeFile(join(cacheRoot, "bin", cachedBinary!), corruption);

    const repairedBinary = join(dir, "program");
    await compileC({
      cPath,
      outPath: repairedBinary,
      cacheIdentity: TEST_CACHE_IDENTITY,
    });
    expect(execFileSync(repairedBinary, { encoding: "utf8" }).trim()).toBe("valid");
    expect(await readFile(join(cacheRoot, "bin", cachedBinary!))).not.toEqual(corruption);

    await writeFile(cPath, "int scriptc_artifact_integrity_probe = 1;\n");
    await compileLibArchive({
      cPath,
      outPath: join(dir, "first.lib.a"),
      cacheIdentity: TEST_CACHE_IDENTITY,
    });
    const [cachedArchive] = await completeArtifacts(cacheRoot, "lib");
    expect(cachedArchive).toBeDefined();
    expect((await stat(`${join(cacheRoot, "lib", cachedArchive!)}.sha256`)).isFile()).toBe(true);
    await writeFile(join(cacheRoot, "lib", cachedArchive!), corruption);

    const repairedArchive = join(dir, "repaired.lib.a");
    await compileLibArchive({
      cPath,
      outPath: repairedArchive,
      cacheIdentity: TEST_CACHE_IDENTITY,
    });
    expect((await readFile(repairedArchive)).includes(corruption)).toBe(false);
    expect(execFileSync("ar", ["t", repairedArchive], { encoding: "utf8" })).toContain("program.program.o");
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
  }
});

test("damaged runtime objects are rebuilt before linking or archiving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-object-integrity-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const cPath = join(dir, "program.c");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const corruption = Buffer.from("scriptc-corrupt-object-unique-marker");

  const objectSets = async (): Promise<string[]> =>
    (await readdir(join(cacheRoot, "obj"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("build-"))
      .map((entry) => entry.name);
  const corruptOneObject = async (set: string): Promise<string> => {
    const objectDir = join(cacheRoot, "obj", set);
    const object = (await readdir(objectDir)).find((name) => name.endsWith(".o"));
    expect(object).toBeDefined();
    await writeFile(join(objectDir, object!), corruption);
    expect((await stat(`${join(objectDir, object!)}.sha256`)).isFile()).toBe(true);
    return join(objectDir, object!);
  };

  try {
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    await writeFile(cPath, '#include <stdio.h>\nint main(void) { puts("one"); return 0; }\n');
    await compileC({
      cPath,
      outPath: join(dir, "one"),
      cacheIdentity: TEST_CACHE_IDENTITY,
    });
    const [executableSet] = await objectSets();
    const damagedExecutableObject = await corruptOneObject(executableSet!);

    await writeFile(cPath, '#include <stdio.h>\nint main(void) { puts("two"); return 0; }\n');
    const repairedOut = join(dir, "two");
    await compileC({
      cPath,
      outPath: repairedOut,
      cacheIdentity: TEST_CACHE_IDENTITY,
    });
    expect(execFileSync(repairedOut, { encoding: "utf8" }).trim()).toBe("two");
    expect(await readFile(damagedExecutableObject)).not.toEqual(corruption);

    const beforeLibrary = new Set(await objectSets());
    await writeFile(cPath, "int scriptc_integrity_probe = 1;\n");
    await compileLibArchive({
      cPath,
      outPath: join(dir, "one.lib.a"),
      cacheIdentity: TEST_CACHE_IDENTITY,
    });
    const librarySet = (await objectSets()).find((set) => !beforeLibrary.has(set));
    expect(librarySet).toBeDefined();
    await corruptOneObject(librarySet!);

    await writeFile(cPath, "int scriptc_integrity_probe = 2;\n");
    const repairedArchive = join(dir, "two.lib.a");
    await compileLibArchive({
      cPath,
      outPath: repairedArchive,
      cacheIdentity: TEST_CACHE_IDENTITY,
    });
    expect((await readFile(repairedArchive)).includes(corruption)).toBe(false);
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
  }
});

test("library archives hit by content, invalidate on edits, and reuse runtime objects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-lib-cache-"));
  scratch.push(dir);
  const xdgCacheHome = join(dir, "xdg-cache");
  const cacheRoot = join(xdgCacheHome, "scriptc", "build");
  const cPath = join(dir, "program.c");
  const outPath = join(dir, "program.lib.a");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldXdgCacheHome = process.env["XDG_CACHE_HOME"];
  const oldPath = process.env["PATH"];

  try {
    // No SCRIPTC_CACHE_DIR: this exercises the production-default activation,
    // with XDG_CACHE_HOME redirecting the per-user root into disposable space.
    delete process.env["SCRIPTC_CACHE_DIR"];
    process.env["XDG_CACHE_HOME"] = xdgCacheHome;
    delete process.env["SCRIPTC_NO_CACHE"];
    await writeFile(cPath, "int scriptc_cache_probe = 1;\n");
    await compileLibArchive({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
    const firstArchive = await readFile(outPath);
    expect(await completeArtifacts(cacheRoot, "lib")).toHaveLength(1);

    const objectSets = await readdir(join(cacheRoot, "obj"), { withFileTypes: true });
    const objectSet = objectSets.find((entry) => entry.isDirectory() && !entry.name.startsWith("build-"));
    expect(objectSet).toBeDefined();
    const objectDir = join(cacheRoot, "obj", objectSet!.name);
    const objectNames = (await readdir(objectDir)).filter((name) => name.endsWith(".o"));
    expect(objectNames.length).toBeGreaterThan(10);
    const pinnedTime = new Date("2000-01-01T00:00:00.000Z");
    await Promise.all(objectNames.map((name) => utimes(join(objectDir, name), pinnedTime, pinnedTime)));

    // A content hit still performs fresh compiler/toolchain discovery, but it
    // must not stage or promote the cached runtime objects.
    await rm(outPath, { force: true });
    await compileLibArchive({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
    expect(await readFile(outPath)).toEqual(firstArchive);
    for (const name of objectNames) {
      expect((await stat(join(objectDir, name))).mtimeMs).toBe(pinnedTime.getTime());
    }

    // The hard disable bypasses the same valid entry in both directions.
    process.env["SCRIPTC_NO_CACHE"] = "1";
    process.env["PATH"] = "";
    await rm(outPath, { force: true });
    await expect(
      compileLibArchive({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY }),
    ).rejects.toThrow(/failed compiling/);
    expect(await completeArtifacts(cacheRoot, "lib")).toHaveLength(1);

    // An edit invalidates the complete archive but retains the library-flavor
    // runtime object set. Only the changed program TU is compiled again.
    process.env["PATH"] = oldPath;
    delete process.env["SCRIPTC_NO_CACHE"];
    await writeFile(cPath, "int scriptc_cache_probe = 2;\n");
    await compileLibArchive({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
    const editedArchive = await readFile(outPath);
    expect(editedArchive).not.toEqual(firstArchive);
    expect(await completeArtifacts(cacheRoot, "lib")).toHaveLength(2);
    for (const name of objectNames) {
      expect((await stat(join(objectDir, name))).mtimeMs).toBeGreaterThan(pinnedTime.getTime());
    }

    // BSD ar preserves member mtimes, so containers assembled from old cached
    // objects need not be byte-identical to a fresh archive. Their object
    // members must be byte-identical, and a successful disabled build must
    // publish nothing into the cache.
    process.env["SCRIPTC_NO_CACHE"] = "1";
    const uncachedOut = join(dir, "program.uncached.lib.a");
    await compileLibArchive({ cPath, outPath: uncachedOut, cacheIdentity: TEST_CACHE_IDENTITY });
    const cachedMembers = join(dir, "cached-members");
    const uncachedMembers = join(dir, "uncached-members");
    await Promise.all([mkdir(cachedMembers), mkdir(uncachedMembers)]);
    execFileSync("ar", ["x", outPath], { cwd: cachedMembers });
    execFileSync("ar", ["x", uncachedOut], { cwd: uncachedMembers });
    const memberNames = await readdir(cachedMembers);
    expect(await readdir(uncachedMembers)).toEqual(memberNames);
    for (const name of memberNames) {
      expect(await readFile(join(uncachedMembers, name))).toEqual(await readFile(join(cachedMembers, name)));
    }
    expect(await completeArtifacts(cacheRoot, "lib")).toHaveLength(2);
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    if (oldXdgCacheHome === undefined) delete process.env["XDG_CACHE_HOME"];
    else process.env["XDG_CACHE_HOME"] = oldXdgCacheHome;
    if (oldPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = oldPath;
  }
});

test("library identity edits reuse the cached large program object", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-lib-program-object-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const cPath = join(dir, "program.c");
  const outPath = join(dir, "program.lib.a");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  try {
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    await mkdir(cacheRoot, { mode: 0o700 });
    const programSource = "int scriptc_large_program_value(void) { return 7; }\n";
    await writeFile(
      cPath,
      `${programSource}unsigned long long scriptc_build_id(void) { return 1; }\n`,
    );
    await compileLibArchive({
      cPath,
      programSource,
      identityCSource: "unsigned long long scriptc_build_id(void) { return 1; }\n",
      outPath,
      cacheIdentity: TEST_CACHE_IDENTITY,
    });
    const [objectName] = (await readdir(join(cacheRoot, "program-obj")))
      .filter((name) => !name.endsWith(".sha256"));
    expect(objectName).toBeDefined();
    const objectPath = join(cacheRoot, "program-obj", objectName!);
    const objectDigest = await readFile(`${objectPath}.sha256`, "utf8");
    const old = new Date("2000-01-01T00:00:00.000Z");
    await utimes(objectPath, old, old);

    await writeFile(
      cPath,
      `${programSource}unsigned long long scriptc_build_id(void) { return 2; }\n`,
    );
    await compileLibArchive({
      cPath,
      programSource,
      identityCSource: "unsigned long long scriptc_build_id(void) { return 2; }\n",
      outPath,
      cacheIdentity: TEST_CACHE_IDENTITY,
    });
    expect(await readFile(`${objectPath}.sha256`, "utf8")).toBe(objectDigest);
    expect((await stat(objectPath)).mtimeMs).toBeGreaterThan(old.getTime());
    expect((await readdir(join(cacheRoot, "program-obj"))).filter((name) => !name.endsWith(".sha256"))).toEqual([objectName]);
    const probeSource = join(dir, "probe.c");
    const probe = join(dir, "probe");
    await writeFile(
      probeSource,
      "#include <stdio.h>\nint scriptc_large_program_value(void);\nunsigned long long scriptc_build_id(void);\nint main(void) { printf(\"%d %llu\\n\", scriptc_large_program_value(), scriptc_build_id()); }\n",
    );
    execFileSync("clang", [probeSource, outPath, "-lm", "-o", probe]);
    expect(execFileSync(probe, { encoding: "utf8" })).toBe("7 2\n");
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
  }
});

test.skipIf(!nativeShardMergeAvailable)(
  "LLVM library shards reuse unaffected program objects after a localized edit",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-lib-program-shards-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const cPath = join(dir, "program.ll");
    const outPath = join(dir, "program.lib.a");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const source = (value: number): string => `%Pair = type { i64, i64 }
@private_value = internal global i64 ${value}

define internal i64 @left() {
entry:
  %v = load i64, ptr @private_value
  ret i64 %v
}

define internal i64 @right() {
entry:
  %v = call i64 @left()
  ret i64 %v
}

define i64 @scriptc_public_value() {
entry:
  %v = call i64 @right()
  ret i64 %v
}
`;
    try {
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      delete process.env["SCRIPTC_NO_CACHE"];
      await mkdir(cacheRoot, { mode: 0o700 });
      const build = async (value: number): Promise<void> => {
        const programSource = source(value);
        const split = splitLlvmProgram(programSource, { minimumBytes: 0, targetBytes: 64 * 1024 });
        expect(split?.shards).toHaveLength(3);
        await writeFile(cPath, programSource);
        await compileLibArchive({
          cPath,
          programSource,
          programShards: split!.shards,
          programPublicSymbols: split!.publicSymbols,
          outPath,
          cacheIdentity: TEST_CACHE_IDENTITY,
          optimization: "dev",
        });
      };
      await build(7);
      const initial = (await readdir(join(cacheRoot, "program-shard")))
        .filter((name) => !name.endsWith(".sha256"));
      expect(initial).toHaveLength(3);

      await build(9);
      const after = (await readdir(join(cacheRoot, "program-shard")))
        .filter((name) => !name.endsWith(".sha256"));
      expect(after).toHaveLength(4);
      expect(initial.filter((name) => after.includes(name))).toHaveLength(3);
      const old = new Date("2000-01-01T00:00:00.000Z");
      await Promise.all(after.map((name) => utimes(join(cacheRoot, "program-shard", name), old, old)));
      await build(9);
      for (const name of after) {
        // The completed archive hit returns before shard lookup/merge; exact
        // repeats do not even touch the per-bucket object cache.
        expect((await stat(join(cacheRoot, "program-shard", name))).mtimeMs).toBe(old.getTime());
      }

      const probeSource = join(dir, "probe.c");
      const probe = join(dir, "probe");
      await writeFile(
        probeSource,
        "#include <stdio.h>\nlong long scriptc_public_value(void);\nint main(void) { printf(\"%lld\\n\", scriptc_public_value()); }\n",
      );
      execFileSync("clang", [probeSource, outPath, "-lm", "-o", probe]);
      expect(execFileSync(probe, { encoding: "utf8" })).toBe("9\n");
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    }
  },
);

test.skipIf(!nativeShardMergeAvailable)(
  "LLVM executable dev shards reuse unaffected program objects after a localized edit",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-exe-program-shards-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const cPath = join(dir, "program.ll");
    const outPath = join(dir, "program");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const source = (value: number): string => `@private_value = internal global i64 ${value}

define internal i64 @left() {
entry:
  %v = load i64, ptr @private_value
  ret i64 %v
}

define internal i64 @right() {
entry:
  %v = call i64 @left()
  ret i64 %v
}

define i32 @main() {
entry:
  %v = call i64 @right()
  %exit = trunc i64 %v to i32
  ret i32 %exit
}
`;
    try {
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      delete process.env["SCRIPTC_NO_CACHE"];
      await mkdir(cacheRoot, { mode: 0o700 });
      const build = async (value: number): Promise<void> => {
        const programSource = source(value);
        const split = splitLlvmProgram(programSource, { minimumBytes: 0, targetBytes: 64 * 1024 });
        expect(split?.shards).toHaveLength(3);
        await writeFile(cPath, programSource);
        await compileC({
          cPath,
          programShards: split!.shards,
          programPublicSymbols: split!.publicSymbols,
          outPath,
          cacheIdentity: TEST_CACHE_IDENTITY,
          optimization: "dev",
        });
      };
      await build(7);
      const initial = (await readdir(join(cacheRoot, "program-shard")))
        .filter((name) => !name.endsWith(".sha256"));
      expect(initial).toHaveLength(3);
      expect(spawnSync(outPath).status).toBe(7);

      await build(9);
      const after = (await readdir(join(cacheRoot, "program-shard")))
        .filter((name) => !name.endsWith(".sha256"));
      expect(after).toHaveLength(4);
      expect(initial.filter((name) => after.includes(name))).toHaveLength(3);
      expect(spawnSync(outPath).status).toBe(9);
      const old = new Date("2000-01-01T00:00:00.000Z");
      await Promise.all(after.map((name) => utimes(join(cacheRoot, "program-shard", name), old, old)));
      await build(9);
      for (const name of after) {
        // The completed executable hit returns before shard lookup/merge.
        expect((await stat(join(cacheRoot, "program-shard", name))).mtimeMs).toBe(old.getTime());
      }
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    }
  },
);

test.skipIf(
  process.platform === "win32" || clangExecutable === undefined ||
  ldExecutable === undefined || (process.platform === "linux" && objcopyExecutable === undefined),
)("LLVM executable shards fall back without publishing a shard-derived binary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-exe-program-shard-fallback-"));
  scratch.push(dir);
  const binDir = join(dir, "bin");
  const cacheRoot = join(dir, "cache");
  const cPath = join(dir, "program.ll");
  const outPath = join(dir, "program");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldPath = process.env["PATH"];
  const oldRealLd = process.env["SCRIPTC_TEST_REAL_LD"];
  const programSource = [
    "define i32 @main() {",
    "entry:",
    "  ret i32 7",
    "}",
    "",
    "define internal i64 @other_value() {",
    "entry:",
    "  ret i64 9",
    "}",
    "",
  ].join("\n");
  try {
    await Promise.all([mkdir(binDir), mkdir(cacheRoot, { mode: 0o700 })]);
    await Promise.all([
      symlink(clangExecutable!, join(binDir, "clang")),
      ...(process.platform === "linux"
        ? [symlink(objcopyExecutable!, join(binDir, "objcopy"))]
        : []),
      writeFile(
        join(binDir, "ld"),
        "#!/bin/sh\nfor arg in \"$@\"; do if [ \"$arg\" = -r ]; then exit 1; fi; done\nexec \"$SCRIPTC_TEST_REAL_LD\" \"$@\"\n",
      ),
      writeFile(cPath, programSource),
    ]);
    await chmod(join(binDir, "ld"), 0o755);
    process.env["PATH"] = binDir;
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    process.env["SCRIPTC_TEST_REAL_LD"] = ldExecutable!;
    delete process.env["SCRIPTC_NO_CACHE"];
    await compileC({
      cPath,
      programShards: [
        {
          name: "program-f000.ll",
          source: "define i32 @main() {\nentry:\n  ret i32 7\n}\ndeclare hidden i64 @other_value()\n",
        },
        {
          name: "program-f001.ll",
          source: "declare i32 @main()\ndefine hidden i64 @other_value() {\nentry:\n  ret i64 9\n}\n",
        },
      ],
      programPublicSymbols: ["main"],
      outPath,
      cacheIdentity: TEST_CACHE_IDENTITY,
      optimization: "dev",
    });
    expect(spawnSync(outPath).status).toBe(7);
    // The canonical retry is valid output, but cannot occupy a key describing
    // a successful shard merge. Repairing the merge tool must retry the mode.
    expect(await readdir(join(cacheRoot, "bin")).catch(() => [])).toEqual([]);
    expect(await readdir(join(cacheRoot, "program-shard")).catch(() => [])).toEqual([]);
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    if (oldPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = oldPath;
    if (oldRealLd === undefined) delete process.env["SCRIPTC_TEST_REAL_LD"];
    else process.env["SCRIPTC_TEST_REAL_LD"] = oldRealLd;
  }
});

test.skipIf(!nativeShardMergeAvailable)(
  "LLVM merged-object and archive caches separate shard projections and public-symbol keep sets",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-lib-program-shard-abi-"));
    scratch.push(dir);
    const cacheRoot = join(dir, "cache");
    const cPath = join(dir, "program.ll");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const programSource = [
      "define i64 @foo() {",
      "entry:",
      "  ret i64 1",
      "}",
      "",
      "define i64 @bar() {",
      "entry:",
      "  ret i64 2",
      "}",
      "",
    ].join("\n");
    const programShards = [
      {
        name: "program-f000.ll",
        source: "define i64 @foo() {\nentry:\n  ret i64 1\n}\ndeclare i64 @bar()\n",
      },
      {
        name: "program-f001.ll",
        source: "declare i64 @foo()\ndefine i64 @bar() {\nentry:\n  ret i64 2\n}\n",
      },
    ];
    try {
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      delete process.env["SCRIPTC_NO_CACHE"];
      await mkdir(cacheRoot, { mode: 0o700 });
      await writeFile(cPath, programSource);
      const build = async (
        symbol: "foo" | "bar",
        outPath: string,
        shards = programShards,
      ): Promise<void> => {
        await compileLibArchive({
          cPath,
          programSource,
          programShards: shards,
          programPublicSymbols: [symbol],
          outPath,
          cacheIdentity: TEST_CACHE_IDENTITY,
          optimization: "dev",
        });
      };
      await build("foo", join(dir, "foo.lib.a"));
      const barArchive = join(dir, "bar.lib.a");
      await build("bar", barArchive);

      expect(await completeArtifacts(cacheRoot, "lib")).toHaveLength(2);
      expect(
        (await readdir(join(cacheRoot, "program-obj"))).filter((name) => !name.endsWith(".sha256")),
      ).toHaveLength(2);
      const probeSource = join(dir, "probe.c");
      const probe = join(dir, "probe");
      await writeFile(probeSource, "long long bar(void);\nint main(void) { return bar() != 2; }\n");
      execFileSync("clang", [probeSource, barArchive, "-lm", "-o", probe]);
      expect(execFileSync(probe, { encoding: "utf8" })).toBe("");

      // The canonical TU and ABI stay fixed, but the exact shard projection
      // changes. The merged-object tier must not reuse the previous layout.
      await build("bar", join(dir, "bar-commented.lib.a"), [
        { ...programShards[0]!, source: `; projection edit\n${programShards[0]!.source}` },
        programShards[1]!,
      ]);
      expect(await completeArtifacts(cacheRoot, "lib")).toHaveLength(3);
      expect(
        (await readdir(join(cacheRoot, "program-obj"))).filter((name) => !name.endsWith(".sha256")),
      ).toHaveLength(3);
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    }
  },
);

test.skipIf(
  process.platform === "win32" || clangExecutable === undefined || arExecutable === undefined ||
  ldExecutable === undefined || (process.platform === "linux" && objcopyExecutable === undefined),
)("LLVM merged-object caches follow in-place shard merge-tool replacements", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-lib-program-shard-merge-tool-"));
  scratch.push(dir);
  const binDir = join(dir, "bin");
  const cacheRoot = join(dir, "cache");
  const mergeLog = join(dir, "merge.log");
  const cPath = join(dir, "program.ll");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldPath = process.env["PATH"];
  const oldRealLd = process.env["SCRIPTC_TEST_REAL_LD"];
  const oldMergeLog = process.env["SCRIPTC_TEST_MERGE_LOG"];
  const programSource = [
    "define i64 @foo() {",
    "entry:",
    "  ret i64 1",
    "}",
    "",
    "define i64 @bar() {",
    "entry:",
    "  ret i64 2",
    "}",
    "",
  ].join("\n");
  const programShards = [
    {
      name: "program-f000.ll",
      source: "define i64 @foo() {\nentry:\n  ret i64 1\n}\ndeclare i64 @bar()\n",
    },
    {
      name: "program-f001.ll",
      source: "declare i64 @foo()\ndefine i64 @bar() {\nentry:\n  ret i64 2\n}\n",
    },
  ];
  const ldWrapper = (generation: string): string => `#!/bin/sh
printf '${generation}\\n' >> "$SCRIPTC_TEST_MERGE_LOG"
exec "$SCRIPTC_TEST_REAL_LD" "$@"
`;
  try {
    await Promise.all([mkdir(binDir), mkdir(cacheRoot, { mode: 0o700 })]);
    await Promise.all([
      symlink(clangExecutable!, join(binDir, "clang")),
      symlink(arExecutable!, join(binDir, "ar")),
      ...(process.platform === "linux"
        ? [symlink(objcopyExecutable!, join(binDir, "objcopy"))]
        : []),
      writeFile(join(binDir, "ld"), ldWrapper("first")),
      writeFile(cPath, programSource),
    ]);
    await chmod(join(binDir, "ld"), 0o755);
    process.env["PATH"] = binDir;
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    process.env["SCRIPTC_TEST_REAL_LD"] = ldExecutable!;
    process.env["SCRIPTC_TEST_MERGE_LOG"] = mergeLog;
    delete process.env["SCRIPTC_NO_CACHE"];
    const build = (outPath: string): Promise<void> => compileLibArchive({
      cPath,
      programSource,
      programShards,
      programPublicSymbols: ["foo", "bar"],
      outPath,
      cacheIdentity: TEST_CACHE_IDENTITY,
      optimization: "dev",
    });

    await build(join(dir, "first.lib.a"));
    await writeFile(join(binDir, "ld"), ldWrapper("second"));
    await chmod(join(binDir, "ld"), 0o755);
    await build(join(dir, "second.lib.a"));

    expect((await readFile(mergeLog, "utf8")).trim().split("\n")).toEqual(["first", "second"]);
    expect(await completeArtifacts(cacheRoot, "lib")).toHaveLength(2);
    expect(
      (await readdir(join(cacheRoot, "program-obj"))).filter((name) => !name.endsWith(".sha256")),
    ).toHaveLength(2);
    // The compiler and shard IR did not change; only merged outputs split by
    // localization-tool identity.
    expect(
      (await readdir(join(cacheRoot, "program-shard"))).filter((name) => !name.endsWith(".sha256")),
    ).toHaveLength(2);
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    if (oldPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = oldPath;
    if (oldRealLd === undefined) delete process.env["SCRIPTC_TEST_REAL_LD"];
    else process.env["SCRIPTC_TEST_REAL_LD"] = oldRealLd;
    if (oldMergeLog === undefined) delete process.env["SCRIPTC_TEST_MERGE_LOG"];
    else process.env["SCRIPTC_TEST_MERGE_LOG"] = oldMergeLog;
  }
});

test.skipIf(
  process.platform === "win32" || clangExecutable === undefined || arExecutable === undefined,
)("LLVM library shards fall back to the canonical TU without host merge tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-lib-program-shard-fallback-"));
  scratch.push(dir);
  const binDir = join(dir, "bin");
  const cPath = join(dir, "program.ll");
  const outPath = join(dir, "program.lib.a");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldPath = process.env["PATH"];
  const programSource = "define i64 @public_value() {\nentry:\n  ret i64 7\n}\n";
  try {
    await mkdir(binDir);
    await Promise.all([
      symlink(clangExecutable!, join(binDir, "clang")),
      symlink(arExecutable!, join(binDir, "ar")),
    ]);
    process.env["PATH"] = binDir;
    process.env["SCRIPTC_NO_CACHE"] = "1";
    delete process.env["SCRIPTC_CACHE_DIR"];
    await writeFile(cPath, programSource);
    await compileLibArchive({
      cPath,
      programSource,
      // If compilation reaches either shard, this build fails. Missing ld
      // (and objcopy on Linux) must select the valid canonical TU instead.
      programShards: [
        { name: "program-f000.ll", source: "not valid LLVM IR\n" },
        { name: "program-f001.ll", source: "also not valid LLVM IR\n" },
      ],
      programPublicSymbols: ["public_value"],
      outPath,
      optimization: "dev",
    });
    expect(await readFile(outPath)).not.toHaveLength(0);
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    if (oldPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = oldPath;
  }
});

test.skipIf(
  process.platform === "win32" || clangExecutable === undefined || arExecutable === undefined ||
  (process.platform === "linux" && objcopyExecutable === undefined),
)("LLVM library shards fall back when an available host merge tool fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-lib-program-shard-merge-failure-"));
  scratch.push(dir);
  const binDir = join(dir, "bin");
  const cacheRoot = join(dir, "cache");
  const cPath = join(dir, "program.ll");
  const outPath = join(dir, "program.lib.a");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldPath = process.env["PATH"];
  const programSource = [
    "define i64 @public_value() {",
    "entry:",
    "  ret i64 7",
    "}",
    "",
    "define i64 @other_value() {",
    "entry:",
    "  ret i64 9",
    "}",
    "",
  ].join("\n");
  try {
    await Promise.all([mkdir(binDir), mkdir(cacheRoot, { mode: 0o700 })]);
    await Promise.all([
      symlink(clangExecutable!, join(binDir, "clang")),
      symlink(arExecutable!, join(binDir, "ar")),
      ...(process.platform === "linux"
        ? [symlink(objcopyExecutable!, join(binDir, "objcopy"))]
        : []),
      writeFile(join(binDir, "ld"), "#!/bin/sh\nexit 1\n"),
      writeFile(cPath, programSource),
    ]);
    await chmod(join(binDir, "ld"), 0o755);
    process.env["PATH"] = binDir;
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    await compileLibArchive({
      cPath,
      programSource,
      programShards: [
        {
          name: "program-f000.ll",
          source: "define i64 @public_value() {\nentry:\n  ret i64 7\n}\ndeclare i64 @other_value()\n",
        },
        {
          name: "program-f001.ll",
          source: "declare i64 @public_value()\ndefine i64 @other_value() {\nentry:\n  ret i64 9\n}\n",
        },
      ],
      programPublicSymbols: ["public_value", "other_value"],
      outPath,
      cacheIdentity: TEST_CACHE_IDENTITY,
      optimization: "dev",
    });
    const probeSource = join(dir, "probe.c");
    const probe = join(dir, "probe");
    await writeFile(
      probeSource,
      "long long public_value(void);\nint main(void) { return public_value() != 7; }\n",
    );
    execFileSync(clangExecutable!, [probeSource, outPath, "-lm", "-o", probe]);
    expect(execFileSync(probe, { encoding: "utf8" })).toBe("");
    // The canonical retry is valid for this invocation, but must not occupy a
    // key describing merged shard bytes. A repaired merge tool retries the
    // optimization instead of receiving a poisoned completed/object hit.
    expect(await readdir(join(cacheRoot, "lib")).catch(() => [])).toEqual([]);
    expect(await readdir(join(cacheRoot, "program-obj")).catch(() => [])).toEqual([]);
    expect(await readdir(join(cacheRoot, "program-shard")).catch(() => [])).toEqual([]);
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    if (oldPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = oldPath;
  }
});

test.skipIf(process.platform === "win32" || zigExecutable === undefined)(
  "cross-ELF localized archives retain unreferenced identity roots",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-lib-localized-identity-"));
    scratch.push(dir);
    const cPath = join(dir, "program.c");
    const probePath = join(dir, "probe.c");
    const archivePath = join(dir, "program.lib.a");
    const probeOutput = join(dir, "probe");
    const cacheRoot = join(dir, "cache");
    const target = "x86_64-linux-gnu.2.36";
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldCc = process.env["SCRIPTC_CC"];
    const oldTarget = process.env["SCRIPTC_TARGET"];
    try {
      process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
      delete process.env["SCRIPTC_NO_CACHE"];
      process.env["SCRIPTC_CC"] = "zigcc";
      process.env["SCRIPTC_TARGET"] = target;
      await writeFile(cPath, "int scriptc_large_program_value(void) { return 7; }\n");
      await compileLibArchive({
        cPath,
        identityCSource: [
          "unsigned long long scriptc_build_id(void) { return 2; }",
          "unsigned scriptc_abi_version(void) { return 1; }",
          "",
        ].join("\n"),
        outPath: archivePath,
        cacheIdentity: TEST_CACHE_IDENTITY,
        localizeSymbols: [
          "scriptc_large_program_value",
          "scriptc_build_id",
          "scriptc_abi_version",
        ],
      });
      await writeFile(probePath, [
        "int scriptc_large_program_value(void);",
        "unsigned long long scriptc_build_id(void);",
        "unsigned scriptc_abi_version(void);",
        "int main(void) {",
        "  return scriptc_large_program_value() != 7 || scriptc_build_id() != 2 || scriptc_abi_version() != 1;",
        "}",
        "",
      ].join("\n"));
      execFileSync(zigExecutable!, [
        "cc", "-target", target, probePath, archivePath, "-lm", "-o", probeOutput,
      ]);
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldCc === undefined) delete process.env["SCRIPTC_CC"];
      else process.env["SCRIPTC_CC"] = oldCc;
      if (oldTarget === undefined) delete process.env["SCRIPTC_TARGET"];
      else process.env["SCRIPTC_TARGET"] = oldTarget;
    }
  },
);
