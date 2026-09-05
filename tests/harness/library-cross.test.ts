/* The cross-target library conformance lane — env-gated (SCRIPTC_CROSS=1),
 * skipped everywhere else so the macOS lanes never see it (the linux/
 * windows differential lanes' contract). The executable corpus already
 * cross-compiles AND cross-executes under those lanes; this one closes the
 * same "expected to work, never tested" gap for LIBRARY MODE — the K
 * fixtures' archives are exactly the artifacts embedders link, so every
 * K-fixture library profile cross-builds here for the embedder-relevant
 * target list:
 *
 *   aarch64-linux-gnu.2.36   (the linux lane's default triple, glibc
 *                             pinned to the differential container's
 *                             bookworm — docs/linux-port.md)
 *   x86_64-linux-gnu.2.36    (the linux lane's amd64 triple)
 *   aarch64-linux-musl       (the Alpine-compatible static arm64 triple)
 *   x86_64-linux-musl        (the Alpine-compatible static amd64 triple)
 *   x86_64-windows-gnu       (the windows lane's triple)
 *   x86_64-macos             (build-only; the host arm64-macos build is
 *                             the ordinary suites' tested baseline)
 *
 * Both emissions build per target (the K suite's reference/differential
 * posture — emitted .c and .ll deliberately carry no target triple, so
 * `zig cc -target` compiles either). Per archive, ON THE HOST (no
 * execution — Apple's nm is llvm-nm and reads ELF/COFF/Mach-O alike):
 *
 *   - K1 cross: prefix-carrying external definitions equal the profile's
 *     declared symbol set (exports + abi entry points + sidecar identity
 *     getters), both directions; no prefix-carrying undefineds. Symbol
 *     decoration is format-normalized: Mach-O carries a leading
 *     underscore, ELF and x86_64 COFF do not.
 *   - K8 cross: the mechanical ambient audit — no undefined reference to
 *     the process-disposition/threading surface (win32 dllimport
 *     spellings included), and no fiber/loop/timer/child symbol defined
 *     or referenced anywhere in the archive.
 *   - Linkability: for fixtures with a probe, the probe LINKS against the
 *     cross archive with the target's libc alone — plus, on win32, the
 *     documented embedder system libs (advapi32/iphlpapi/ws2_32, the same
 *     unconditional set native-toolchain.ts links into win32 executables). A stray
 *     undefined (the scr_win.c shim gap this lane caught on day one)
 *     fails HERE, at build time on the host, not in an embedder's build.
 *
 * Execution is staged where infrastructure exists, gated exactly like the
 * sibling lanes: with SCRIPTC_LINUX=1 the K2 scalar probe (a plain-C
 * embedder host linked against the cross archive) runs in the docker
 * container per linux triple; with SCRIPTC_WIN=1 it ships to the Windows
 * box over scp and runs there (its stdout arrives CRLF — the PROBE's own
 * printf goes through the mingw CRT's text-mode stdout, an honest
 * plain-C-embedder fact, so that leg alone normalizes line endings).
 * x86_64-macos stays build-only by contract; when Rosetta happens to be
 * present the probe runs as a bonus (detected, never required).
 *
 * Cost (warm zig cache, M-series host): ~1s per archive build, ~2.5min
 * for the full 112-build matrix — plus zig on PATH as a hard requirement,
 * which is why the lane is env-gated rather than part of the default
 * suite. SCRIPTC_CROSS_FILTER=<regex> narrows the fixture list for
 * triage. Never part of the commit gate. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { compileLibrary } from "@scriptc/compiler";

const enabled = process.env["SCRIPTC_CROSS"] === "1";

const repoRoot = join(import.meta.dirname, "../..");
const fixtureRoot = join(repoRoot, "tests/library-mode");
/* Suite-flavor segment (the library suites' convention): the plain and
 * SCRIPTC_SAN=1 suites may run concurrently and must never share build
 * dirs. */
const flavor = process.env["SCRIPTC_SAN"] === "1" ? "san" : "plain";
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/library-cross", flavor);

/* The embedder-relevant target list. GNU/Linux triples pin the glibc minor
 * the differential container's bookworm ships (the linux lane's default);
 * musl, windows-gnu, and macos triples carry no libc version. */
