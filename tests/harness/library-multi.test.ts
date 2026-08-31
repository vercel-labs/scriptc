/* Multi-instance library mode (the profile's abi.localize_runtime): N
 * library archives built under pairwise-distinct symbol prefixes link into
 * ONE process. The archive build combines the program, runtime, and vendor
 * objects into one relocatable member and demotes every external
 * definition except the profile-declared symbols to a local symbol, so the
 * embedder's linker sees no runtime internals at all — no symbol
 * collisions, and each instance owns a private copy of the whole runtime
 * (allocator, collector, result arena, panic sink, poison flag).
 *
 *   M1 symbols-exact     nm over a localized archive: the external defined
 *                        set equals the profile-declared set EXACTLY (plus
 *                        ASan's one image-registration common in a
 *                        sanitized build), and undefineds stay target-
 *                        runtime/system-API-shaped apart from sanitizer ABI
 *                        references
 *   M2 two-instance run  the acceptance probe: two archives (ma_/mb_), two
 *                        embedder threads (one per instance — the
 *                        documented contract), independent init and
 *                        collect, a deliberate trap in A delivered to A's
 *                        sink exactly once (structured: SC4014, ma_boom,
 *                        A's ctx) while B keeps answering through and after
 *                        the trap window; B's sink never fires. Runs per
 *                        emission and once with mixed emissions (one
 *                        archive per backend).
 *   M3 profile shape     abi.localize_runtime is strictly boolean (SC4001)
 *   M4 target posture    localization is per OBJECT FORMAT: ELF and COFF
 *                        localize from any host, Mach-O runs the macOS
 *                        host linker — so a macos target off a darwin
 *                        host, and any host outside darwin/linux/win32,
 *                        refuses SC3002 before emission with the pairing
 *                        named
 *
 * Thread-instanced state (the profile's abi.instance_per_thread): every
 * mutable static in the archive — runtime internals, module globals,
 * run-once guards, regex literal caches — compiles as thread-local
 * storage, so ONE linked archive serves one independent instance per
 * embedder thread through the unchanged entry family (the calling thread
 * is the instance selector).
 *
 *   M6 four threads      one archive, four embedder threads with distinct
 *                        workloads: concurrent instance-local inits,
 *                        independent state and collects, a deliberate trap
 *                        on thread 0 delivered to ITS sink exactly once
 *                        (SC4014, mt_boom, its ctx) poisoning only its
 *                        instance while the other three keep answering
 *                        through and after the trap window; sanitized in
 *                        the SCRIPTC_SAN=1 flavor like M1/M2
 *   M6 inspect TLS       deterministic two-thread runtime seam proving
 *                        circular-target pointers cannot cross instances
 *   M7 composition       a thread-instanced AND runtime-localized archive
 *                        coexists with a second different-prefix localized
 *                        archive in one process (both mechanisms at once);
 *                        the localized link surface stays exactly the
 *                        declared set, with M1's one ASan
 *                        image-registration common in a sanitized build
 *   M8 sanitized rerun   M6 re-run explicitly under ASan (the K10
 *                        precedent: the plain flavor carries an
 *                        instrumented pairing too)
 *   M9 profile shape     abi.instance_per_thread is strictly boolean
 *                        (SC4001)
 *
 * Cross-target localization (SCRIPTC_CROSS=1 — zig on PATH, the
 * library-cross lane's gate; never part of the default suites):
 *
 *   M10 cross conformance  per cross target and emission: localized a/b
 *                        archives build, the external defined set equals
 *                        the declared set exactly (host nm reads ELF,
 *                        COFF, and Mach-O alike), no prefix-carrying
 *                        undefined escapes, the ambient audit holds, and
 *                        the two-archive probe LINKS with the target's
 *                        libc (plus the documented win32 embedder libs)
 *   M11 cross execution  the M2 acceptance probe runs on the real target:
 *                        linux triples in the differential containers
 *                        (SCRIPTC_LINUX=1), the windows triple on the ssh
 *                        box (SCRIPTC_WIN=1) — including the M7-style
 *                        thread-instanced+localized composition there
 *
 * Mobile library targets (aarch64-apple-ios, aarch64-apple-ios-simulator,
 * aarch64-linux-android — library-mode-only triples):
 *
 *   M12 admission        always-run refusal shape: an iOS triple off a
 *                        darwin host refuses SC3002 before any toolchain
 *                        runs; near-miss mobile spellings refuse with the
 *                        supported set named; the executable lane refuses
 *                        mobile triples with the pointer to --lib
 *   M13 iOS              SCRIPTC_IOS=1 (darwin host, Xcode with the
 *                        iPhoneOS + iPhoneSimulator SDKs, zig): localized
 *                        a/b archives build per target and emission with
 *                        M1's symbol exactness, the ambient audit, and the
 *                        iOS 15.0 LC_BUILD_VERSION floor; simulator probes
 *                        EXECUTE on a booted simulator (simctl spawn) —
 *                        the M2 two-instance acceptance run and the M6
 *                        four-thread instancing run, byte-for-byte against
 *                        the desktop expectations; device-arch archives
 *                        are build+link verified (no device to execute)
 *   M14 Android          SCRIPTC_ANDROID=1 (an NDK plus adb/emulator):
 *                        localized a/b archives build per emission with
 *                        the same symbol/audit bars, probes link with the
 *                        NDK's API-26 clang, and EXECUTE on an emulator
 *                        (a running device is reused; otherwise a headless
 *                        arm64 AVD is created and booted) — the M2 and M6
 *                        acceptance runs, byte-for-byte
 *
 * Windows hosts run M1/M2/M6/M7 natively through the same gates as darwin
 * and linux: probes compile with `zig cc` (the box's toolchain), archives
 * carry CRLF-normalized probe output (the mingw CRT's text-mode stdout),
 * and symbol checks ride llvm-nm when plain nm is absent.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compile, compileLibrary, IPHONEOS_MIN_VERSION, ANDROID_MIN_API, loadLibraryProfile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const fixtureDir = join(repoRoot, "tests/library-mode/multi");
const localizationTest =
  process.platform === "darwin" || process.platform === "linux" || process.platform === "win32"
    ? test
    : test.skip;
/* win32 boxes commonly carry llvm-nm (LLVM) rather than a bare nm; darwin's
 * nm IS llvm-nm and linux binutils nm reads its own objects. */
const nmTool = ((): string | null => {
  for (const tool of process.platform === "win32" ? ["llvm-nm", "nm"] : ["nm"]) {
    if (spawnSync(tool, ["--version"], { encoding: "utf8" }).status === 0) return tool;
  }
  return null;
})();
/* Probes are plain-C embedder hosts: clang on darwin/linux, `zig cc` on
 * win32 (the windows box's C toolchain — winpthreads rides -pthread). */
const probeCc = process.platform === "win32" ? ["zig", "cc"] : ["clang"];
/* The documented win32 embedder link line beyond the CRT (library-cross
 * pins the same set): advapi32 (CSPRNG, GetUserNameA), iphlpapi
 * (GetAdaptersAddresses), ws2_32 (inet_ntop/htonl). */
const WIN32_EMBEDDER_LIBS = ["-ladvapi32", "-liphlpapi", "-lws2_32"];
/* The mingw CRT's text-mode stdout writes CRLF from the PROBE's own printf
 * — a plain-C embedder host fact, folded back for comparison. */
const normalizeProbeOut = (out: string): string =>
  process.platform === "win32" ? out.replaceAll("\r\n", "\n") : out;
/* Suite-flavor segment (the library suites' convention): the plain and
 * SCRIPTC_SAN=1 suites may run concurrently and must never share build
 * dirs. */
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const flavor = sanitize ? "san" : "plain";
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/library-multi", flavor);

type Emission = "llvm" | "c";
const EMISSIONS: Emission[] = ["llvm", "c"];

/** Build one instance's localized archive for one emission: the fixture
 * profile is patched (emission flipped, entry made absolute) into the
 * build dir, then compiled through the real compileLibrary pipeline.
 * Memoized per (instance, emission) — the probe pairings reuse builds. */
const built = new Map<string, Promise<string>>();
function buildInstance(instance: "a" | "b", emission: Emission): Promise<string> {
  const key = `${instance}-${emission}`;
  let archive = built.get(key);
  if (archive === undefined) {
    archive = (async () => {
      const outDir = join(cacheDir, key);
      mkdirSync(outDir, { recursive: true });
      const profile = JSON.parse(readFileSync(join(fixtureDir, `profile_${instance}.json`), "utf8")) as {
        entry: string;
        emission: string;
      };
      profile.emission = emission;
      profile.entry = join(fixtureDir, profile.entry);
      const profilePath = join(outDir, "profile.json");
      writeFileSync(profilePath, JSON.stringify(profile, null, 2));
      const result = await compileLibrary({ profilePath, outDir, sanitize });
      if (!result.ok) {
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      }
      expect(result.backend).toBe(emission);
      return result.archivePath;
    })();
    built.set(key, archive);
  }
  return archive;
}

/** nm over an archive: [definedExternal, undefined] symbol sets, macOS/
 * Linux leading-underscore normalized away. */
function nmSymbols(archive: string): { defined: Set<string>; undef: Set<string> } {
  const parse = (out: string): Set<string> => {
    const set = new Set<string>();
    for (const line of out.split("\n")) {
      const sym = line.trim().split(/\s+/).pop();
      if (sym === undefined || sym === "" || sym.endsWith(":")) continue;
      set.add(sym.replace(/^_/, ""));
    }
    return set;
  };
  const defined = parse(execFileSync(nmTool!, ["-gU", archive], { encoding: "utf8" }));
  const undef = parse(execFileSync(nmTool!, ["-u", archive], { encoding: "utf8" }));
  return { defined, undef };
}

