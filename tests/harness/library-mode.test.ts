/* Library emission mode — the K-fixture conformance suite over the
 * ratified design. Every fixture runs TWICE, once per emission, with the
 * profile's `emission` field flipped by the harness, and outputs (sink
 * message text included) must be identical across the two runs — the
 * "reference/differential emission" posture; library mode has no fallback
 * concept.
 *
 *   K1  symbols-exact       nm over the archive: prefix-carrying external
 *                           definitions equal the declared set, both
 *                           directions; no prefix-carrying undefineds
 *   K2  scalar-roundtrip    f64 (-0, NaN, MAX_SAFE_INTEGER), bool, and the
 *                           u8/u32/i32 plumbing classes
 *   K3  buffer-roundtrip    string/bytes in/out, NUL-termination, NULL with
 *                           len 0, BOTH arena postures over one library
 *   K4  init-rerun          three identical sessions (globals, refcounted
 *                           state, run-once guards all reset)
 *   K5  trap-to-sink-once   the range trap's message + address exactly
 *                           once, no process termination from compiled
 *                           code — structured (SC4014, the trapping
 *                           export's symbol, default text, no remediation
 *                           on this no-teachings profile); a trap during
 *                           init routes the same with the init symbol
 *   K6  pre-registration    a trap before sink registration aborts
 *   K7  escaped-throw       "Uncaught ..." reaches the sink as the
 *                           structured message's text (SC4013); the
 *                           poisoned library aborts every later entry
 *                           deterministically
 *   K8  ambient-audit       no undefined refs to sigaction/signal/
 *                           pthread_create/atexit anywhere in the archive
 *   K9  refusals            SC4002/SC4003/SC4004/SC4005/SC4007 with the
 *                           profile-teaching rider (SC4001 has its own
 *                           suite in library-profile.test.ts)
 *   K10 sanitized-lane      K4/K5/K7 re-run under ASan + the RC audit
 *                           (arming the per-session zero-live-heap seam)
 *   K11 trap-teaching       the structured sink-message encoding: a
 *                           host-contract trap arrives as 0x01 text 0x1F
 *                           code 0x1F symbol 0x1F remediation (exact byte
 *                           layout through the spec's parse rule), an
 *                           0x01-led throw rides the sink verbatim (no
 *                           "Uncaught " prefix), and the human text always
 *                           LEADS the buffer with a printable byte — the
 *                           plain-text-degradation pin the marker's
 *                           unambiguity rests on
 *   K12 runtime-trap family runtime-DETECTED traps arrive structured
 *                           unconditionally: a teachings-declared profile
 *                           overlays its text/remediation for the trap
 *                           kind's code (SC4014 here); an undeclared code
 *                           keeps the baseline human line as field 0 and
 *                           carries NO remediation field (fields=3) — the
 *                           no-teachings default is pinned by K5/K7 over
 *                           the teachings-free traps profile
 *   K13 npm-posture         bare npm specifiers are static-or-refuse: an
 *                           eligible package (own .d.ts, unminified JS,
 *                           no transform markers) compiles statically
 *                           into the library graph, its own npm deps
 *                           judged by the same bar; every ineligible one
 *                           refuses SC4020 naming the failed bar — never
 *                           a generic SC1010/SC2013 — and builtins keep
 *                           the SC4005 async_free story
 *   K14 determinism-fences  the ask-5 deny-by-manifest-id surface: a
 *                           reached fenced static surface refuses SC4008
 *                           (id + name + attributed teaching note, both
 *                           selector forms), unreached fences emit
 *                           byte-identical code to a fence-free build,
 *                           the generalized teachings map decorates any
 *                           refusal by code or manifest id, and fencing
 *                           an already-refusing surface only adds the
 *                           note (its own code survives)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compileLibrary } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const fixtureRoot = join(repoRoot, "tests/library-mode");
const platformTest = process.env["SCRIPTC_PORTABLE_ONLY"] === "1" ? test.skip : test;
/* The plain and SCRIPTC_SAN=1 suites may run concurrently by design (the
 * suite lock is per flavor) and this suite runs the same ordinary builds in
 * both, so the cache path carries the SUITE flavor — otherwise the two runs
 * race ar/ranlib in shared build dirs. The per-build `-san` tag below is a
 * different axis: it distinguishes explicitly-sanitized BUILDS within one
 * suite (K10). */
const flavor = process.env["SCRIPTC_SAN"] === "1" ? "san" : "plain";
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/library-mode", flavor);

type Emission = "llvm" | "c";
const EMISSIONS: Emission[] = ["llvm", "c"];

interface BuildOpts {
  sanitize?: boolean;
  /** Patch a declared result-reset symbol into the profile (K3's second
   * arena posture). */
  declaredReset?: string;
}

/** Build one fixture's library archive for one emission: the fixture's
 * profile.json is patched (emission flipped, entry made absolute, posture
 * overridden when asked) into the build dir, then compiled through the
 * real compileLibrary pipeline. */