const TARGETS = [
  "aarch64-linux-gnu.2.36",
  "x86_64-linux-gnu.2.36",
  "aarch64-linux-musl",
  "x86_64-linux-musl",
  "x86_64-windows-gnu",
  "x86_64-macos",
] as const;
type Target = (typeof TARGETS)[number];

/* The win32 embedder link contract: the system DLLs the archive's runtime
 * units import beyond the CRT — advapi32 (RtlGenRandom behind
 * arc4random_buf, GetUserNameA), iphlpapi (GetAdaptersAddresses behind
 * os.networkInterfaces), ws2_32 (inet_ntop/htonl) — exactly the
 * unconditional win32 libs native-toolchain.ts links into every win32 executable. An
 * archive carries no -l flags, so a win32 embedder spells these on its own
 * link line; the probe links pin the set. */
const WIN32_EMBEDDER_LIBS = ["-ladvapi32", "-liphlpapi", "-lws2_32"];

type Emission = "llvm" | "c";
const EMISSIONS: Emission[] = ["llvm", "c"];

const filter = process.env["SCRIPTC_CROSS_FILTER"];
/* Every K fixture that IS a library profile (int-corpus and npm-refuse
 * have no profile.json — their suites synthesize profiles per test). */
const fixtures = enabled
  ? globSync(join(fixtureRoot, "*/profile.json"))
      .map((p) => basename(dirname(p)))
      .sort()
      .filter((f) => filter === undefined || new RegExp(filter).test(f))
  : [];

if (enabled) {
  // compileLibrary reads SCRIPTC_CC/SCRIPTC_TARGET at call time; this file
  // runs in its own worker process, so the macOS lanes never see them.
  // SCRIPTC_TARGET flips per build in buildLibrary below — safe because
  // vitest runs this file's tests sequentially and every build is awaited
  // before the next begins.
  process.env["SCRIPTC_CC"] = "zigcc";
}

interface LibProfile {
  entry: string;
  emission: string;
  name: string;
  abi: {
    prefix: string;
    init_symbol: string;
    sink_register_symbol: string;
    collect_symbol: string | null;
    result_reset_symbol: string | null;
    callback_register_symbol?: string;
  };
  exports: { symbol: string }[];
  sidecar?: { build_id_symbol: string; abi_version_symbol: string } | null;
}

/** The profile's whole declared symbol surface: the export map, the abi
 * entry points, and (when a sidecar section exists) the identity getters
 * the same build emits. */
function declaredSymbols(p: LibProfile): string[] {
  return [
    ...p.exports.map((e) => e.symbol),
    p.abi.init_symbol,
    p.abi.sink_register_symbol,
    ...(p.abi.collect_symbol !== null ? [p.abi.collect_symbol] : []),
    ...(p.abi.result_reset_symbol !== null ? [p.abi.result_reset_symbol] : []),
    ...(p.abi.callback_register_symbol !== undefined ? [p.abi.callback_register_symbol] : []),
    ...(p.sidecar != null ? [p.sidecar.build_id_symbol, p.sidecar.abi_version_symbol] : []),
  ];
}

/** Build one fixture's library archive for one emission and one cross
 * target — library-mode.test.ts's buildLibrary with the target threaded
 * through the env the cc driver reads. */
async function buildLibrary(
  fixture: string,
  emission: Emission,
  target: Target,
): Promise<{ archive: string; outDir: string; profile: LibProfile }> {
  const dir = join(fixtureRoot, fixture);
  const outDir = join(cacheDir, `${fixture}-${emission}-${target}`);
  mkdirSync(outDir, { recursive: true });
  const profile = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")) as LibProfile;
  profile.emission = emission;
  profile.entry = join(dir, profile.entry);
  // Sidecar-declared relative paths resolve beside the archive, i.e.
  // inside this build dir (the contract suite owns sidecar semantics —
  // here a sidecar only matters as its declared identity symbols).
  const profilePath = join(outDir, "profile.json");
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  process.env["SCRIPTC_TARGET"] = target;
  try {
    const result = await compileLibrary({ profilePath, outDir });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    expect(result.backend).toBe(emission);
    return { archive: result.archivePath, outDir, profile };
  } finally {
    delete process.env["SCRIPTC_TARGET"];
  }
}