const A_SYMBOLS = ["ma_boom", "ma_bump", "ma_calls_seen", "ma_collect", "ma_init", "ma_set_panic_sink"];
const B_SYMBOLS = ["mb_add", "mb_collect", "mb_init", "mb_set_panic_sink", "mb_sum_to"];

const PROBE_EXPECTED = `multi-a ready
multi-b ready
a: bump(1) x200 -> 201, calls_seen 200, trap fell through 0
a sink: calls=1 ctx_ok=1 fields=3 code=[SC4014] symbol=[ma_boom] text_printable=1 addr_nonzero=1
b: concurrent sums_ok=1 adds_ok=1 reached_200=1
b: post-trap answers ok=1
b sink: calls=0
`;

/* ── M1: the localized archive's exact link surface ─────────────────────── */

describe.each(EMISSIONS)("localized archive symbols, %s emission", (emission) => {
  localizationTest("M1: external definitions equal the declared set exactly", async (ctx) => {
    if (nmTool === null) ctx.skip("no nm/llvm-nm on PATH for the symbol-exactness check");
    const [archiveA, archiveB] = await Promise.all([
      buildInstance("a", emission),
      buildInstance("b", emission),
    ]);
    for (const [archive, declared] of [
      [archiveA, A_SYMBOLS],
      [archiveB, B_SYMBOLS],
    ] as const) {
      const { defined, undef } = nmSymbols(archive);
      // The WHOLE defined set — a classic archive additionally defines
      // every runtime internal; a localized one defines nothing else.
      // ASan's image-wide registration guard is the sole sanitized
      // exception: keeping its COMMON shared makes the final image
      // register its ASan globals exactly once when N archives contribute
      // module constructors — Mach-O and ELF spell the same discipline
      // with one underscore of decoration between them.
      const toolchainDefinitions = sanitize
        ? [process.platform === "darwin" ? "___asan_globals_registered" : "__asan_globals_registered"]
        : [];
      expect([...defined].sort()).toEqual([...declared, ...toolchainDefinitions].sort());
      // Undefineds: no runtime-internal or prefix-carrying reference
      // escapes; target-runtime/system-API (and sanitizer ABI) references
      // keep their global binding.
      expect([...undef].filter((s) => s.startsWith("scr_") || s.startsWith("ma_") || s.startsWith("mb_"))).toEqual([]);
      // The ambient audit holds through the combine step: no
      // process-disposition or threading surface, no atexit teardown.
      for (const banned of ["sigaction", "signal", "pthread_create", "atexit", "setvbuf"]) {
        expect(undef.has(banned), `undefined reference to ${banned}`).toBe(false);
      }
    }
  });
});

/* ── M2: the two-instance, two-thread acceptance probe ──────────────────── */

function buildProbe(archiveA: string, archiveB: string, outDir: string, tag: string): string {
  const bin = join(outDir, `probe-${tag}${process.platform === "win32" ? ".exe" : ""}`);
  mkdirSync(outDir, { recursive: true });
  execFileSync(probeCc[0]!, [
    ...probeCc.slice(1),
    "-std=c11",
    "-pthread",
    ...(sanitize ? ["-fsanitize=address"] : []),
    join(fixtureDir, "probe.c"),
    archiveA,
    archiveB,
    "-lm",
    ...(process.platform === "win32" ? WIN32_EMBEDDER_LIBS : []),
    "-o", bin,
  ]);
  return bin;
}

const PAIRINGS: { tag: string; a: Emission; b: Emission }[] = [
  { tag: "llvm-llvm", a: "llvm", b: "llvm" },
  { tag: "c-c", a: "c", b: "c" },
  // Two embedder builds need not share a backend: one archive per emission
  // links and runs the same.
  { tag: "llvm-c", a: "llvm", b: "c" },
];

describe.each(PAIRINGS)("two instances, one process ($tag)", ({ tag, a, b }) => {
  localizationTest("M2: independent state and collects; a trap reaches only its own sink, once", async () => {
    const [archiveA, archiveB] = await Promise.all([buildInstance("a", a), buildInstance("b", b)]);
    const probe = buildProbe(archiveA, archiveB, join(cacheDir, "probes"), tag);
    const run = spawnSync(probe, { encoding: "utf8", timeout: 60_000 });
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(normalizeProbeOut(run.stdout)).toBe(PROBE_EXPECTED);
  });
});

/* ── M3: profile shape ───────────────────────────────────────────────────── */

test("M3: abi.localize_runtime is strictly boolean", () => {
  const dir = join(cacheDir, "profile-shape");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "profile.json");
  const base = {
    profile_format: 1,
    name: "shape",
    entry: "lib.ts",
    emission: "llvm",
    abi: {
      prefix: "sp_",
      init_symbol: "sp_init",
      sink_register_symbol: "sp_set_panic_sink",
      collect_symbol: null,
      result_reset_symbol: null,
      localize_runtime: "yes",
    },
    exports: [],
  };
  for (const invalid of ["yes", null] as const) {
    writeFileSync(path, JSON.stringify({
      ...base,
      abi: { ...base.abi, localize_runtime: invalid },
    }));
    const refused = loadLibraryProfile(path);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.diagnostics[0]!.code).toBe("SC4001");
      expect(refused.diagnostics[0]!.message).toContain("abi.localize_runtime");
    }
  }
  // The boolean forms load, and absence means false.
  for (const [value, expected] of [[true, true], [false, false], [undefined, false]] as const) {
    const abi: Record<string, unknown> = { ...base.abi };
    if (value === undefined) delete abi["localize_runtime"];
    else abi["localize_runtime"] = value;
    writeFileSync(path, JSON.stringify({ ...base, abi }));
    const loaded = loadLibraryProfile(path);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.profile.localizeRuntime).toBe(expected);
  }
});

/* ── M4: host-native posture ─────────────────────────────────────────────── */

test("M4: a macos cross target refuses runtime localization off a darwin host with SC3002", async () => {
  const outDir = join(cacheDir, "cross-refusal");
  mkdirSync(outDir, { recursive: true });
  const profile = JSON.parse(readFileSync(join(fixtureDir, "profile_a.json"), "utf8")) as {
    entry: string;
  };
  profile.entry = join(fixtureDir, profile.entry);
  const profilePath = join(outDir, "profile.json");
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  // compileLibrary reads SCRIPTC_CC/SCRIPTC_TARGET at call time; the
  // refusal fires before any toolchain runs, so zig need not exist here.
  // Mach-O localization runs the macOS host linker, so a macos target is
  // exactly the pairing a non-darwin host still refuses.
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const prevCc = process.env["SCRIPTC_CC"];
  const prevTarget = process.env["SCRIPTC_TARGET"];
  process.env["SCRIPTC_CC"] = "zigcc";
  process.env["SCRIPTC_TARGET"] = "x86_64-macos";
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
  try {
    const result = await compileLibrary({ profilePath, outDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]!.code).toBe("SC3002");
      expect(result.diagnostics[0]!.message).toContain("x86_64-macos");
      expect(result.diagnostics[0]!.message).toContain("runtime-localized");
      expect(result.diagnostics[0]!.message).toContain("linux hosts");
    }
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    if (prevCc === undefined) delete process.env["SCRIPTC_CC"];
    else process.env["SCRIPTC_CC"] = prevCc;
    if (prevTarget === undefined) delete process.env["SCRIPTC_TARGET"];
    else process.env["SCRIPTC_TARGET"] = prevTarget;
  }
});

test.each([
  ["aarch64-windows-gnu", "COFF localization currently requires x86_64"],
  ["x86-linux-gnu", "cross-ELF localization currently requires x86_64 or aarch64"],
] as const)(
  "M4: unsupported localization object class %s refuses before emission with SC3002",
  async (target, reason) => {
    const outDir = join(cacheDir, `object-class-refusal-${target}`);
    mkdirSync(outDir, { recursive: true });
    const profile = JSON.parse(readFileSync(join(fixtureDir, "profile_a.json"), "utf8")) as {
      entry: string;
    };
    profile.entry = join(fixtureDir, profile.entry);
    const profilePath = join(outDir, "profile.json");
    writeFileSync(profilePath, JSON.stringify(profile, null, 2));
    const prevCc = process.env["SCRIPTC_CC"];
    const prevTarget = process.env["SCRIPTC_TARGET"];
    process.env["SCRIPTC_CC"] = "zigcc";
    process.env["SCRIPTC_TARGET"] = target;
    try {
      const result = await compileLibrary({ profilePath, outDir });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics[0]!.code).toBe("SC3002");
        expect(result.diagnostics[0]!.message).toContain(target);
        expect(result.diagnostics[0]!.message).toContain(reason);
      }
    } finally {
      if (prevCc === undefined) delete process.env["SCRIPTC_CC"];
      else process.env["SCRIPTC_CC"] = prevCc;
      if (prevTarget === undefined) delete process.env["SCRIPTC_TARGET"];
      else process.env["SCRIPTC_TARGET"] = prevTarget;
    }
  },
);