async function buildLibrary(
  fixture: string,
  emission: Emission,
  opts: BuildOpts = {},
): Promise<{ archive: string; outDir: string }> {
  const dir = join(fixtureRoot, fixture);
  const tag = `${fixture}-${emission}${opts.sanitize ? "-san" : ""}${opts.declaredReset !== undefined ? "-reset" : ""}`;
  const outDir = join(cacheDir, tag);
  mkdirSync(outDir, { recursive: true });
  const profile = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")) as {
    entry: string;
    emission: string;
    abi: { result_reset_symbol: string | null };
  };
  profile.emission = emission;
  profile.entry = join(dir, profile.entry);
  if (opts.declaredReset !== undefined) profile.abi.result_reset_symbol = opts.declaredReset;
  const profilePath = join(outDir, "profile.json");
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  const result = await compileLibrary({
    profilePath,
    outDir,
    sanitize: opts.sanitize ?? false,
  });
  if (!result.ok) {
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  }
  expect(result.backend).toBe(emission);
  return { archive: result.archivePath, outDir };
}

function buildProbe(
  fixture: string,
  archive: string,
  outDir: string,
  opts: { sanitize?: boolean; defines?: string[] } = {},
): string {
  const bin = join(outDir, "probe");
  execFileSync("clang", [
    "-std=c11",
    ...(opts.sanitize ? ["-fsanitize=address"] : []),
    ...(opts.defines ?? []).map((d) => `-D${d}`),
    join(fixtureRoot, fixture, "probe.c"),
    archive,
    "-lm",
    "-o", bin,
  ]);
  return bin;
}

function runProbe(bin: string, args: string[] = []): { stdout: string; status: number | null; signal: string | null } {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 60_000 });
  return { stdout: r.stdout ?? "", status: r.status, signal: r.signal };
}

/** nm over the archive: [definedExternal, undefined] symbol sets, macOS/
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
  const defined = parse(execFileSync("nm", ["-gU", archive], { encoding: "utf8" }));
  const undef = parse(execFileSync("nm", ["-u", archive], { encoding: "utf8" }));
  return { defined, undef };
}

/* ── K2 + K1 + K8: scalars ─────────────────────────────────────────────── */

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

const SCALARS_SYMBOLS = [
  "kt_add", "kt_passthrough", "kt_neg_zero", "kt_is_nan", "kt_invert", "kt_plumb",
  "kt_init", "kt_set_panic_sink", "kt_collect",
];