/** nm over the archive: [definedExternal, undefined] symbol sets —
 * library-mode.test.ts's helper verbatim. Apple's nm is llvm-nm, so ELF,
 * COFF, and Mach-O members all parse; the leading-underscore strip
 * normalizes Mach-O (and is a no-op on ELF/x86_64-COFF names, which carry
 * no decoration). */
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
  const defined = parse(execFileSync("nm", ["-gU", archive], { encoding: "utf8" }));
  const undef = parse(execFileSync("nm", ["-u", archive], { encoding: "utf8" }));
  return { defined, undef };
}

/** Cross-link a fixture's probe against the cross archive with zig cc —
 * the target's libc/libm, plus the win32 embedder libs on the windows
 * triple. Success IS the assertion: every undefined in the archive
 * resolved against exactly what an embedder links. */
function linkProbe(fixture: string, archive: string, outDir: string, target: Target): string {
  const bin = join(outDir, "probe");
  execFileSync("zig", [
    "cc",
    "-std=c11",
    "-target", target,
    join(fixtureRoot, fixture, "probe.c"),
    archive,
    "-lm",
    ...(target.includes("windows") ? WIN32_EMBEDDER_LIBS : []),
    "-o", bin,
  ]);
  return bin;
}

/* K2's scripted call sequence over the scalars fixture —
 * library-mode.test.ts's expected bytes, the execution probes' oracle. */
const SCALARS_EXPECTED = `scalars ready
add: 0.30000000000000004
max-safe exact: 1
nan passthrough: 1
neg zero sign: 1
is_nan(NaN): 1
is_nan(1): 0
invert(0): 1
invert(7): 0
plumb: 40000254995
`;

/* The ambient audit's banned undefineds (K8's list) — checked in the bare
 * spelling and the COFF dllimport spelling (`__imp_<name>`, which the
 * shared underscore-strip renders `_imp_<name>`). */
const BANNED_AMBIENT = ["sigaction", "signal", "pthread_create", "atexit", "setvbuf"];
const LOOPISH = /^scr_(loop|fiber|on_fiber|timer|set_timeout|set_interval|set_immediate|next_tick|child|spawn)/;