test("M4: an unsupported native host refuses runtime localization with SC3002", async () => {
  const outDir = join(cacheDir, "native-refusal");
  mkdirSync(outDir, { recursive: true });
  const profile = JSON.parse(readFileSync(join(fixtureDir, "profile_a.json"), "utf8")) as {
    entry: string;
  };
  profile.entry = join(fixtureDir, profile.entry);
  const profilePath = join(outDir, "profile.json");
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const prevCc = process.env["SCRIPTC_CC"];
  const prevTarget = process.env["SCRIPTC_TARGET"];
  delete process.env["SCRIPTC_CC"];
  delete process.env["SCRIPTC_TARGET"];
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "freebsd" });
  try {
    const result = await compileLibrary({ profilePath, outDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]!.code).toBe("SC3002");
      expect(result.diagnostics[0]!.message).toContain("freebsd");
      expect(result.diagnostics[0]!.message).toContain("runtime-localized");
    }
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    if (prevCc === undefined) delete process.env["SCRIPTC_CC"];
    else process.env["SCRIPTC_CC"] = prevCc;
    if (prevTarget === undefined) delete process.env["SCRIPTC_TARGET"];
    else process.env["SCRIPTC_TARGET"] = prevTarget;
  }
});

/* ── M5: caller-visible archive publication ─────────────────────────────── */

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "M5: localization archives privately before atomically installing the caller-visible output",
  async () => {
    const outDir = join(cacheDir, "atomic-publication");
    const binDir = join(outDir, "bin");
    const outPath = join(outDir, "localized.lib.a");
    mkdirSync(binDir, { recursive: true });
    const profile = JSON.parse(readFileSync(join(fixtureDir, "profile_a.json"), "utf8")) as {
      entry: string;
    };
    profile.entry = join(fixtureDir, profile.entry);
    const profilePath = join(outDir, "profile.json");
    writeFileSync(profilePath, JSON.stringify(profile, null, 2));

    const oldPath = process.env["PATH"];
    const oldCc = process.env["SCRIPTC_CC"];
    const oldTarget = process.env["SCRIPTC_TARGET"];
    const oldRealAr = process.env["SCRIPTC_TEST_REAL_AR"];
    const oldForbiddenOutput = process.env["SCRIPTC_TEST_FORBIDDEN_ARCHIVE_OUTPUT"];
    const originalAr = (oldPath ?? "")
      .split(delimiter)
      .map((entry) => join(entry === "" ? process.cwd() : entry, "ar"))
      .find((candidate) => existsSync(candidate));
    expect(originalAr).toBeDefined();

    const wrapper = join(binDir, "ar");
    writeFileSync(
      wrapper,
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "$SCRIPTC_TEST_FORBIDDEN_ARCHIVE_OUTPUT" ]; then
    echo "archiver received caller-visible output" >&2
    exit 97
  fi
done
exec "$SCRIPTC_TEST_REAL_AR" "$@"
`,
    );
    chmodSync(wrapper, 0o755);

    process.env["PATH"] = `${binDir}${delimiter}${oldPath ?? ""}`;
    process.env["SCRIPTC_TEST_REAL_AR"] = originalAr!;
    process.env["SCRIPTC_TEST_FORBIDDEN_ARCHIVE_OUTPUT"] = outPath;
    delete process.env["SCRIPTC_CC"];
    delete process.env["SCRIPTC_TARGET"];
    try {
      const result = await compileLibrary({ profilePath, outDir, outPath, sanitize });
      expect(result.ok, result.ok ? undefined : result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")).toBe(true);
      expect(existsSync(outPath)).toBe(true);
    } finally {
      if (oldPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = oldPath;
      if (oldCc === undefined) delete process.env["SCRIPTC_CC"];
      else process.env["SCRIPTC_CC"] = oldCc;
      if (oldTarget === undefined) delete process.env["SCRIPTC_TARGET"];
      else process.env["SCRIPTC_TARGET"] = oldTarget;
      if (oldRealAr === undefined) delete process.env["SCRIPTC_TEST_REAL_AR"];
      else process.env["SCRIPTC_TEST_REAL_AR"] = oldRealAr;
      if (oldForbiddenOutput === undefined) delete process.env["SCRIPTC_TEST_FORBIDDEN_ARCHIVE_OUTPUT"];
      else process.env["SCRIPTC_TEST_FORBIDDEN_ARCHIVE_OUTPUT"] = oldForbiddenOutput;
    }
  },
);

/* ── M6/M7/M8: thread-instanced state (abi.instance_per_thread) ──────────── */

const threadFixtureDir = join(repoRoot, "tests/library-mode/thread-instances");

/** Build the thread-instances fixture's archive for one emission: same
 * patch-and-compile shape as buildInstance, plus abi overrides (M7 turns
 * localize_runtime on) and an explicit sanitize override (M8's ASan
 * pairing inside the plain flavor). Memoized like buildInstance. */
function buildThreaded(
  emission: Emission,
  opts: { localize?: boolean; sanitize?: boolean } = {},
): Promise<string> {
  const sanitized = opts.sanitize ?? sanitize;
  const key = `t-${emission}${opts.localize === true ? "-loc" : ""}${sanitized ? "-san" : ""}`;
  let archive = built.get(key);
  if (archive === undefined) {
    archive = (async () => {
      const outDir = join(cacheDir, key);
      mkdirSync(outDir, { recursive: true });
      const profile = JSON.parse(readFileSync(join(threadFixtureDir, "profile_t.json"), "utf8")) as {
        entry: string;
        emission: string;
        abi: Record<string, unknown>;
      };
      profile.emission = emission;
      profile.entry = join(threadFixtureDir, profile.entry);
      if (opts.localize === true) profile.abi["localize_runtime"] = true;
      const profilePath = join(outDir, "profile.json");
      writeFileSync(profilePath, JSON.stringify(profile, null, 2));
      const result = await compileLibrary({ profilePath, outDir, sanitize: sanitized });
      if (!result.ok) {
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      }
      expect(result.backend).toBe(emission);
      return result.archivePath;
    })();
    built.set(key, archive);
  }
  return archive;
}

function buildThreadProbe(
  source: string,
  archives: string[],
  tag: string,
  opts: { sanitize?: boolean } = {},
): string {
  const outDir = join(cacheDir, "probes");
  const bin = join(outDir, `probe-${tag}${process.platform === "win32" ? ".exe" : ""}`);
  mkdirSync(outDir, { recursive: true });
  execFileSync(probeCc[0]!, [
    ...probeCc.slice(1),
    "-std=c11",
    "-pthread",
    ...((opts.sanitize ?? sanitize) ? ["-fsanitize=address"] : []),
    source,
    ...archives,
    "-lm",
    ...(process.platform === "win32" ? WIN32_EMBEDDER_LIBS : []),
    "-o", bin,
  ]);
  return bin;
}

const THREADED_EXPECTED = `t0: bump x100 -> 101, calls_seen 100, sums_ok=1, clocks_ok=1, index_ok=1, trap fell through 0
t0 sink: calls=1 ctx_ok=1 fields=3 code=[SC4014] symbol=[mt_boom] addr_nonzero=1
t1: bump x150 -> 151, calls_seen 150, sums_ok=1, clocks_ok=1, index_ok=1, post_ok=1
t2: bump x200 -> 201, calls_seen 200, sums_ok=1, clocks_ok=1, index_ok=1, post_ok=1
t3: bump x250 -> 251, calls_seen 250, sums_ok=1, clocks_ok=1, index_ok=1, post_ok=1
survivor sinks: 0 0 0
`;

describe.each(EMISSIONS)("thread-instanced archive, %s emission", (emission) => {
  localizationTest("M6: four threads, one archive: independent instances; a trap reaches only its own thread's sink, once", async () => {
    const archive = await buildThreaded(emission);
    const probe = buildThreadProbe(join(threadFixtureDir, "probe.c"), [archive], `t-${emission}`);
    const run = spawnSync(probe, { encoding: "utf8", timeout: 60_000 });
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(normalizeProbeOut(run.stdout)).toBe(THREADED_EXPECTED);
  });
});

/* The inspect-TLS probe's dead-strip technique (function/data sections +
 * gc-sections over deliberately-unresolved runtime references) is an
 * ELF/Mach-O link idiom; win32 hosts cover the seam through M6's archive
 * probes. */
const inspectTlsTest =
  process.platform === "darwin" || process.platform === "linux" ? test : test.skip;
inspectTlsTest("M6: util.inspect circular-reference state is thread-local", () => {
  const outDir = join(cacheDir, "inspect-tls-probe");
  const bin = join(outDir, "probe");
  mkdirSync(outDir, { recursive: true });
  execFileSync("clang", [
    "-std=c11",
    "-pthread",
    "-DSCR_LIB",
    "-DSCR_THREAD_INSTANCES",
    "-ffunction-sections",
    "-fdata-sections",
    "-Wno-comment",
    ...(sanitize ? ["-fsanitize=address"] : []),
    "-I", join(repoRoot, "packages/runtime/src"),
    join(threadFixtureDir, "probe_inspect.c"),
    join(repoRoot, "packages/runtime/src/scr_inspect.c"),
    process.platform === "darwin" ? "-Wl,-dead_strip" : "-Wl,--gc-sections",
    "-o", bin,
  ]);
  const env =
    sanitize && process.platform === "linux"
      ? { ...process.env, ASAN_OPTIONS: "detect_leaks=0" }
      : process.env;
  const run = spawnSync(bin, { encoding: "utf8", timeout: 60_000, env });
  expect(run.signal).toBeNull();
  expect(run.status).toBe(0);
  expect(run.stdout).toBe("1 1 1\n");
});

localizationTest("M7: thread-instanced and runtime-localized archives compose in one process", async (ctx) => {
  if (nmTool === null) ctx.skip("no nm/llvm-nm on PATH for the symbol-exactness check");
  const [archiveT, archiveB] = await Promise.all([
    buildThreaded("llvm", { localize: true }),
    buildInstance("b", "c"),
  ]);
  // The composed archive's link surface stays exactly the declared set:
  // thread-local storage adds no external definitions (M1's one Darwin
  // ASan image-registration common included in a sanitized build), and the
  // TLS access machinery undefineds are the platform runtime's, never
  // scriptc's.
  const { defined, undef } = nmSymbols(archiveT);
  const toolchainDefinitions = sanitize
    ? [process.platform === "darwin" ? "___asan_globals_registered" : "__asan_globals_registered"]
    : [];
  expect([...defined].sort()).toEqual(
    [
      "mt_boom", "mt_bump", "mt_calls_seen", "mt_collect", "mt_indexed_unicode", "mt_init", "mt_perf_now", "mt_set_panic_sink", "mt_sum_to", "mt_uptime",
      ...toolchainDefinitions,
    ].sort(),
  );
  expect([...undef].filter((s) => s.startsWith("scr_") || s.startsWith("mt_") || s.startsWith("mb_"))).toEqual([]);
  const probe = buildThreadProbe(join(threadFixtureDir, "probe_pair.c"), [archiveT, archiveB], "t-pair");
  const run = spawnSync(probe, { encoding: "utf8", timeout: 60_000 });
  expect(run.signal).toBeNull();
  expect(run.status).toBe(0);
  expect(normalizeProbeOut(run.stdout)).toBe(`multi-b ready
t0: bump x100 -> 101, calls_seen 100, sums_ok=1, index_ok=1, trap fell through 0
t0 sink: calls=1 ctx_ok=1 code=[SC4014] symbol=[mt_boom]
t1: bump x200 -> 201, calls_seen 200, sums_ok=1, index_ok=1, post_ok=1
b: sums_ok=1 adds_ok=1 post_ok=1
other sinks: t1=0 b=0
`);
});

/* ASan has no x86_64-windows-gnu runtime; the sanitized pairing stays a
 * darwin/linux contract. */
const asanTest = process.platform === "darwin" || process.platform === "linux" ? test : test.skip;
asanTest("M8: M6 under ASan", async () => {
  const archive = await buildThreaded("llvm", { sanitize: true });
  const probe = buildThreadProbe(join(threadFixtureDir, "probe.c"), [archive], "t-asan", { sanitize: true });
  // An instance's lifetime is its thread's, with no teardown at thread
  // exit (the documented contract) — once the worker threads end, their
  // thread-local roots are gone and Linux LSan's unreachable-at-exit
  // accounting would flag contractually-held state. Point it away exactly
  // as the sanitized suite lanes do; Apple ASan carries no leak checker.
  const env =
    process.platform === "linux" ? { ...process.env, ASAN_OPTIONS: "detect_leaks=0" } : process.env;
  const run = spawnSync(probe, { encoding: "utf8", timeout: 120_000, env });
  expect(run.signal).toBeNull();
  expect(run.status).toBe(0);
  expect(run.stdout).toBe(THREADED_EXPECTED);
});

/* ── M9: profile shape ───────────────────────────────────────────────────── */

test("M9: abi.instance_per_thread is strictly boolean", () => {
  const dir = join(cacheDir, "profile-shape-thread");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "profile.json");
  const base = {
    profile_format: 1,
    name: "shape",
    entry: "lib.ts",
    emission: "llvm",
    abi: {
      prefix: "sp_",
      init_symbol: "sp_init",
      sink_register_symbol: "sp_set_panic_sink",
      collect_symbol: null,
      result_reset_symbol: null,
    },
    exports: [],
  };
  for (const invalid of [1, "yes", null] as const) {
    writeFileSync(path, JSON.stringify({
      ...base,
      abi: { ...base.abi, instance_per_thread: invalid },
    }));
    const refused = loadLibraryProfile(path);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.diagnostics[0]!.code).toBe("SC4001");
      expect(refused.diagnostics[0]!.message).toContain("abi.instance_per_thread");
    }
  }
  // The boolean forms load, and absence means false.
  for (const [value, expected] of [[true, true], [false, false], [undefined, false]] as const) {
    const abi: Record<string, unknown> = { ...base.abi };
    if (value !== undefined) abi["instance_per_thread"] = value;
    writeFileSync(path, JSON.stringify({ ...base, abi }));
    const loaded = loadLibraryProfile(path);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.profile.instancePerThread).toBe(expected);
  }
});

/* ── M10/M11: cross-target localization (SCRIPTC_CROSS=1) ─────────────────
 * Gated exactly like library-cross.test.ts: zig on PATH is the lane's hard
 * requirement, execution legs additionally gate on the docker daemon
 * (SCRIPTC_LINUX=1) and the ssh box (SCRIPTC_WIN=1). Never part of the
 * default suites. */

const crossOn = process.env["SCRIPTC_CROSS"] === "1";

/* The embedder-relevant cross list (library-cross's, minus the macos
 * triple off darwin hosts — Mach-O localization runs the macOS host
 * linker, and M4 pins that refusal). */
const CROSS_TARGETS = [
  "aarch64-linux-gnu.2.36",
  "x86_64-linux-gnu.2.36",
  "aarch64-linux-musl",
  "x86_64-linux-musl",
  "x86_64-windows-gnu",
  ...(process.platform === "darwin" ? (["x86_64-macos"] as const) : []),
] as const;
type CrossTarget = (typeof CROSS_TARGETS)[number];

/** buildInstance with SCRIPTC_CC/SCRIPTC_TARGET threaded through the env
 * the cc driver reads (the library-cross pattern — tests in this file run
 * sequentially and every build is awaited, so the flips never interleave).
 * Cross builds are plain-flavor: the sanitized lanes stay host contracts. */
function buildInstanceCross(
  instance: "a" | "b",
  emission: Emission,
  target: CrossTarget | MobileTarget,
): Promise<string> {
  const key = `x-${instance}-${emission}-${target}`;
  let archive = built.get(key);
  if (archive === undefined) {
    archive = (async () => {
      const outDir = join(cacheDir, key);
      mkdirSync(outDir, { recursive: true });
      const profile = JSON.parse(readFileSync(join(fixtureDir, `profile_${instance}.json`), "utf8")) as {
        entry: string;
        emission: string;
      };
      profile.emission = emission;
      profile.entry = join(fixtureDir, profile.entry);
      const profilePath = join(outDir, "profile.json");
      writeFileSync(profilePath, JSON.stringify(profile, null, 2));
      const prevCc = process.env["SCRIPTC_CC"];
      const prevTarget = process.env["SCRIPTC_TARGET"];
      process.env["SCRIPTC_CC"] = "zigcc";
      process.env["SCRIPTC_TARGET"] = target;
      try {
        const result = await compileLibrary({ profilePath, outDir });
        if (!result.ok) {
          throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
        }
        expect(result.backend).toBe(emission);
        return result.archivePath;
      } finally {
        if (prevCc === undefined) delete process.env["SCRIPTC_CC"];
        else process.env["SCRIPTC_CC"] = prevCc;
        if (prevTarget === undefined) delete process.env["SCRIPTC_TARGET"];
        else process.env["SCRIPTC_TARGET"] = prevTarget;
      }
    })();
    built.set(key, archive);
  }
  return archive;
}

/** Cross-link the two-archive probe with `zig cc` — the target's libc/libm
 * plus the documented win32 embedder libs. Link success is itself an
 * assertion: every undefined in the localized member resolved against
 * exactly what an embedder links. */
function buildCrossProbe(archives: string[], source: string, tag: string, target: CrossTarget): string {
  const outDir = join(cacheDir, "probes");
  mkdirSync(outDir, { recursive: true });
  const bin = join(outDir, `probe-${tag}${target.includes("windows") ? ".exe" : ""}`);
  execFileSync("zig", [
    "cc",
    "-std=c11",
    "-target", target,
    "-pthread",
    source,
    ...archives,
    "-lm",
    ...(target.includes("windows") ? WIN32_EMBEDDER_LIBS : []),
    "-o", bin,
  ]);
  return bin;
}

describe.skipIf(!crossOn)("cross-target localization", () => {
  test("zig is on PATH", () => {
    try {
      execFileSync("zig", ["version"], { encoding: "utf8" });
    } catch {
      throw new Error("SCRIPTC_CROSS=1 needs zig on PATH (zigup) — the lane cross-compiles with `zig cc`.");
    }
  });

  describe.each(CROSS_TARGETS)("target %s", (target) => {
    describe.each(EMISSIONS)("%s emission", (emission) => {
      test("M10: localized archives cross-build; symbols exact, ambient audit holds, probe links", async () => {
        const archiveA = await buildInstanceCross("a", emission, target);
        const archiveB = await buildInstanceCross("b", emission, target);
        for (const [archive, declared] of [
          [archiveA, A_SYMBOLS],
          [archiveB, B_SYMBOLS],
        ] as const) {
          const { defined, undef } = nmSymbols(archive);
          expect([...defined].sort()).toEqual([...declared].sort());
          expect([...undef].filter((s) => s.startsWith("scr_") || s.startsWith("ma_") || s.startsWith("mb_"))).toEqual([]);
          for (const banned of ["sigaction", "signal", "pthread_create", "atexit", "setvbuf"]) {
            for (const spelling of [banned, `_imp_${banned}`]) {
              expect(undef.has(spelling), `undefined reference to ${spelling}`).toBe(false);
            }
          }
        }
        buildCrossProbe([archiveA, archiveB], join(fixtureDir, "probe.c"), `x-${emission}-${target}`, target);
      });
    });
  });

  /* ── M11: execution where infrastructure exists ─────────────────────── */
  describe("M11 execution probes", () => {
    const linuxOn = process.env["SCRIPTC_LINUX"] === "1";
    const winOn = process.env["SCRIPTC_WIN"] === "1";
    const nodeVersion = (): string => readFileSync(join(repoRoot, ".node-version"), "utf8").trim();

    test.skipIf(!linuxOn).for([
      ["aarch64-linux-gnu.2.36", "llvm"],
      ["x86_64-linux-gnu.2.36", "llvm"],
      ["x86_64-linux-gnu.2.36", "c"],
      ["aarch64-linux-musl", "llvm"],
      ["x86_64-linux-musl", "llvm"],
    ] as const)(
      "M11: the two-instance probe runs in the container (%s, %s emission)",
      async ([target, emission]) => {
        const archiveA = await buildInstanceCross("a", emission, target);
        const archiveB = await buildInstanceCross("b", emission, target);
        const probe = buildCrossProbe(
          [archiveA, archiveB],
          join(fixtureDir, "probe.c"),
          `x-run-${emission}-${target}`,
          target,
        );
        const distro = target.includes("linux-musl") ? "alpine" : "bookworm";
        const out = execFileSync(
          "docker",
          [
            "run", "--rm",
            "--platform", target.startsWith("x86_64") ? "linux/amd64" : "linux/arm64",
            "-v", `${repoRoot}:${repoRoot}`,
            `node:${nodeVersion()}-${distro}`,
            probe,
          ],
          { encoding: "utf8", timeout: 240_000 },
        );
        expect(out).toBe(PROBE_EXPECTED);
      },
      300_000,
    );

    test.skipIf(!winOn).for(EMISSIONS)(
      "M11: the two-instance probe runs on the Windows box (%s emission)",
      async (emission) => {
        const host = process.env["SCRIPTC_WIN_HOST"] ?? "windows-dev";
        const dirWin = "C:\\Users\\rdp\\work\\scriptc-mloc-lane";
        const archiveA = await buildInstanceCross("a", emission, "x86_64-windows-gnu");
        const archiveB = await buildInstanceCross("b", emission, "x86_64-windows-gnu");
        const probe = buildCrossProbe(
          [archiveA, archiveB],
          join(fixtureDir, "probe.c"),
          `x-run-${emission}-win`,
          "x86_64-windows-gnu",
        );
        const ssh = (cmd: string): string =>
          execFileSync("ssh", ["-o", "ConnectTimeout=15", host, cmd], { encoding: "utf8", timeout: 120_000 });
        try {
          ssh(`cmd /c if not exist ${dirWin} mkdir ${dirWin}`);
          execFileSync("scp", ["-q", probe, `${host}:C:/Users/rdp/work/scriptc-mloc-lane/probe-${emission}.exe`], {
            timeout: 120_000,
          });
          const out = ssh(`cd /d ${dirWin} && probe-${emission}.exe`);
          // The PROBE's printf rides the mingw CRT's text-mode stdout
          // (CRLF) — the library-cross windows leg's one normalization.
          expect(out.replaceAll("\r\n", "\n")).toBe(PROBE_EXPECTED);
        } finally {
          try {
            ssh(`cmd /c rmdir /S /Q ${dirWin}`);
          } catch {
            /* cleanup is best-effort — never mask the real failure */
          }
        }
      },
      300_000,
    );

    test.skipIf(!winOn)(
      "M11: a thread-instanced and runtime-localized archive runs on the Windows box",
      async () => {
        const host = process.env["SCRIPTC_WIN_HOST"] ?? "windows-dev";
        const dirWin = "C:\\Users\\rdp\\work\\scriptc-mloc-lane-t";
        const key = "x-t-llvm-win";
        let archive = built.get(key);
        if (archive === undefined) {
          archive = (async () => {
            const outDir = join(cacheDir, key);
            mkdirSync(outDir, { recursive: true });
            const profile = JSON.parse(readFileSync(join(threadFixtureDir, "profile_t.json"), "utf8")) as {
              entry: string;
              emission: string;
              abi: Record<string, unknown>;
            };
            profile.emission = "llvm";
            profile.entry = join(threadFixtureDir, profile.entry);
            profile.abi["localize_runtime"] = true;
            const profilePath = join(outDir, "profile.json");
            writeFileSync(profilePath, JSON.stringify(profile, null, 2));
            const prevCc = process.env["SCRIPTC_CC"];
            const prevTarget = process.env["SCRIPTC_TARGET"];
            process.env["SCRIPTC_CC"] = "zigcc";
            process.env["SCRIPTC_TARGET"] = "x86_64-windows-gnu";
            try {
              const result = await compileLibrary({ profilePath, outDir });
              if (!result.ok) {
                throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
              }
              return result.archivePath;
            } finally {
              if (prevCc === undefined) delete process.env["SCRIPTC_CC"];
              else process.env["SCRIPTC_CC"] = prevCc;
              if (prevTarget === undefined) delete process.env["SCRIPTC_TARGET"];
              else process.env["SCRIPTC_TARGET"] = prevTarget;
            }
          })();
          built.set(key, archive);
        }
        const probe = buildCrossProbe(
          [await archive],
          join(threadFixtureDir, "probe.c"),
          "x-run-t-win",
          "x86_64-windows-gnu",
        );
        const ssh = (cmd: string): string =>
          execFileSync("ssh", ["-o", "ConnectTimeout=15", host, cmd], { encoding: "utf8", timeout: 120_000 });
        try {
          ssh(`cmd /c if not exist ${dirWin} mkdir ${dirWin}`);
          execFileSync("scp", ["-q", probe, `${host}:C:/Users/rdp/work/scriptc-mloc-lane-t/probe-t.exe`], {
            timeout: 120_000,
          });
          const out = ssh(`cd /d ${dirWin} && probe-t.exe`);
          expect(out.replaceAll("\r\n", "\n")).toBe(THREADED_EXPECTED);
        } finally {
          try {
            ssh(`cmd /c rmdir /S /Q ${dirWin}`);
          } catch {
            /* cleanup is best-effort — never mask the real failure */
          }
        }
      },
      300_000,
    );
  });
});

/* ── M12–M14: mobile library targets ──────────────────────────────────────
 * M12 runs everywhere (pure admission shape, no toolchain). The executed
 * lanes are env-gated like M10/M11: SCRIPTC_IOS=1 needs a darwin host with
 * Xcode's iPhoneOS/iPhoneSimulator SDKs, zig, and a bootable simulator;
 * SCRIPTC_ANDROID=1 needs an NDK plus adb (a running emulator/device is
 * reused; otherwise a headless arm64 AVD is created and booted). Mobile
 * builds are plain-flavor: the sanitized lanes stay host contracts. */

const MOBILE_TARGETS = [
  "aarch64-apple-ios",
  "aarch64-apple-ios-simulator",
  "aarch64-linux-android",
] as const;
type MobileTarget = (typeof MOBILE_TARGETS)[number];

const iosOn = process.env["SCRIPTC_IOS"] === "1";
const androidOn = process.env["SCRIPTC_ANDROID"] === "1";

/** Run a fixture build with SCRIPTC_CC/SCRIPTC_TARGET threaded through the
 * env the cc driver reads (the buildInstanceCross pattern, for arbitrary
 * fixture profiles). */
async function withMobileTarget<T>(target: string, body: () => Promise<T>): Promise<T> {
  const prevCc = process.env["SCRIPTC_CC"];
  const prevTarget = process.env["SCRIPTC_TARGET"];
  process.env["SCRIPTC_CC"] = "zigcc";
  process.env["SCRIPTC_TARGET"] = target;
  try {
    return await body();
  } finally {
    if (prevCc === undefined) delete process.env["SCRIPTC_CC"];
    else process.env["SCRIPTC_CC"] = prevCc;
    if (prevTarget === undefined) delete process.env["SCRIPTC_TARGET"];
    else process.env["SCRIPTC_TARGET"] = prevTarget;
  }
}

/* ── M12: admission (always runs — no toolchain, no SDKs) ────────────────── */

test("M12: an iOS target refuses library builds off a darwin host with SC3002", async () => {
  const outDir = join(cacheDir, "mobile-host-refusal");
  mkdirSync(outDir, { recursive: true });
  const profile = JSON.parse(readFileSync(join(fixtureDir, "profile_a.json"), "utf8")) as {
    entry: string;
  };
  profile.entry = join(fixtureDir, profile.entry);
  const profilePath = join(outDir, "profile.json");
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  // The refusal is a pure env/host check that fires before any toolchain
  // discovery, so neither zig nor an SDK need exist here.
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
  try {
    await withMobileTarget("aarch64-apple-ios", async () => {
      const result = await compileLibrary({ profilePath, outDir });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics[0]!.code).toBe("SC3002");
        expect(result.diagnostics[0]!.message).toContain("aarch64-apple-ios");
        expect(result.diagnostics[0]!.message).toContain("macOS hosts");
      }
    });
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
});

test.each(["aarch64-ios", "x86_64-linux-android", "armv7-linux-androideabi"])(
  "M12: near-miss mobile triple %s refuses with the supported set named",
  async (target) => {
    const outDir = join(cacheDir, `mobile-spelling-refusal-${target}`);
    mkdirSync(outDir, { recursive: true });
    const profile = JSON.parse(readFileSync(join(fixtureDir, "profile_a.json"), "utf8")) as {
      entry: string;
    };
    profile.entry = join(fixtureDir, profile.entry);
    const profilePath = join(outDir, "profile.json");
    writeFileSync(profilePath, JSON.stringify(profile, null, 2));
    await withMobileTarget(target, async () => {
      const result = await compileLibrary({ profilePath, outDir });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics[0]!.code).toBe("SC3002");
        expect(result.diagnostics[0]!.message).toContain(target);
        for (const supported of MOBILE_TARGETS) {
          expect(result.diagnostics[0]!.message).toContain(supported);
        }
      }
    });
  },
);

test.each(MOBILE_TARGETS)(
  "M12: the executable lane refuses %s with the pointer to --lib",
  async (target) => {
    const outDir = join(cacheDir, `mobile-exe-refusal-${target}`);
    mkdirSync(outDir, { recursive: true });
    const entry = join(outDir, "main.ts");
    writeFileSync(entry, 'console.log("hi");\n');
    await withMobileTarget(target, async () => {
      const result = await compile(entry, { outDir, outPath: join(outDir, "main") });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics[0]!.code).toBe("SC3002");
        expect(result.diagnostics[0]!.message).toContain(target);
        expect(result.diagnostics[0]!.message).toContain("SCRIPTC_CC=zigcc scriptc build --lib --profile <profile.json>");
      }
    });
  },
);

test.each([
  ["arm64-v8a,armeabi-v7a", "26", true],
  ["arm64-v8a", "35", true],
  ["x86_64,x86", "35", false],
  ["arm64-v8a", "25", false],
  ["arm64-v8a", "not-an-api", false],
] as const)(
  "M12: Android device compatibility filters ABI %s at API %s",
  (abiList, sdkLevel, expected) => {
    expect(isCompatibleAndroidDevice(abiList, sdkLevel)).toBe(expected);
  },
);

test("M12: Android emulator port claims skip live serials and do not collide", () => {
  let first: AndroidPortClaim | null = null;
  let second: AndroidPortClaim | null = null;
  try {
    first = claimAndroidLanePort([`emulator-${ANDROID_PORT_MIN}`]);
    second = claimAndroidLanePort([`emulator-${ANDROID_PORT_MIN}`]);
    expect(first.port).not.toBe(ANDROID_PORT_MIN);
    expect(second.port).not.toBe(ANDROID_PORT_MIN);
    expect(second.port).not.toBe(first.port);
  } finally {
    if (second !== null) releaseAndroidLanePort(second);
    if (first !== null) releaseAndroidLanePort(first);
  }
});

/* ── M13: iOS (SCRIPTC_IOS=1) ─────────────────────────────────────────────── */

const APPLE_MOBILE_TARGETS = ["aarch64-apple-ios", "aarch64-apple-ios-simulator"] as const;

function appleSdkName(target: string): "iphoneos" | "iphonesimulator" {
  return target === "aarch64-apple-ios" ? "iphoneos" : "iphonesimulator";
}

/** Link a probe against iOS archives with the host Xcode clang — exactly
 * what an embedder's Xcode build performs. Link success asserts every
 * undefined in the localized member resolves against the selected SDK. */
function buildAppleProbe(archives: string[], source: string, tag: string, target: string): string {
  const outDir = join(cacheDir, "probes");
  mkdirSync(outDir, { recursive: true });
  const bin = join(outDir, `probe-${tag}`);
  const clangTarget = `arm64-apple-ios${IPHONEOS_MIN_VERSION}${target === "aarch64-apple-ios" ? "" : "-simulator"}`;
  execFileSync("xcrun", [
    "--sdk", appleSdkName(target),
    "clang",
    "-std=c11",
    "-pthread",
    "-target", clangTarget,
    source,
    ...archives,
    "-lm",
    "-o", bin,
  ]);
  return bin;
}

/** The booted simulator the execution legs share: an already-booted device
 * is reused; otherwise the first available iPhone boots headlessly and the
 * suite shuts it down again. */
let bootedSimulator: { udid: string; bootedByUs: boolean } | null = null;
type SimulatorDevice = { udid: string; state: string; name: string };
type SimulatorListing = { devices: Record<string, SimulatorDevice[]> };

function availableIphoneSimulators(listing: SimulatorListing): SimulatorDevice[] {
  return Object.entries(listing.devices)
    .filter(([runtime]) => runtime.includes(".SimRuntime.iOS-"))
    .flatMap(([, devices]) => devices)
    .filter((device) => device.name.startsWith("iPhone"));
}

test("M12: simulator reuse ignores booted devices from non-iOS runtimes", () => {
  const devices = availableIphoneSimulators({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.tvOS-26-0": [
        { udid: "tv", state: "Booted", name: "Apple TV" },
      ],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
        { udid: "phone", state: "Shutdown", name: "iPhone 17" },
        { udid: "tablet", state: "Booted", name: "iPad Pro" },
      ],
    },
  });
  expect(devices.map((device) => device.udid)).toEqual(["phone"]);
});

function shutdownOwnedSimulator(): void {
  if (bootedSimulator?.bootedByUs !== true) return;
  const owned = bootedSimulator;
  bootedSimulator = null;
  try {
    execFileSync("xcrun", ["simctl", "shutdown", owned.udid]);
  } catch {
    /* shutdown is best-effort — never mask a real failure */
  }
}

function ensureBootedSimulator(): string {
  if (bootedSimulator !== null) return bootedSimulator.udid;
  const listing = JSON.parse(
    execFileSync("xcrun", ["simctl", "list", "devices", "available", "--json"], { encoding: "utf8" }),
  ) as SimulatorListing;
  const devices = availableIphoneSimulators(listing);
  const booted = devices.find((device) => device.state === "Booted");
  if (booted !== undefined) {
    bootedSimulator = { udid: booted.udid, bootedByUs: false };
    return booted.udid;
  }
  const candidate = devices[0];
  if (candidate === undefined) {
    throw new Error("SCRIPTC_IOS=1 needs at least one available simulator (xcrun simctl list devices available).");
  }
  execFileSync("xcrun", ["simctl", "boot", candidate.udid]);
  bootedSimulator = { udid: candidate.udid, bootedByUs: true };
  try {
    execFileSync("xcrun", ["simctl", "bootstatus", candidate.udid, "-b"], { timeout: 300_000 });
  } catch (err) {
    shutdownOwnedSimulator();
    throw err;
  }
  return candidate.udid;
}

describe.skipIf(!iosOn)("mobile targets: iOS (SCRIPTC_IOS=1)", () => {
  afterAll(() => {
    shutdownOwnedSimulator();
  });

  test("the iOS toolchain is present", () => {
    // Fail, never skip: SCRIPTC_IOS=1 promises an iOS verdict.
    for (const sdk of ["iphoneos", "iphonesimulator"] as const) {
      const path = execFileSync("xcrun", ["--sdk", sdk, "--show-sdk-path"], { encoding: "utf8" }).trim();
      expect(path, `xcrun --sdk ${sdk} --show-sdk-path`).not.toBe("");
    }
    execFileSync("zig", ["version"], { encoding: "utf8" });
  });

  describe.each(APPLE_MOBILE_TARGETS)("target %s", (target) => {
    describe.each(EMISSIONS)("%s emission", (emission) => {
      test("M13: localized archives build; symbols exact, ambient audit holds, iOS 15.0 floor stamped, probe links", async (ctx) => {
        if (nmTool === null) ctx.skip("no nm on PATH for the symbol-exactness check");
        const archiveA = await buildInstanceCross("a", emission, target);
        const archiveB = await buildInstanceCross("b", emission, target);
        for (const [archive, declared] of [
          [archiveA, A_SYMBOLS],
          [archiveB, B_SYMBOLS],
        ] as const) {
          const { defined, undef } = nmSymbols(archive);
          expect([...defined].sort()).toEqual([...declared].sort());
          expect([...undef].filter((s) => s.startsWith("scr_") || s.startsWith("ma_") || s.startsWith("mb_"))).toEqual([]);
          for (const banned of ["sigaction", "signal", "pthread_create", "atexit", "setvbuf"]) {
            expect(undef.has(banned), `undefined reference to ${banned}`).toBe(false);
          }
          // The version floor is part of the target contract: every member
          // carries LC_BUILD_VERSION with the device (2) or simulator (7)
          // platform and minos 15.0.
          const loadCommands = execFileSync("otool", ["-l", archive], { encoding: "utf8" });
          expect(loadCommands).toContain("LC_BUILD_VERSION");
          expect(loadCommands).toContain(`minos ${IPHONEOS_MIN_VERSION}`);
          expect(loadCommands).toContain(`platform ${target === "aarch64-apple-ios" ? "2" : "7"}`);
        }
        buildAppleProbe([archiveA, archiveB], join(fixtureDir, "probe.c"), `ios-${emission}-${target}`, target);
      }, 240_000);
    });
  });

  describe("M13 simulator execution", () => {
    test.for(EMISSIONS)(
      "the two-instance probe runs on a booted simulator (%s emission)",
      async (emission) => {
        const target = "aarch64-apple-ios-simulator";
        const archiveA = await buildInstanceCross("a", emission, target);
        const archiveB = await buildInstanceCross("b", emission, target);
        const probe = buildAppleProbe(
          [archiveA, archiveB],
          join(fixtureDir, "probe.c"),
          `ios-run-${emission}`,
          target,
        );
        const udid = ensureBootedSimulator();
        const out = execFileSync("xcrun", ["simctl", "spawn", udid, probe], {
          encoding: "utf8",
          timeout: 120_000,
        });
        expect(out).toBe(PROBE_EXPECTED);
      },
      600_000,
    );

    test("a thread-instanced and runtime-localized archive runs on the simulator", async () => {
      const target = "aarch64-apple-ios-simulator";
      const key = `ios-t-llvm-${target}`;
      let archive = built.get(key);
      if (archive === undefined) {
        archive = withMobileTarget(target, async () => {
          const outDir = join(cacheDir, key);
          mkdirSync(outDir, { recursive: true });
          const profile = JSON.parse(readFileSync(join(threadFixtureDir, "profile_t.json"), "utf8")) as {
            entry: string;
            emission: string;
            abi: Record<string, unknown>;
          };
          profile.emission = "llvm";
          profile.entry = join(threadFixtureDir, profile.entry);
          profile.abi["localize_runtime"] = true;
          const profilePath = join(outDir, "profile.json");
          writeFileSync(profilePath, JSON.stringify(profile, null, 2));
          const result = await compileLibrary({ profilePath, outDir });
          if (!result.ok) {
            throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
          }
          return result.archivePath;
        });
        built.set(key, archive);
      }
      const probe = buildAppleProbe([await archive], join(threadFixtureDir, "probe.c"), "ios-run-t", target);
      const udid = ensureBootedSimulator();
      const out = execFileSync("xcrun", ["simctl", "spawn", udid, probe], {
        encoding: "utf8",
        timeout: 120_000,
      });
      expect(out).toBe(THREADED_EXPECTED);
    }, 600_000);
  });
});

/* ── M14: Android (SCRIPTC_ANDROID=1) ─────────────────────────────────────── */

/** The SDK roots the NDK/emulator discovery searches: the explicit
 * environment first, then the platform-default install location. */
function androidSdkRoots(): string[] {
  return [
    process.env["ANDROID_HOME"],
    process.env["ANDROID_SDK_ROOT"],
    process.platform === "darwin"
      ? join(homedir(), "Library", "Android", "sdk")
      : join(homedir(), "Android", "Sdk"),
  ].filter((root): root is string => root !== undefined && root !== "" && existsSync(root));
}

/** The NDK's clang driver — the embedder-side link tool (what a Gradle/NDK
 * build invokes), used here to link probes at the API 26 floor. */
function androidNdkClang(): string | null {
  const ndkRoots: string[] = [];
  const explicit = [process.env["ANDROID_NDK_ROOT"], process.env["ANDROID_NDK_HOME"]]
    .find((root): root is string => root !== undefined && root !== "");
  if (explicit !== undefined) ndkRoots.push(explicit);
  for (const sdk of androidSdkRoots()) {
    const ndkDir = join(sdk, "ndk");
    if (!existsSync(ndkDir)) continue;
    ndkRoots.push(...readdirSync(ndkDir).sort().reverse().map((version) => join(ndkDir, version)));
  }
  for (const ndk of ndkRoots) {
    const prebuilt = join(ndk, "toolchains", "llvm", "prebuilt");
    if (!existsSync(prebuilt)) continue;
    for (const host of readdirSync(prebuilt).sort()) {
      const clang = join(prebuilt, host, "bin", "clang");
      if (existsSync(clang)) return clang;
    }
  }
  return null;
}

function androidTool(name: "adb" | "emulator"): string {
  for (const sdk of androidSdkRoots()) {
    const path = join(sdk, name === "adb" ? "platform-tools" : "emulator", name);
    if (existsSync(path)) return path;
  }
  return name; // PATH fallback
}

function buildAndroidProbe(archives: string[], source: string, tag: string): string {
  const outDir = join(cacheDir, "probes");
  mkdirSync(outDir, { recursive: true });
  const bin = join(outDir, `probe-${tag}`);
  const clang = androidNdkClang();
  if (clang === null) throw new Error("SCRIPTC_ANDROID=1 needs an NDK (ANDROID_NDK_ROOT or <sdk>/ndk).");
  execFileSync(clang, [
    `--target=aarch64-linux-android${ANDROID_MIN_API}`,
    "-std=c11",
    source,
    ...archives,
    "-lm",
    "-o", bin,
  ]);
  return bin;
}

/** The device the execution legs share: a running emulator/device is
 * reused when it carries arm64-v8a and API 26+; otherwise a headless arm64
 * AVD is written directly (the emulator reads ~/.android/avd — no
 * avdmanager/Java dependency) and booted on an exclusively claimed port,
 * then torn down by the suite. The UUID-scoped AVD name and ownership
 * marker keep concurrent lanes and pre-existing user AVDs out of scope. */
interface AndroidPortClaim {
  port: number;
  lockPath: string;
}

type AndroidDevice =
  | { serial: string; startedByUs: false }
  | {
      serial: string;
      startedByUs: true;
      adbOwned: boolean;
      emulator: ReturnType<typeof spawn>;
      portClaim: AndroidPortClaim;
    };

let androidDevice: AndroidDevice | null = null;
const ANDROID_LANE_OWNER = `${process.pid}-${randomUUID()}`;
const ANDROID_LANE_AVD = `scriptc-mobile-lane-${ANDROID_LANE_OWNER}`;
const ANDROID_PORT_MIN = 5554;
const ANDROID_PORT_MAX = 5682;
const ANDROID_PORT_LOCK_ROOT = join(tmpdir(), "scriptc-mobile-emulator-ports");
const ANDROID_AVD_OWNER_FILE = ".scriptc-owner";

function adbDevices(adb: string): string[] {
  return execFileSync(adb, ["devices"], { encoding: "utf8" })
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.endsWith("\tdevice") || line.endsWith(" device"))
    .map((line) => line.split(/\s+/)[0]!);
}

function isCompatibleAndroidDevice(abiList: string, sdkLevel: string): boolean {
  const abis = abiList.split(",").map((abi) => abi.trim());
  const sdk = Number.parseInt(sdkLevel.trim(), 10);
  return abis.includes("arm64-v8a") && Number.isFinite(sdk) && sdk >= ANDROID_MIN_API;
}

function compatibleAndroidDevice(adb: string, serial: string): boolean {
  const getprop = (name: string): string | null => {
    const result = spawnSync(adb, ["-s", serial, "shell", "getprop", name], {
      encoding: "utf8",
      timeout: 15_000,
    });
    return result.status === 0 ? (result.stdout ?? "").trim() : null;
  };
  const abiList = getprop("ro.product.cpu.abilist") || getprop("ro.product.cpu.abi");
  const sdkLevel = getprop("ro.build.version.sdk");
  return abiList !== null && sdkLevel !== null && isCompatibleAndroidDevice(abiList, sdkLevel);
}

function claimAndroidLanePort(runningSerials: readonly string[]): AndroidPortClaim {
  mkdirSync(ANDROID_PORT_LOCK_ROOT, { recursive: true });
  const portCount = (ANDROID_PORT_MAX - ANDROID_PORT_MIN) / 2 + 1;
  const seed = (process.pid + Number.parseInt(ANDROID_LANE_OWNER.slice(-8), 16)) % portCount;
  for (let offset = 0; offset < portCount; offset++) {
    const port = ANDROID_PORT_MIN + 2 * ((seed + offset) % portCount);
    if (runningSerials.includes(`emulator-${port}`)) continue;
    const lockPath = join(ANDROID_PORT_LOCK_ROOT, `${port}.lock`);
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({ owner: ANDROID_LANE_OWNER, pid: process.pid }),
        { flag: "wx", mode: 0o600 },
      );
      return { port, lockPath };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`no unclaimed even Android emulator port is available in ${ANDROID_PORT_MIN}-${ANDROID_PORT_MAX}`);
}

function releaseAndroidLanePort(claim: AndroidPortClaim): void {
  try {
    const record = JSON.parse(readFileSync(claim.lockPath, "utf8")) as { owner?: unknown };
    if (record.owner === ANDROID_LANE_OWNER) rmSync(claim.lockPath, { force: true });
  } catch {
    /* a missing or foreign lock is not ours to remove */
  }
}

function removeAndroidLaneAvd(): void {
  const avdRoot = join(homedir(), ".android", "avd");
  const avdDir = join(avdRoot, `${ANDROID_LANE_AVD}.avd`);
  const iniPath = join(avdRoot, `${ANDROID_LANE_AVD}.ini`);
  try {
    if (readFileSync(join(avdDir, ANDROID_AVD_OWNER_FILE), "utf8") !== ANDROID_LANE_OWNER) return;
  } catch {
    return;
  }
  let ownsIni = false;
  try {
    ownsIni = readFileSync(iniPath, "utf8").includes(`path=${avdDir}\n`);
  } catch {
    /* the ini may not have been written before setup failed */
  }
  rmSync(avdDir, { recursive: true, force: true });
  if (ownsIni) rmSync(iniPath, { force: true });
}

function stopOwnedAndroidDevice(): void {
  if (androidDevice?.startedByUs !== true) return;
  const owned = androidDevice;
  androidDevice = null;
  if (owned.adbOwned) {
    try {
      execFileSync(androidTool("adb"), ["-s", owned.serial, "emu", "kill"], { timeout: 30_000 });
    } catch {
      /* the emulator may have exited after its identity was verified */
    }
  }
  try {
    owned.emulator.kill("SIGTERM");
  } catch {
    /* process cleanup is best-effort — never mask a real failure */
  }
  removeAndroidLaneAvd();
  releaseAndroidLanePort(owned.portClaim);
}

function createAndroidLaneAvd(image: { sysdir: string; api: string }): void {
  const avdRoot = join(homedir(), ".android", "avd");
  const avdDir = join(avdRoot, `${ANDROID_LANE_AVD}.avd`);
  mkdirSync(avdRoot, { recursive: true });
  mkdirSync(avdDir);
  let marked = false;
  try {
    writeFileSync(join(avdDir, ANDROID_AVD_OWNER_FILE), ANDROID_LANE_OWNER, { flag: "wx", mode: 0o600 });
    marked = true;
    writeFileSync(
      join(avdRoot, `${ANDROID_LANE_AVD}.ini`),
      `avd.ini.encoding=UTF-8\npath=${avdDir}\npath.rel=avd/${ANDROID_LANE_AVD}.avd\ntarget=${image.api}\n`,
      { flag: "wx" },
    );
    writeFileSync(
      join(avdDir, "config.ini"),
      [
        `AvdId=${ANDROID_LANE_AVD}`,
        "PlayStore.enabled=false",
        "abi.type=arm64-v8a",
        "avd.ini.encoding=UTF-8",
        "disk.dataPartition.size=2G",
        "hw.cpu.arch=arm64",
        "hw.cpu.ncore=4",
        "hw.gpu.enabled=no",
        "hw.gpu.mode=off",
        "hw.keyboard=yes",
        "hw.lcd.density=440",
        "hw.lcd.height=2280",
        "hw.lcd.width=1080",
        "hw.ramSize=2048",
        "hw.sdCard=no",
        `image.sysdir.1=${image.sysdir}`,
        "tag.display=Google APIs",
        "tag.id=google_apis",
        "",
      ].join("\n"),
      { flag: "wx" },
    );
  } catch (err) {
    if (marked) removeAndroidLaneAvd();
    else rmSync(avdDir, { recursive: true, force: true });
    throw err;
  }
}

function androidEmulatorAvdName(adb: string, serial: string): string | null {
  const result = spawnSync(adb, ["-s", serial, "emu", "avd", "name"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.status !== 0) return null;
  return (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "" && line !== "OK") ?? null;
}

async function ensureAndroidDevice(): Promise<string> {
  if (androidDevice !== null) return androidDevice.serial;
  const adb = androidTool("adb");
  const running = adbDevices(adb);
  const compatible = running.find((serial) => compatibleAndroidDevice(adb, serial));
  if (compatible !== undefined) {
    androidDevice = { serial: compatible, startedByUs: false };
    return compatible;
  }
  // No device: write the AVD and boot it headless. The system image is the
  // newest installed arm64-v8a one.
  const image = ((): { sdk: string; sysdir: string; api: string } | null => {
    for (const sdk of androidSdkRoots()) {
      const imagesDir = join(sdk, "system-images");
      if (!existsSync(imagesDir)) continue;
      const apis = readdirSync(imagesDir)
        .filter((name) => {
          const api = Number.parseInt(name.replace(/^android-/, ""), 10);
          return name.startsWith("android-") && Number.isFinite(api) && api >= ANDROID_MIN_API;
        })
        .sort(
          (a, b) =>
            Number.parseInt(b.replace(/^android-/, ""), 10) -
            Number.parseInt(a.replace(/^android-/, ""), 10),
        );
      for (const api of apis) {
        for (const tag of readdirSync(join(imagesDir, api)).sort()) {
          const abiDir = join(imagesDir, api, tag, "arm64-v8a");
          if (existsSync(abiDir)) {
            return { sdk, sysdir: `system-images/${api}/${tag}/arm64-v8a/`, api };
          }
        }
      }
    }
    return null;
  })();
  if (image === null) {
    throw new Error(
      "SCRIPTC_ANDROID=1 needs a compatible running device or an installed API-26+ arm64-v8a system image " +
        "(sdkmanager 'system-images;android-<api>;google_apis;arm64-v8a') to boot one.",
    );
  }
  const portClaim = claimAndroidLanePort(running);
  try {
    createAndroidLaneAvd(image);
  } catch (err) {
    releaseAndroidLanePort(portClaim);
    throw err;
  }
  let emulator: ReturnType<typeof spawn>;
  try {
    emulator = spawn(
      androidTool("emulator"),
      [
        "-avd", ANDROID_LANE_AVD,
        "-port", String(portClaim.port),
        "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot", "-gpu", "off",
      ],
      { detached: true, stdio: "ignore" },
    );
  } catch (err) {
    removeAndroidLaneAvd();
    releaseAndroidLanePort(portClaim);
    throw err;
  }
  const serial = `emulator-${portClaim.port}`;
  const ownedDevice: Extract<AndroidDevice, { startedByUs: true }> = {
    serial,
    startedByUs: true,
    adbOwned: false,
    emulator,
    portClaim,
  };
  androidDevice = ownedDevice;
  let emulatorError: Error | null = null;
  emulator.once("error", (err) => {
    emulatorError = err;
  });
  emulator.unref();
  try {
    const deadline = Date.now() + 300_000;
    for (;;) {
      if (emulatorError !== null) throw emulatorError;
      if (emulator.exitCode !== null || emulator.signalCode !== null) {
        throw new Error(
          `the Android emulator exited before boot completed (` +
            (emulator.exitCode !== null ? `exit ${emulator.exitCode}` : `signal ${emulator.signalCode}`) +
            `)`,
        );
      }
      const probe = spawnSync(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], {
        encoding: "utf8",
        timeout: 15_000,
      });
      if ((probe.stdout ?? "").trim() === "1") {
        const avdName = androidEmulatorAvdName(adb, serial);
        if (avdName !== ANDROID_LANE_AVD) {
          throw new Error(
            `${serial} belongs to AVD '${avdName ?? "<unknown>"}', not this lane's '${ANDROID_LANE_AVD}'`,
          );
        }
        ownedDevice.adbOwned = true;
        break;
      }
      if (Date.now() > deadline) throw new Error("the Android emulator did not finish booting within 5 minutes");
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  } catch (err) {
    stopOwnedAndroidDevice();
    throw err;
  }
  return serial;
}