describe.each(EMISSIONS)("library mode, %s emission", (emission) => {
  test("K1/K2/K8: scalar round-trips, symbol exactness, ambient audit", async () => {
    const { archive, outDir } = await buildLibrary("scalars", emission);

    // K2: the scripted call sequence.
    const probe = buildProbe("scalars", archive, outDir);
    const run = runProbe(probe);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(SCALARS_EXPECTED);

    // K1: prefix-carrying external definitions equal the declared set
    // exactly, both directions; no prefix-carrying undefineds.
    const { defined, undef } = nmSymbols(archive);
    const prefixDefined = [...defined].filter((s) => s.startsWith("kt_")).sort();
    expect(prefixDefined).toEqual([...SCALARS_SYMBOLS].sort());
    expect([...undef].filter((s) => s.startsWith("kt_"))).toEqual([]);

    // K8: the mechanical ambient audit — the archive references none of
    // the process-disposition or threading surface, and registers no
    // atexit handlers (library teardown is the reset registry).
    for (const banned of ["sigaction", "signal", "pthread_create", "atexit", "setvbuf"]) {
      expect(undef.has(banned), `undefined reference to ${banned}`).toBe(false);
    }
    // The structural async_free consequence: no fiber/event-loop/timer/
    // child-process symbol is DEFINED in the archive (scr_async.c and
    // scr_child.c never joined the link) and none is REFERENCED by a
    // linked unit (a missed inter-unit reference would surface here, the
    // backstop the design asks for instead of a hand-maintained map).
    const loopish = /^scr_(loop|fiber|on_fiber|timer|set_timeout|set_interval|set_immediate|next_tick|child|spawn)/;
    expect([...defined].filter((s) => loopish.test(s))).toEqual([]);
    expect([...undef].filter((s) => loopish.test(s))).toEqual([]);
  });

  /* ── K12: the npm posture's compile side ─────────────────────────────── */

  test("K12: an eligible npm package (and its own dep) compiles statically", async () => {
    const { archive, outDir } = await buildLibrary("npm-static", emission);
    const probe = buildProbe("npm-static", archive, outDir);
    const run = runProbe(probe);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    // scaled: mathkit.scale (which itself calls mathdep.twice) + OFFSET —
    // values computed by the packages' shipped JS, statically compiled;
    // tail: the node:path builtin riding the same graph (async_free, so
    // SC4005 has nothing to say).
    expect(run.stdout).toBe(
      `npm-static ready
scaled: 37
tail: c.txt (len 5)
`,
    );
    // K1 discipline holds with npm code in the graph: prefix-carrying
    // definitions are exactly the declared set, no prefix undefineds.
    const { defined, undef } = nmSymbols(archive);
    expect([...defined].filter((s) => s.startsWith("kn_")).sort()).toEqual([
      "kn_collect", "kn_init", "kn_scaled", "kn_set_panic_sink", "kn_tail",
    ]);
    expect([...undef].filter((s) => s.startsWith("kn_"))).toEqual([]);
  });

  /* ── K3: buffers, both arena postures over one library ──────────────────── */

  const BUFFERS_EXPECTED = `buffers ready
shout: ABC! (len 4, nul 1)
both live: ABC! / a-b-c
strlen empty (NULL, 0): 0
strlen utf8: 4
wrap: len 4 bytes 60 1 2 62
wrap empty: len 2 bytes 60 62
`;

  test("K3: buffer round-trips + lifetime, auto-reset posture", async () => {
    const { archive, outDir } = await buildLibrary("buffers", emission);
    const probe = buildProbe("buffers", archive, outDir);
    const run = runProbe(probe);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(BUFFERS_EXPECTED);
  });

  test("K3: buffer lifetime, declared-reset posture (results accumulate)", async () => {
    const { archive, outDir } = await buildLibrary("buffers", emission, { declaredReset: "kb_reset" });
    const probe = buildProbe("buffers", archive, outDir, { defines: ["DECLARED_RESET"] });
    const run = runProbe(probe);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(BUFFERS_EXPECTED);
  });

  /* ── K4: init re-run determinism ─────────────────────────────────────── */

  const SESSION = `session start counter=0
bump: 1 2
note: 1 2
indexed: 72100
recall: a,b
`;

  test("K4: three init sessions are byte-identical", async () => {
    const { archive, outDir } = await buildLibrary("reinit", emission);
    const probe = buildProbe("reinit", archive, outDir);
    const run = runProbe(probe);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(SESSION + SESSION + SESSION);
  });

  /* ── K5/K6/K7: the trap channel ──────────────────────────────────────── */

  test("K5: a trap delivers to the sink exactly once, host survives", async () => {
    const { archive, outDir } = await buildLibrary("traps", emission);
    const probe = buildProbe("traps", archive, outDir);
    const run = runProbe(probe, ["trap"]);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    // The runtime-detected trap arrives structured (K12's no-teachings
    // default): field 0 is the runtime's own line unchanged (its newline
    // intact), the code names the range kind, the symbol names the export
    // the host called, and no remediation field exists on this
    // teachings-free profile.
    expect(run.stdout).toBe(
      `traps ready
sink[1]:
text=[scriptc: RangeError: array index 9 out of bounds (length 3)
]
code=[SC4014]
symbol=[kp_boom]
fields=3 text_printable=1
addr: nonzero
survived, sink_calls=1
`,
    );
  });

  test("K5: a trap during init routes to the sink the same way", async () => {
    const { archive, outDir } = await buildLibrary("init-trap", emission);
    const probe = buildProbe("init-trap", archive, outDir);
    const run = runProbe(probe);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    // Init counts as an entry: the structured message names the init
    // symbol itself as the trapping entry.
    expect(run.stdout).toBe(
      `about to trap
sink[1]:
text=[scriptc: RangeError: array index 7 out of bounds (length 3)
]
code=[SC4014]
symbol=[ki_init]
fields=3 text_printable=1
survived init trap, sink_calls=1
`,
    );
  });

  test("K7: an escaped throw reaches the sink as 'Uncaught ...'", async () => {
    const { archive, outDir } = await buildLibrary("traps", emission);
    const probe = buildProbe("traps", archive, outDir);
    const run = runProbe(probe, ["throw"]);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    // The escaped-exception renderer's "Uncaught ..." line is the
    // structured message's text; the code names the escaped-exception
    // kind and the symbol the entry the throw escaped through.
    expect(run.stdout).toBe(
      `traps ready
sink[1]:
text=[Uncaught Error: kaput
]
code=[SC4013]
symbol=[kp_fail]
fields=3 text_printable=1
addr: nonzero
survived, sink_calls=1
`,
    );
  });

  test("K7: the poisoned library aborts every later entry", async () => {
    const { archive, outDir } = await buildLibrary("traps", emission);
    const probe = buildProbe("traps", archive, outDir);
    const run = runProbe(probe, ["poisoned"]);
    expect(run.signal).toBe("SIGABRT");
    expect(run.stdout).toContain("poisoned now");
    expect(run.stdout).not.toContain("UNREACHABLE");
  });

  test("K6: a trap before sink registration aborts", async () => {
    const { archive, outDir } = await buildLibrary("traps", emission);
    const probe = buildProbe("traps", archive, outDir);
    const run = runProbe(probe, ["preregister"]);
    expect(run.signal).toBe("SIGABRT");
    expect(run.stdout).not.toContain("UNREACHABLE");
  });

  /* ── K11: the structured trap-teaching encoding ──────────────────────── */

  test("K11: a host-contract trap arrives structured, exact byte layout", async () => {
    const { archive, outDir } = await buildLibrary("teach", emission);
    const probe = buildProbe("teach", archive, outDir);
    const run = runProbe(probe, ["structured"]);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    // The probe implements the spec's parse rule: byte 0 is the 0x01
    // marker, the bytes after it split on 0x1F into exactly four fields —
    // the profile's teaching text (its authored newline intact), the
    // compiler-threaded code and trapping symbol, and the profile's
    // remediation. fields=4 pins that the emitter appends nothing past
    // the remediation.
    expect(run.stdout).toBe(
      `teach ready
sink[1]:
text=[inbound bytes length does not fit the marshalling class — the host and this library disagree about the call contract
]
code=[SC4012]
symbol=[kv_wrap]
remediation=[pass the buffer's true byte length; lengths must stay below 2^53]
fields=4 text_printable=1
survived, sink_calls=1
`,
    );
  });

  test("K11: an 0x01-led thrown Error message rides the sink verbatim", async () => {
    const { archive, outDir } = await buildLibrary("teach", emission);
    const probe = buildProbe("teach", archive, outDir);
    const run = runProbe(probe, ["verbatim"]);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    // The facade-authored structured teaching (embedder-prefixed NS code)
    // arrives byte-for-byte: no "Uncaught " prefix ahead of the marker,
    // no added trailing newline inside the remediation.
    expect(run.stdout).toBe(
      `teach ready
sink[1]:
text=[tag 99 does not name a bare message arm of this core]
code=[NS1207]
symbol=[kv_dispatch]
remediation=[rebuild the app so the compiled core and the host shim come from one build]
fields=4 text_printable=1
survived, sink_calls=1
`,
    );
  });

  test("K11: an 0x01-led thrown string rides the sink verbatim", async () => {
    const { archive, outDir } = await buildLibrary("teach", emission);
    const probe = buildProbe("teach", archive, outDir);
    const run = runProbe(probe, ["verbatim-str"]);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    // Three fields, no remediation: the whole fourth field is absent, so
    // the parser counts exactly three.
    expect(run.stdout).toBe(
      `teach ready
sink[1]:
text=[string-thrown teaching]
code=[NS0002]
symbol=[kv_teach_str]
fields=3 text_printable=1
survived, sink_calls=1
`,
    );
  });

  /* ── K12: the runtime-detected trap family arrives structured ────────── */

  test("K12: a runtime trap overlays the profile's teaching and remediation", async () => {
    const { archive, outDir } = await buildLibrary("teach", emission);
    const probe = buildProbe("teach", archive, outDir);
    // The profile declares SC4014 (range) teaching + remediation: the
    // funnel-assembled message carries the overlay text as field 0 (its
    // authored newline intact), the range code, the trapping export's
    // symbol, and the remediation as the fourth field. text_printable=1
    // is the plain-text-degradation pin: the human text still LEADS the
    // buffer with a printable byte.
    const run = runProbe(probe, ["runtime-trap"]);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      `teach ready
sink[1]:
text=[this core read past the end of a collection — an index the embedding fed it does not exist
]
code=[SC4014]
symbol=[kv_boom_runtime]
remediation=[clamp indices to the collection's length before calling into the core]
fields=4 text_printable=1
survived, sink_calls=1
`,
    );
  });

  test("K12: an undeclared code keeps the default text and no remediation", async () => {
    const { archive, outDir } = await buildLibrary("teach", emission);
    const probe = buildProbe("teach", archive, outDir);
    // Nothing is declared for the escaped-exception code (SC4013): field 0
    // is the baseline "Uncaught ..." line unchanged and the whole
    // remediation field is absent — exactly the spec's worked example 2.
    const run = runProbe(probe, ["runtime-throw"]);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      `teach ready
sink[1]:
text=[Uncaught Error: kaput
]
code=[SC4013]
symbol=[kv_fail_runtime]
fields=3 text_printable=1
survived, sink_calls=1
`,
    );
  });

  /* ── K10: the sanitized lane (ASan + the RC audit's re-init seam) ────── */

  platformTest("K10: K4 under ASan + RC audit (zero live heap across re-init)", async () => {
    const { archive, outDir } = await buildLibrary("reinit", emission, { sanitize: true });
    const probe = buildProbe("reinit", archive, outDir, { sanitize: true });
    const run = runProbe(probe);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(SESSION + SESSION + SESSION);
  });

  platformTest("K10: K5/K7 under ASan", async () => {
    const { archive, outDir } = await buildLibrary("traps", emission, { sanitize: true });
    const probe = buildProbe("traps", archive, outDir, { sanitize: true });
    const trap = runProbe(probe, ["trap"]);
    expect(trap.status).toBe(0);
    expect(trap.stdout).toContain("survived, sink_calls=1");
    const thrown = runProbe(probe, ["throw"]);
    expect(thrown.status).toBe(0);
    expect(thrown.stdout).toContain("text=[Uncaught Error: kaput");
  });
});