describe.skipIf(!enabled)("cross-target library conformance", () => {
  test("zig is on PATH", () => {
    // Fail loudly, not skip: SCRIPTC_CROSS=1 promises a cross verdict.
    try {
      execFileSync("zig", ["version"], { encoding: "utf8" });
    } catch {
      throw new Error("SCRIPTC_CROSS=1 needs zig on PATH (zigup) — the lane cross-compiles with `zig cc`.");
    }
  });

  describe.each(TARGETS)("target %s", (target) => {
    describe.each(EMISSIONS)("%s emission", (emission) => {
      test.skipIf(fixtures.length === 0).for(fixtures)(
        "%s: cross-builds; K1 symbol exactness, K8 ambient audit, probe links",
        async (fixture) => {
          const { archive, outDir, profile } = await buildLibrary(fixture, emission, target);

          // K1 cross: prefix-carrying external definitions equal the
          // declared set exactly, both directions; no prefix-carrying
          // undefineds (a missed inter-object reference would land there).
          const { defined, undef } = nmSymbols(archive);
          const prefix = profile.abi.prefix;
          expect([...defined].filter((s) => s.startsWith(prefix)).sort()).toEqual(
            [...new Set(declaredSymbols(profile))].sort(),
          );
          expect([...undef].filter((s) => s.startsWith(prefix))).toEqual([]);

          // K8 cross: the mechanical ambient audit, in the bare and the
          // COFF-dllimport spellings.
          for (const banned of BANNED_AMBIENT) {
            for (const spelling of [banned, `_imp_${banned}`]) {
              expect(undef.has(spelling), `undefined reference to ${spelling}`).toBe(false);
            }
          }
          // These fixtures reach no continuation, so the promise/fiber
          // unit is not gated in: no fiber/event-loop/timer/child symbol
          // defined in the archive, none referenced by a linked unit.
          expect([...defined].filter((s) => LOOPISH.test(s))).toEqual([]);
          expect([...undef].filter((s) => LOOPISH.test(s))).toEqual([]);

          // Linkability: the probe (a plain-C embedder host) links against
          // the target's libc plus the documented win32 embedder libs —
          // nothing else. The attest-only fixtures ship no probe.
          if (existsSync(join(fixtureRoot, fixture, "probe.c"))) {
            linkProbe(fixture, archive, outDir, target);
          }
        },
      );
    });
  });

  /* ── K2 execution probes, where infrastructure exists ──────────────────
   * Gated exactly like the sibling lanes: the linux legs need the docker
   * daemon (SCRIPTC_LINUX=1), the windows leg the ssh box (SCRIPTC_WIN=1).
   * Each leg builds the scalars archive fresh for its triple (both
   * emissions), links the K2 probe, executes it on the target, and
   * compares the full scripted round-trip byte-for-byte. */
  describe("K2 execution probes", () => {
    const linuxOn = process.env["SCRIPTC_LINUX"] === "1";
    const winOn = process.env["SCRIPTC_WIN"] === "1";
    const nodeVersion = (): string => readFileSync(join(repoRoot, ".node-version"), "utf8").trim();

    test.skipIf(!linuxOn).for(
      EMISSIONS.flatMap((e) => [
        [`aarch64-linux-gnu.2.36 ${e}`, "aarch64-linux-gnu.2.36", e],
        [`x86_64-linux-gnu.2.36 ${e}`, "x86_64-linux-gnu.2.36", e],
        [`aarch64-linux-musl ${e}`, "aarch64-linux-musl", e],
        [`x86_64-linux-musl ${e}`, "x86_64-linux-musl", e],
      ] as const),
    )(
      "scalar round-trip in the container (%s)",
      async ([, target, emission]) => {
        const { archive, outDir } = await buildLibrary("scalars", emission, target);
        const probe = linkProbe("scalars", archive, outDir, target);
        // One-shot container per run (no oracle, no repo paths in the
        // output — the long-lived-container mechanics of the differential
        // lane buy nothing here). Image and platform follow the sibling
        // lane: GNU triples use the pinned bookworm image; the musl triple
        // runs in Alpine, matching the executable differential lane.
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
        expect(out).toBe(SCALARS_EXPECTED);
      },
      300_000,
    );

    test.skipIf(!winOn).for(EMISSIONS)(
      "scalar round-trip on the Windows box (%s emission)",
      async (emission) => {
        const host = process.env["SCRIPTC_WIN_HOST"] ?? "windows-dev";
        // Box etiquette (the windows lane's): everything in ONE directory,
        // created per run and deleted at the end — a lane-distinct name so
        // a concurrent windows-differential run is never disturbed.
        const dirWin = "C:\\Users\\rdp\\work\\scriptc-xlib-lane";
        const { archive, outDir } = await buildLibrary("scalars", emission, "x86_64-windows-gnu");
        const probe = linkProbe("scalars", archive, outDir, "x86_64-windows-gnu");
        const ssh = (cmd: string): string =>
          execFileSync("ssh", ["-o", "ConnectTimeout=15", host, cmd], { encoding: "utf8", timeout: 120_000 });
        try {
          ssh(`cmd /c if not exist ${dirWin} mkdir ${dirWin}`);
          execFileSync("scp", ["-q", probe, `${host}:C:/Users/rdp/work/scriptc-xlib-lane/probe-${emission}.exe`], {
            timeout: 120_000,
          });
          const out = ssh(`cd /d ${dirWin} && probe-${emission}.exe`);
          // The PROBE's own printf rides the mingw CRT's text-mode stdout,
          // so its lines arrive CRLF — a plain-C embedder host fact, not a
          // runtime one (the executable lanes compare Windows-vs-Windows
          // and never normalize). This one leg folds the CRT's \r\n back.
          expect(out.replaceAll("\r\n", "\n")).toBe(SCALARS_EXPECTED);
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

    test.for(EMISSIONS)(
      "x86_64-macos: probe runs under Rosetta when present (%s emission, bonus)",
      async (emission, ctx) => {
        // Build-only is the x86_64-macos contract; execution is a bonus
        // when Rosetta happens to be installed — detected, never required.
        const rosetta = spawnSync("arch", ["-x86_64", "/usr/bin/true"]).status === 0;
        if (!rosetta) ctx.skip("Rosetta not present — x86_64-macos stays build-only");
        const { archive, outDir } = await buildLibrary("scalars", emission, "x86_64-macos");
        const probe = linkProbe("scalars", archive, outDir, "x86_64-macos");
        const run = spawnSync(probe, [], { encoding: "utf8", timeout: 60_000 });
        expect(run.signal).toBeNull();
        expect(run.status).toBe(0);
        expect(run.stdout).toBe(SCALARS_EXPECTED);
      },
      120_000,
    );
  });
});