/** Push a probe and run it on the device, returning its stdout. */
function adbRun(serial: string, probe: string, tag: string): string {
  const adb = androidTool("adb");
  const remote = `/data/local/tmp/scriptc-mobile-lane-${tag}`;
  execFileSync(adb, ["-s", serial, "push", probe, remote], { timeout: 60_000 });
  try {
    return execFileSync(adb, ["-s", serial, "shell", `chmod 755 ${remote} && ${remote}`], {
      encoding: "utf8",
      timeout: 120_000,
    });
  } finally {
    try {
      execFileSync(adb, ["-s", serial, "shell", `rm -f ${remote}`], { timeout: 30_000 });
    } catch {
      /* cleanup is best-effort — never mask the real failure */
    }
  }
}

describe.skipIf(!androidOn)("mobile targets: Android (SCRIPTC_ANDROID=1)", () => {
  afterAll(() => {
    stopOwnedAndroidDevice();
  });

  test("the Android toolchain is present", () => {
    // Fail, never skip: SCRIPTC_ANDROID=1 promises an Android verdict.
    expect(androidNdkClang(), "an NDK (ANDROID_NDK_ROOT or <sdk>/ndk)").not.toBeNull();
    execFileSync("zig", ["version"], { encoding: "utf8" });
  });

  describe.each(EMISSIONS)("%s emission", (emission) => {
    test("M14: localized archives build; symbols exact, ambient audit holds, probe links at API 26", async (ctx) => {
      if (nmTool === null) ctx.skip("no nm on PATH for the symbol-exactness check");
      const archiveA = await buildInstanceCross("a", emission, "aarch64-linux-android");
      const archiveB = await buildInstanceCross("b", emission, "aarch64-linux-android");
      for (const [archive, declared] of [
        [archiveA, A_SYMBOLS],
        [archiveB, B_SYMBOLS],
      ] as const) {
        const { defined, undef } = nmSymbols(archive);
        expect([...defined].sort()).toEqual([...declared].sort());
        expect([...undef].filter((s) => s.startsWith("scr_") || s.startsWith("ma_") || s.startsWith("mb_"))).toEqual([]);
        for (const banned of ["sigaction", "signal", "pthread_create", "atexit", "setvbuf"]) {
          expect(undef.has(banned), `undefined reference to ${banned}`).toBe(false);
        }
      }
      buildAndroidProbe([archiveA, archiveB], join(fixtureDir, "probe.c"), `android-${emission}`);
    }, 240_000);
  });

  describe("M14 emulator execution", () => {
    test.for(EMISSIONS)(
      "the two-instance probe runs on the emulator (%s emission)",
      async (emission) => {
        const archiveA = await buildInstanceCross("a", emission, "aarch64-linux-android");
        const archiveB = await buildInstanceCross("b", emission, "aarch64-linux-android");
        const probe = buildAndroidProbe(
          [archiveA, archiveB],
          join(fixtureDir, "probe.c"),
          `android-run-${emission}`,
        );
        const serial = await ensureAndroidDevice();
        expect(adbRun(serial, probe, `m2-${emission}`)).toBe(PROBE_EXPECTED);
      },
      600_000,
    );

    test("a thread-instanced and runtime-localized archive runs on the emulator", async () => {
      const key = "android-t-llvm";
      let archive = built.get(key);
      if (archive === undefined) {
        archive = withMobileTarget("aarch64-linux-android", async () => {
          const outDir = join(cacheDir, key);
          mkdirSync(outDir, { recursive: true });
          const profile = JSON.parse(readFileSync(join(threadFixtureDir, "profile_t.json"), "utf8")) as {
            entry: string;
            emission: string;
            abi: Record<string, unknown>;
          };
          profile.emission = "llvm";
          profile.entry = join(threadFixtureDir, profile.entry);
          profile.abi["localize_runtime"] = true;
          const profilePath = join(outDir, "profile.json");
          writeFileSync(profilePath, JSON.stringify(profile, null, 2));
          const result = await compileLibrary({ profilePath, outDir });
          if (!result.ok) {
            throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
          }
          return result.archivePath;
        });
        built.set(key, archive);
      }
      const probe = buildAndroidProbe([await archive], join(threadFixtureDir, "probe.c"), "android-run-t");
      const serial = await ensureAndroidDevice();
      expect(adbRun(serial, probe, "m6")).toBe(THREADED_EXPECTED);
    }, 600_000);
  });
});