/* ── K9: the SC4xxx refusal family, end to end through compileLibrary ─────── */

let refusalCounter = 0;
async function refusal(
  source: string,
  profilePatch: Record<string, unknown>,
  emission: Emission = "c",
): Promise<{ code: string; message: string; hint?: string; note?: string; file: string }[]> {
  const outDir = join(cacheDir, `refusal-${refusalCounter++}`);
  mkdirSync(outDir, { recursive: true });
  const entry = join(outDir, "lib.ts");
  writeFileSync(entry, source);
  const profile = {
    profile_format: 1,
    name: "refusal-fixture",
    entry,
    emission,
    abi: {
      prefix: "kx_",
      init_symbol: "kx_init",
      sink_register_symbol: "kx_set_panic_sink",
      collect_symbol: null,
      result_reset_symbol: null,
    },
    exports: [] as unknown[],
    ...profilePatch,
  };
  const profilePath = join(outDir, "profile.json");
  writeFileSync(profilePath, JSON.stringify(profile));
  const result = await compileLibrary({ profilePath, outDir });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  return result.diagnostics.map((d) => ({
    code: d.code,
    message: d.message,
    ...(d.hint !== undefined ? { hint: d.hint } : {}),
    ...(d.note !== undefined ? { note: d.note } : {}),
    file: d.loc.file,
  }));
}

async function acceptance(
  source: string,
  profilePatch: Record<string, unknown>,
  emission: Emission = "c",
): Promise<void> {
  const outDir = join(cacheDir, `acceptance-${refusalCounter++}`);
  mkdirSync(outDir, { recursive: true });
  const entry = join(outDir, "lib.ts");
  writeFileSync(entry, source);
  const profilePath = join(outDir, "profile.json");
  writeFileSync(
    profilePath,
    JSON.stringify({
      profile_format: 1,
      name: "acceptance-fixture",
      entry,
      emission,
      abi: {
        prefix: "kx_",
        init_symbol: "kx_init",
        sink_register_symbol: "kx_set_panic_sink",
        collect_symbol: null,
        result_reset_symbol: null,
      },
      exports: [],
      ...profilePatch,
    }),
  );
  const result = await compileLibrary({ profilePath, outDir });
  expect(result.ok, result.ok ? undefined : result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")).toBe(true);
}

describe("K9: library-mode refusals", () => {
  test("SC4002: unmapped export name", async () => {
    const diags = await refusal(`export function real(): number { return 1; }\n`, {
      exports: [{ export: "nope", symbol: "kx_nope", params: [], returns: "f64" }],
    });
    expect(diags[0]!.code).toBe("SC4002");
    expect(diags[0]!.message).toContain("'nope'");
    expect(diags[0]!.hint).toContain("facade");
  });

  test("SC4003: a parameter outside the marshalling classes", async () => {
    const diags = await refusal(
      `export function take(r: { a: number }): number { return r.a; }\n`,
      { exports: [{ export: "take", symbol: "kx_take", params: ["f64"], returns: "f64" }] },
    );
    expect(diags[0]!.code).toBe("SC4003");
    expect(diags[0]!.message).toContain("parameter 1");
    expect(diags[0]!.hint).toContain("asks 2/3");
  });

  test("SC4003: arity mismatch between profile and signature", async () => {
    const diags = await refusal(`export function two(a: number, b: number): number { return a + b; }\n`, {
      exports: [{ export: "two", symbol: "kx_two", params: ["f64"], returns: "f64" }],
    });
    expect(diags[0]!.code).toBe("SC4003");
    expect(diags[0]!.message).toContain("2 parameter(s)");
  });

  test("SC4004: a mapped async export, with the profile teaching as the attributed note", async () => {
    const diags = await refusal(`export async function tick(): Promise<number> { return 1; }\n`, {
      exports: [{ export: "tick", symbol: "kx_tick", params: [], returns: "f64" }],
      determinism: { teachings: { async: "use the host scheduler entry instead" } },
    });
    expect(diags[0]!.code).toBe("SC4004");
    expect(diags[0]!.hint).toContain("synchronous facade");
    // The teaching arrives as its own visibly-attributed note — the
    // tool's hint stays the tool's.
    expect(diags[0]!.note).toBe("from the 'refusal-fixture' profile: use the host scheduler entry instead");
  });

  test("SC4005: a timer anywhere in the graph, teaching as the attributed note", async () => {
    const diags = await refusal(`setTimeout(() => {}, 1);\nexport function f(): number { return 1; }\n`, {
      exports: [{ export: "f", symbol: "kx_f", params: [], returns: "f64" }],
      determinism: { teachings: { SC4005: "schedule through the embedder frame loop" } },
    });
    expect(diags[0]!.code).toBe("SC4005");
    expect(diags[0]!.message).toContain("timers");
    expect(diags[0]!.note).toBe("from the 'refusal-fixture' profile: schedule through the embedder frame loop");
  });

  test("SC4007: a generic export", async () => {
    const diags = await refusal(
      `export function id<T>(x: T): T { return x; }\nconsole.log(id(1));\n`,
      { exports: [{ export: "id", symbol: "kx_id", params: ["f64"], returns: "f64" }] },
    );
    expect(diags[0]!.code).toBe("SC4007");
    expect(diags[0]!.hint).toContain("concrete instantiation");
  });
});

/* ── K12: npm static-or-refuse, the refusal side ─────────────────────────
 * The entries live in the npm-refuse fixture dir (its vendored
 * node_modules is what the specifiers resolve against); the profile is
 * synthesized per test like K9's. Emission never engages — SC4020 is a
 * frontend verdict — so one lane suffices. */
let npmRefusalCounter = 0;
async function npmRefusal(
  entryFile: string,
  exports: unknown[],
  profilePatch: Record<string, unknown> = {},
): Promise<{ code: string; message: string; hint?: string; note?: string; file: string }[]> {
  const outDir = join(cacheDir, `npm-refusal-${npmRefusalCounter++}`);
  mkdirSync(outDir, { recursive: true });
  const profile = {
    profile_format: 1,
    name: "npm-refusal-fixture",
    entry: join(fixtureRoot, "npm-refuse", entryFile),
    emission: "c",
    abi: {
      prefix: "kx_",
      init_symbol: "kx_init",
      sink_register_symbol: "kx_set_panic_sink",
      collect_symbol: null,
      result_reset_symbol: null,
    },
    exports,
    ...profilePatch,
  };
  const profilePath = join(outDir, "profile.json");
  writeFileSync(profilePath, JSON.stringify(profile));
  const result = await compileLibrary({ profilePath, outDir });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  return result.diagnostics.map((d) => ({
    code: d.code,
    message: d.message,
    ...(d.hint !== undefined ? { hint: d.hint } : {}),
    ...(d.note !== undefined ? { note: d.note } : {}),
    file: d.loc.file,
  }));
}

describe("K13: library-mode npm refusals (SC4020, static-or-refuse)", () => {
  test("build-transform markers refuse with the failed bar named", async () => {
    const diags = await npmRefusal("lib-markers.ts", [{ export: "f", symbol: "kx_f", params: [], returns: "string" }]);
    expect(diags.map((d) => d.code)).toEqual(["SC4020"]);
    expect(diags[0]!.message).toContain("'webbundle'");
    expect(diags[0]!.message).toContain("build-transform markers");
    expect(diags[0]!.hint).toContain("vendor");
    // Anchored at the import site in the entry, not a whole-file blur.
    expect(diags[0]!.file.endsWith("lib-markers.ts")).toBe(true);
  });

  test("minified shipped JS refuses", async () => {
    const diags = await npmRefusal("lib-minified.ts", [
      { export: "f", symbol: "kx_f", params: ["f64", "f64"], returns: "f64" },
    ]);
    expect(diags.map((d) => d.code)).toEqual(["SC4020"]);
    expect(diags[0]!.message).toContain("'slimmed'");
    expect(diags[0]!.message).toContain("looks minified");
  });

  test("no own .d.ts refuses by name — never the generic import fence", async () => {
    const diags = await npmRefusal("lib-untyped.ts", [
      { export: "f", symbol: "kx_f", params: ["f64", "f64"], returns: "f64" },
    ]);
    // The package resolves at runtime (Node would load it) but ships no
    // types: the library answer is the bar's, not SC1010's "nothing
    // installed resolves it" nor SC2013's --dynamic teaching.
    expect(diags.map((d) => d.code)).toEqual(["SC4020"]);
    expect(diags[0]!.message).toContain("'untyped'");
    expect(diags[0]!.message).toContain("no own .d.ts");
  });

  test("the profile teaching rides SC4020 as the attributed note", async () => {
    const diags = await npmRefusal(
      "lib-markers.ts",
      [{ export: "f", symbol: "kx_f", params: [], returns: "string" }],
      { determinism: { teachings: { SC4020: "request the vendored copy from the embedder SDK" } } },
    );
    expect(diags[0]!.code).toBe("SC4020");
    expect(diags[0]!.note).toBe("from the 'npm-refusal-fixture' profile: request the vendored copy from the embedder SDK");
  });

  test("a builtin pulling the event loop keeps the SC4005 story, not a new fence", async () => {
    const diags = await refusal(
      `import { setTimeout as later } from "node:timers";\nexport function f(): number { later(() => {}, 1); return 1; }\n`,
      { exports: [{ export: "f", symbol: "kx_f", params: [], returns: "f64" }] },
    );
    expect(diags[0]!.code).toBe("SC4005");
    expect(diags[0]!.message).toContain("timers");
  });
});

/* ── K14: the ask-5 determinism fences (spec §1–§2) ───────────────────────
 * The profile's `determinism.fences` deny surfaces by surface-manifest id
 * at compile time. Reached STATIC surfaces refuse SC4008 with the fence's
 * teaching as the attributed note; fenced surfaces the static tier
 * refuses anyway keep their own code with the teaching riding it; and the
 * generalized `teachings` map attaches text to any refusal by code or
 * manifest id. Both emissions run the refusal cases too — the refusal is
 * pre-emission, but the profile pins the emission and conformance asserts
 * the answer is emission-invariant. */

const WORKED_FENCES = [
  { id: "stdlib.math.random", teaching: "randomness is an effect: request it from the host and receive it as a Msg." },
  { prefix: "node-builtin.fs.", teaching: "files are effects: declare reads and writes as commands the host executes." },
  { prefix: "node-builtin.net.", teaching: "network is an effect: declare requests as commands; responses arrive as Msgs." },
  { prefix: "node-builtin.os.", teaching: "machine identity is an effect: ask the host." },
  { prefix: "node-builtin.crypto.", teaching: "randomness and digests come from the host." },
  // The remaining ambient families the determinism attestation demotes on
  // — with these, the fence set covers every attestation-known surface
  // (the ask-5 §4 invariant's full-fence profile).
  { prefix: "stdlib.date.", teaching: "time is an effect: the host passes the clock in as a Msg." },
  { prefix: "node-builtin.process.", teaching: "process ambient state and authority belong to the host." },
  { prefix: "node-builtin.perf_hooks.", teaching: "the monotonic clock is the host's." },
];

describe.each(EMISSIONS)("K14: determinism fences, %s emission", (emission) => {
  test("a reached id-fenced surface refuses SC4008 with code, id, and attributed teaching", async () => {
    const diags = await refusal(
      `export function roll(): number { return Math.random(); }\n`,
      {
        exports: [{ export: "roll", symbol: "kx_roll", params: [], returns: "f64" }],
        determinism: { fences: WORKED_FENCES },
      },
      emission,
    );
    expect(diags.map((d) => d.code)).toEqual(["SC4008"]);
    expect(diags[0]!.message).toContain("'stdlib.math.random'");
    expect(diags[0]!.message).toContain("Math.random");
    expect(diags[0]!.note).toBe(
      "from the 'refusal-fixture' profile: randomness is an effect: request it from the host and receive it as a Msg.",
    );
    // Anchored at the reaching construct, not the profile file.
    expect(diags[0]!.file.endsWith("lib.ts")).toBe(true);
  });

  test("Date.now under the full-fence profile refuses SC4008 naming the Date entry", async () => {
    // The §4 invariant's teeth: before the Date family had manifest
    // entries, Date.now() compiled under every declarable fence set and
    // attested `deterministic: false` post hoc — now the full-fence
    // profile refuses it at compile time.
    const diags = await refusal(
      `export function stamp(): number { return Date.now(); }\n`,
      {
        exports: [{ export: "stamp", symbol: "kx_stamp", params: [], returns: "f64" }],
        determinism: { fences: WORKED_FENCES },
      },
      emission,
    );
    expect(diags.map((d) => d.code)).toEqual(["SC4008"]);
    expect(diags[0]!.message).toContain("'stdlib.date.now'");
    expect(diags[0]!.message).toContain("Date.now");
    expect(diags[0]!.note).toContain("time is an effect");
    expect(diags[0]!.file.endsWith("lib.ts")).toBe(true);
  });

  test("an exact Date.valueOf fence does not also fence getTime", async () => {
    const exportProfile = {
      exports: [{ export: "read", symbol: "kx_read", params: [], returns: "f64" }],
      determinism: { fences: [{ id: "stdlib.date.valueOf" }] },
    };
    await acceptance(
      `export function read(): number { return new Date(0).getTime(); }\n`,
      exportProfile,
      emission,
    );
    const diags = await refusal(
      `export function read(): number { return new Date(0).valueOf(); }\n`,
      exportProfile,
      emission,
    );
    expect(diags.map((d) => d.code)).toEqual(["SC4008"]);
    expect(diags[0]!.message).toContain("'stdlib.date.valueOf'");
  });

  test("a process.env read under the full-fence profile refuses SC4008 naming the process entry", async () => {
    const diags = await refusal(
      `export function home(): number { return (process.env["HOME"] ?? "").length; }\n`,
      {
        exports: [{ export: "home", symbol: "kx_home", params: [], returns: "f64" }],
        determinism: { fences: WORKED_FENCES },
      },
      emission,
    );
    expect(diags.map((d) => d.code)).toEqual(["SC4008"]);
    expect(diags[0]!.message).toContain("'node-builtin.process.env'");
    expect(diags[0]!.note).toContain("process ambient state");
  });

  test("a live machine-state read under the full-fence profile refuses SC4008 naming its entry", async () => {
    // process.stdout.isTTY joined the attestation's demote set as a
    // correction (a live terminal-attachment read); the family fence must
    // deny it or the §4 invariant would leak through it.
    const diags = await refusal(
      `export function tty(): number { return process.stdout.isTTY ? 1 : 0; }\n`,
      {
        exports: [{ export: "tty", symbol: "kx_tty", params: [], returns: "f64" }],
        determinism: { fences: WORKED_FENCES },
      },
      emission,
    );
    expect(diags.map((d) => d.code)).toEqual(["SC4008"]);
    expect(diags[0]!.message).toContain("'node-builtin.process.isTTY'");
  });

  test("a reached prefix-fenced surface refuses SC4008 naming the covered member id", async () => {
    const diags = await refusal(
      `import { readFileSync } from "node:fs";\nexport function f(): number { return readFileSync("x", "utf8").length; }\n`,
      {
        exports: [{ export: "f", symbol: "kx_f", params: [], returns: "f64" }],
        determinism: { fences: WORKED_FENCES },
      },
      emission,
    );
    expect(diags.map((d) => d.code)).toEqual(["SC4008"]);
    expect(diags[0]!.message).toContain("'node-builtin.fs.readFileSync'");
    expect(diags[0]!.note).toContain("files are effects");
  });

  test("unreached fences compile at zero cost: the emitted code is byte-identical", async () => {
    // ONE entry file feeds both builds (emitted C/LLVM embeds the entry's
    // path in provenance comments; the fence's cost is what's measured,
    // not the build directory's spelling).
    const entryDir = join(cacheDir, `fence-zerocost-${emission}`);
    mkdirSync(entryDir, { recursive: true });
    const entry = join(entryDir, "lib.ts");
    writeFileSync(entry, `export function f(): number { return 41 + 1; }\n`);
    const emitted: string[] = [];
    for (const fenced of [false, true]) {
      const outDir = join(cacheDir, `fence-zerocost-${emission}-${fenced ? "fenced" : "plain"}`);
      mkdirSync(outDir, { recursive: true });
      const profilePath = join(outDir, "profile.json");
      writeFileSync(
        profilePath,
        JSON.stringify({
          profile_format: 1,
          name: "fence-zerocost",
          entry,
          emission,
          abi: {
            prefix: "kx_",
            init_symbol: "kx_init",
            sink_register_symbol: "kx_set_panic_sink",
            collect_symbol: null,
            result_reset_symbol: null,
          },
          exports: [{ export: "f", symbol: "kx_f", params: [], returns: "f64" }],
          ...(fenced ? { determinism: { fences: WORKED_FENCES } } : {}),
        }),
      );
      const result = await compileLibrary({ profilePath, outDir });
      if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      emitted.push(readFileSync(result.cPath, "utf8"));
    }
    expect(emitted[1]).toBe(emitted[0]);
  });

  test("a code-keyed teachings entry rides a non-fence refusal as the attributed note", async () => {
    const diags = await refusal(
      `export function f(): number { return "abc".normalize().length; }\n`,
      {
        exports: [{ export: "f", symbol: "kx_f", params: [], returns: "f64" }],
        determinism: { teachings: { SC2020: "host strings arrive normalized; never renormalize in a core" } },
      },
      emission,
    );
    expect(diags[0]!.code).toBe("SC2020");
    expect(diags[0]!.note).toBe(
      "from the 'refusal-fixture' profile: host strings arrive normalized; never renormalize in a core",
    );
  });

  test("a manifest-id-keyed teachings entry attaches to that surface's own refusal", async () => {
    const diags = await refusal(
      `export function f(): number { return Math.sin(1); }\n`,
      {
        exports: [{ export: "f", symbol: "kx_f", params: [], returns: "f64" }],
        determinism: { teachings: { "stdlib.math.sin": "trig runs in the host; request it as an effect" } },
      },
      emission,
    );
    // The surface's own code, not a fence code: the id key attaches text
    // to the refusal that already fires.
    expect(diags[0]!.code).toBe("SC2012");
    expect(diags[0]!.message).toContain("Math.sin");
    expect(diags[0]!.note).toBe("from the 'refusal-fixture' profile: trig runs in the host; request it as an effect");
  });

  test("fencing a surface the static tier refuses anyway changes only the message", async () => {
    const diags = await refusal(
      `export function f(): number { return Math.sin(1); }\n`,
      {
        exports: [{ export: "f", symbol: "kx_f", params: [], returns: "f64" }],
        determinism: { fences: [{ id: "stdlib.math.sin", teaching: "trig is host math" }] },
      },
      emission,
    );
    // The existing refusal's code survives — the fence never re-codes a
    // surface that already refuses; its teaching rides as the note.
    expect(diags[0]!.code).toBe("SC2012");
    expect(diags[0]!.note).toBe("from the 'refusal-fixture' profile: trig is host math");
  });
});
