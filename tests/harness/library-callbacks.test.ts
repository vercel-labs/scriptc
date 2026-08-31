/* Host-callback channels — the library mode's outbound seam (the profile's
 * `callbacks` array + `abi.callback_register_symbol`): the panic sink's
 * registration pattern generalized so compiled library code delivers bytes
 * and scalars to the embedder synchronously, on the calling thread,
 * replacing file-based relay between a long-running operation and its
 * host. Every fixture runs per emission and outputs must be identical
 * across the two (the library suites' reference/differential posture).
 *
 *   CB1 acceptance         registration return codes (0 known, -1
 *                          unknown/NULL), a service-shaped export
 *                          streaming N chunks through the bytes+u32
 *                          channel interleaved with computation — chunk
 *                          contents, order, and thread identity recorded
 *                          by the callback and asserted after the entry
 *                          returns — string/bool and u8/i32→u32 channels,
 *                          host returns riding i32/u32 back into compiled
 *                          code, re-registration routing to the new
 *                          context, and a NULL-fn clear followed by a
 *                          call: the SC4025 structured trap, exactly
 *                          once, naming the entry the host called
 *   CB2 unregistered call  a channel the host never registered traps
 *                          SC4025 through the sink (default text names
 *                          the channel; fields=3 — no remediation on a
 *                          teachings-free profile) and poisons the
 *                          instance: the next entry aborts
 *   CB3 pre-registration   the same trap before sink registration aborts
 *   CB4 symbols + audit    prefix-carrying external definitions equal the
 *                          declared set exactly (the register symbol
 *                          included); the ambient audit holds
 *   CB5 teaching overlay   SC4025 joins the runtime detected-trap family:
 *                          a teachings-declared profile overlays its text
 *                          and remediation (fields=4) through the
 *                          existing overlay table
 *   CB6 refusals           SC4024 — a call of a program-authored
 *                          signature-only ambient function the profile's
 *                          channels cannot serve (undeclared name, or a
 *                          TypeScript signature off the declared
 *                          classes), decorated with the profile's SC4024
 *                          teaching; a callback-free profile keeps the
 *                          ambient ReferenceError lowering (the standing
 *                          guarantee), and an unused declared channel is
 *                          legal capacity; standard/package declaration-file
 *                          ambient names stay builtins rather than becoming
 *                          channels, project-owned .d.ts declarations remain
 *                          authored callback surface (including undeclared
 *                          channel refusals), narrowed scalar return types
 *                          refuse because they cannot cover the host ABI's
 *                          whole domain, and unsupported program-authored
 *                          ambient shapes refuse instead of disappearing
 *                          (SC4001 profile shapes live in library-profile.test.ts)
 *   CB7 composition        a runtime-localized AND thread-instanced
 *                          archive with channels: two embedder threads
 *                          register different contexts, chunks route to
 *                          the registering thread's instance only, a
 *                          trap on thread A reaches A's sink exactly
 *                          once while B streams through and after the
 *                          window; the localized external surface is
 *                          exactly the declared set
 *   CB8 callback re-entry  every ABI entry is rejected as SC4026 while a
 *                          host callback is active; the attempted INNER
 *                          symbol wins, the original sink sees it, pure
 *                          registration retains its post-poison behavior,
 *                          and an independent thread instance survives
 *   CB9 sanitized lane     CB1, CB2, and callback re-entry re-run under ASan
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compileLibrary } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const fixtureDir = join(repoRoot, "tests/library-mode/callbacks");
const platformTest = process.env["SCRIPTC_PORTABLE_ONLY"] === "1" ? test.skip : test;
const localizationTest =
  process.env["SCRIPTC_PORTABLE_ONLY"] === "1" ||
  !(process.platform === "darwin" || process.platform === "linux" || process.platform === "win32")
    ? test.skip
    : platformTest;
const flavor = process.env["SCRIPTC_SAN"] === "1" ? "san" : "plain";
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/library-callbacks", flavor);

type Emission = "llvm" | "c";
const EMISSIONS: Emission[] = ["llvm", "c"];

interface BuildOpts {
  sanitize?: boolean;
  /** Base profile file inside the fixture dir (default profile.json). */
  profileFile?: string;
  /** Patched into the profile before compiling (CB5's overlay build). */
  determinism?: Record<string, unknown>;
  /** Entry override relative to the fixture dir (CB6's refusal sources). */
  entry?: string;
  /** Drop the callbacks surface entirely (CB6's callback-free posture). */
  stripCallbacks?: boolean;
  /** Keep only exports the alternate callback fixture implements. */
  stripBufferedExport?: boolean;
  tag?: string;
}

async function buildLibrary(
  emission: Emission,
  opts: BuildOpts = {},
): Promise<{ archive: string; outDir: string }> {
  const tag = `${opts.tag ?? "callbacks"}-${emission}${opts.sanitize ? "-san" : ""}`;
  const outDir = join(cacheDir, tag);
  mkdirSync(outDir, { recursive: true });
  const profile = JSON.parse(readFileSync(join(fixtureDir, opts.profileFile ?? "profile.json"), "utf8")) as {
    entry: string;
    emission: string;
    abi: Record<string, unknown>;
    callbacks?: unknown;
    determinism?: unknown;
  };
  profile.emission = emission;
  profile.entry = join(fixtureDir, opts.entry ?? profile.entry);
  if (opts.determinism !== undefined) profile.determinism = opts.determinism;
  if (opts.stripCallbacks === true) {
    delete profile.callbacks;
    delete profile.abi["callback_register_symbol"];
  }
  if (opts.stripBufferedExport === true) {
    profile.exports = (profile.exports as { export: string }[]).filter((e) => e.export !== "buffered");
  }
  const profilePath = join(outDir, "profile.json");
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  const result = await compileLibrary({ profilePath, outDir, sanitize: opts.sanitize ?? false });
  if (!result.ok) {
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  }
  expect(result.backend).toBe(emission);
  return { archive: result.archivePath, outDir };
}

/** Compile expecting refusal; returns the diagnostics. */
async function buildRefusal(emission: Emission, opts: BuildOpts): Promise<{ code: string; message: string; note?: string }[]> {
  const tag = `${opts.tag ?? "refusal"}-${emission}`;
  const outDir = join(cacheDir, tag);
  mkdirSync(outDir, { recursive: true });
  const profile = JSON.parse(readFileSync(join(fixtureDir, opts.profileFile ?? "profile.json"), "utf8")) as {
    entry: string;
    emission: string;
    determinism?: unknown;
  };
  profile.emission = emission;
  profile.entry = join(fixtureDir, opts.entry ?? profile.entry);
  if (opts.determinism !== undefined) profile.determinism = opts.determinism;
  const profilePath = join(outDir, "profile.json");
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  const result = await compileLibrary({ profilePath, outDir });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  return result.diagnostics.map((d) => ({ code: d.code, message: d.message, ...(d.note !== undefined ? { note: d.note } : {}) }));
}

function buildProbe(
  source: string,
  archive: string,
  outDir: string,
  opts: { sanitize?: boolean; pthread?: boolean } = {},
): string {
  const bin = join(outDir, "probe");
  execFileSync("clang", [
    "-std=c11",
    ...(opts.sanitize ? ["-fsanitize=address"] : []),
    ...(opts.pthread ? ["-pthread"] : []),
    join(fixtureDir, source),
    archive,
    "-lm",
    "-o", bin,
  ]);
  return bin;
}

function runProbe(bin: string, args: string[] = []): { stdout: string; status: number | null; signal: string | null } {
  // Library poison survival intentionally uses sink longjmp, which abandons
  // the active outer operation by contract. LeakSanitizer cannot model that
  // non-local recovery, while ASan still checks the memory-safety paths.
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: 60_000,
    env: process.env["SCRIPTC_SAN"] === "1" || bin.includes("-san/")
      ? { ...process.env, ASAN_OPTIONS: "detect_leaks=0" }
      : undefined,
  });
  return { stdout: r.stdout ?? "", status: r.status, signal: r.signal };
}

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

const RUN_EXPECTED = `reg unknown: -1
reg null-name: -1
reg emitChunk: 0
reg progress: 0
reg note: 0
reg mix: 0
callbacks ready
stream(4,3) = 31
log_a: 4 chunk(s), thread_ok=1
  seq=0 len=3 bytes=A3!
  seq=1 len=3 bytes=B4!
  seq=2 len=3 bytes=C5!
  seq=3 len=3 bytes=D6!
notes: [chunk 0 away last=0][chunk 1 away last=0][chunk 2 away last=0][chunk 3 away last=1]
stream(2,7) = 23
log_a: 2 chunk(s), thread_ok=1
  seq=0 len=3 bytes=A7!
  seq=1 len=3 bytes=B8!
notes: [chunk 0 away last=0][chunk 1 away last=1]
askHost(5) = 64
reg emitChunk again: 0
stream(1,9) = 12
log_a after reroute: 0 chunk(s)
log_b: 1 chunk(s), thread_ok=1
  seq=0 len=3 bytes=A9!
reg emitChunk clear: 0
sink[1]:
text=[scriptc: library callback 'emitChunk' invoked before registration
]
code=[SC4025]
symbol=[cb_stream]
fields=3 text_printable=1
addr: nonzero
survived, sink_calls=1
`;

const ORPHAN_EXPECTED = `callbacks ready
sink[1]:
text=[scriptc: library callback 'orphan' invoked before registration
]
code=[SC4025]
symbol=[cb_poke_orphan]
fields=3 text_printable=1
addr: nonzero
survived, sink_calls=1
`;

const CALLBACK_SYMBOLS = [
  "cb_init", "cb_set_panic_sink", "cb_collect", "cb_reset_results", "cb_set_callback",
  "cb_stream", "cb_buffered", "cb_ask_host", "cb_poke_orphan",
];

const REENTRY_SYMBOLS: Record<string, string> = {
  "reenter-export": "cb_stream",
  "reenter-init": "cb_init",
  "reenter-reset": "cb_reset_results",
  "reenter-collect": "cb_collect",
  "reenter-sink": "cb_set_panic_sink",
  "reenter-callback-unknown": "cb_set_callback",
};

function reentryExpected(symbol: string, overlay = false): string {
  const text = overlay ? "return from the callback before calling the library" : `scriptc: library entry '${symbol}' invoked from a host callback\n`;
  const remediation = overlay ? "schedule the operation for a later host-loop turn" : undefined;
  return `callbacks ready
sink[1]:
text=[${text}]
code=[SC4026]
symbol=[${symbol}]
${remediation === undefined ? "" : `remediation=[${remediation}]\n`}fields=${overlay ? 4 : 3} text_printable=1
addr: nonzero
post-poison register: 0
replacement-sink-calls=0
saved-result=[buffer 7]
`;
}

describe.each(EMISSIONS)("library host callbacks, %s emission", (emission) => {
  platformTest("CB1/CB4: the acceptance run, symbol exactness, ambient audit", async () => {
    const { archive, outDir } = await buildLibrary(emission);
    const probe = buildProbe("probe.c", archive, outDir, { pthread: true });
    const run = runProbe(probe, ["run"]);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(RUN_EXPECTED);

    // CB4: prefix-carrying external definitions equal the declared set
    // (the register symbol included), no prefix-carrying undefineds, and
    // the ambient audit holds with the callback machinery linked.
    const { defined, undef } = nmSymbols(archive);
    expect([...defined].filter((s) => s.startsWith("cb_")).sort()).toEqual([...CALLBACK_SYMBOLS].sort());
    expect([...undef].filter((s) => s.startsWith("cb_"))).toEqual([]);
    for (const banned of ["sigaction", "signal", "pthread_create", "atexit", "setvbuf"]) {
      expect(undef.has(banned), `undefined reference to ${banned}`).toBe(false);
    }
  });

  platformTest("CB2: an unregistered channel traps SC4025 and poisons the instance", async () => {
    const { archive, outDir } = await buildLibrary(emission);
    const probe = buildProbe("probe.c", archive, outDir, { pthread: true });
    // The sink's longjmp survives the trap; the poisoned instance then
    // aborts the next entry deterministically.
    const run = runProbe(probe, ["orphan"]);
    expect(run.signal).toBe("SIGABRT");
    expect(run.stdout).toBe(ORPHAN_EXPECTED);
    expect(run.stdout.includes("UNREACHABLE")).toBe(false);
  });

  platformTest("CB3: the unregistered-channel trap before sink registration aborts", async () => {
    const { archive, outDir } = await buildLibrary(emission);
    const probe = buildProbe("probe.c", archive, outDir, { pthread: true });
    const run = runProbe(probe, ["preregister"]);
    expect(run.signal).toBe("SIGABRT");
    expect(run.stdout).toBe("callbacks ready\n");
  });

  platformTest("CB5: SC4025 rides the teaching overlay table", async () => {
    const { archive, outDir } = await buildLibrary(emission, {
      tag: "teach",
      determinism: {
        teachings: { SC4025: "register every channel before starting an operation" },
        remediations: { SC4025: "call cb_set_callback for the named channel" },
      },
    });
    const probe = buildProbe("probe.c", archive, outDir, { pthread: true });
    const run = runProbe(probe, ["orphan"]);
    expect(run.signal).toBe("SIGABRT");
    expect(run.stdout).toBe(`callbacks ready
sink[1]:
text=[register every channel before starting an operation]
code=[SC4025]
symbol=[cb_poke_orphan]
remediation=[call cb_set_callback for the named channel]
fields=4 text_printable=1
addr: nonzero
survived, sink_calls=1
`);
  });

  platformTest("CB8: callback-time entries trap SC4026 before mutation and poison the instance", async () => {
    const { archive, outDir } = await buildLibrary(emission, { tag: "reentry" });
    const probe = buildProbe("probe.c", archive, outDir, { pthread: true });
    for (const [mode, symbol] of Object.entries(REENTRY_SYMBOLS)) {
      const run = runProbe(probe, [mode]);
      expect(run.signal, mode).toBe("SIGABRT");
      expect(run.stdout, mode).toBe(reentryExpected(symbol));
      expect(run.stdout.includes("UNREACHABLE"), mode).toBe(false);
    }
  });

  platformTest("CB8: SC4026 rides the teaching overlay table with its inner symbol", async () => {
    const { archive, outDir } = await buildLibrary(emission, {
      tag: "reentry-teach",
      determinism: {
        teachings: { SC4026: "return from the callback before calling the library" },
        remediations: { SC4026: "schedule the operation for a later host-loop turn" },
      },
    });
    const probe = buildProbe("probe.c", archive, outDir, { pthread: true });
    const run = runProbe(probe, ["reenter-reset"]);
    expect(run.signal).toBe("SIGABRT");
    expect(run.stdout).toBe(reentryExpected("cb_reset_results", true));
  });

  test("CB6: an undeclared host-callback reference refuses SC4024 with the profile teaching", async () => {
    const diags = await buildRefusal(emission, {
      tag: "undeclared",
      entry: "lib_undeclared.ts",
      determinism: { teachings: { SC4024: "channels are declared in the embedder profile" } },
    });
    expect(diags.map((d) => d.code)).toEqual(["SC4024"]);
    expect(diags[0]!.message).toContain("library callback 'sneaky'");
    expect(diags[0]!.message).toContain("declares no callback channel");
    expect(diags[0]!.note).toContain("channels are declared in the embedder profile");
  });

  test("CB6: an undeclared callback in a project .d.ts also refuses SC4024", async () => {
    const diags = await buildRefusal(emission, {
      tag: "undeclared-project-dts",
      entry: "lib_undeclared_project_dts.ts",
      determinism: { teachings: { SC4024: "channels are declared in the embedder profile" } },
    });
    expect(diags.map((d) => d.code)).toEqual(["SC4024"]);
    expect(diags[0]!.message).toContain("library callback 'sneaky'");
    expect(diags[0]!.message).toContain("declares no callback channel");
    expect(diags[0]!.note).toContain("channels are declared in the embedder profile");
  });

  test("CB6: callback returns must cover the full scalar ABI domain", async () => {
    const diags = await buildRefusal(emission, {
      tag: "narrow-returns",
      profileFile: "profile_narrow_returns.json",
    });
    expect(diags.map((d) => d.code)).toEqual(["SC4024", "SC4024"]);
    expect(diags[0]!.message).toContain("library callback 'answerBool'");
    expect(diags[0]!.message).toContain("return type is 'true'");
    expect(diags[0]!.message).toContain("may supply any boolean");
    expect(diags[1]!.message).toContain("library callback 'answerNumber'");
    expect(diags[1]!.message).toContain("return type is '0'");
    expect(diags[1]!.message).toContain("may supply any number");
  });

  test("CB6: a declaration off the channel's classes refuses SC4024", async () => {
    const diags = await buildRefusal(emission, { tag: "mismatch", entry: "lib_mismatch.ts" });
    expect(diags.map((d) => d.code)).toEqual(["SC4024"]);
    expect(diags[0]!.message).toContain("library callback 'emitChunk'");
    expect(diags[0]!.message).toContain("does not fit profile class 'bytes'");
  });

  test("CB6: a called function-valued ambient refuses SC4024 instead of disappearing", async () => {
    const diags = await buildRefusal(emission, { tag: "ambient-const", entry: "lib_ambient_const.ts" });
    expect(diags.map((d) => d.code)).toEqual(["SC4024"]);
    expect(diags[0]!.message).toContain("library callback 'orphan'");
    expect(diags[0]!.message).toContain("does not resolve exclusively to signature-only function declarations");
  });

  platformTest("CB6: a callback-free profile keeps the ambient ReferenceError lowering", async () => {
    // The standing guarantee's behavioral half: without a callbacks
    // section the same signature-only declaration keeps Node's
    // ReferenceError semantics — the call throws, and the escaped
    // exception reaches the sink as SC4013, never SC4024/SC4025.
    const { archive, outDir } = await buildLibrary(emission, {
      tag: "no-callbacks",
      entry: "lib_undeclared.ts",
      stripCallbacks: true,
      stripBufferedExport: true,
    });
    const probe = buildProbe("probe_referror.c", archive, outDir);
    const run = runProbe(probe);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`sink[1]:
code=[SC4013]
symbol=[cb_stream]
text has ReferenceError: 1
survived, sink_calls=1
`);
  });

  platformTest("CB6: a declared channel no code references is legal capacity", async () => {
    // lib_unused.ts never mentions 'orphan' (or the other channels); the
    // build succeeds and the registration symbol still answers for every
    // declared name.
    const { archive, outDir } = await buildLibrary(emission, { tag: "unused", entry: "lib_unused.ts", stripBufferedExport: true });
    const probe = buildProbe("probe_unused.c", archive, outDir);
    const run = runProbe(probe);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`reg orphan: 0
reg emitChunk: 0
unused ready
stream(3,7) = 42
`);
  });

  platformTest("CB6: declaration-file ambient names remain builtins and C-keyword channels stay indirect", async () => {
    const { archive, outDir } = await buildLibrary(emission, {
      tag: "builtin-names",
      profileFile: "profile_builtins.json",
    });
    const probe = buildProbe("probe_builtins.c", archive, outDir);
    const run = runProbe(probe);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`finite: 0
nan: 1
keyword: 7.5
`);
  });

  platformTest("CB6: a callback declared in a project .d.ts remains authored surface", async () => {
    const { archive, outDir } = await buildLibrary(emission, {
      tag: "project-dts",
      entry: "lib_project_dts.ts",
      stripBufferedExport: true,
    });
    const probe = buildProbe("probe_project_dts.c", archive, outDir);
    const run = runProbe(probe);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`seq=2 len=2 bytes=C7
result=9
`);
  });

  localizationTest("CB7: localized + thread-instanced channels route per instance", async () => {
    const { archive, outDir } = await buildLibrary(emission, { tag: "threads", profileFile: "profile_t.json" });
    const probe = buildProbe("probe_threads.c", archive, outDir, { pthread: true });
    const run = runProbe(probe);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`callbacks ready
callbacks ready
A: r1=13 r2=0 chunks=3 thread_ok=1 sink_calls=1
  seq=0 len=3 bytes=A2!
  seq=1 len=3 bytes=B3!
  seq=2 len=3 bytes=C4!
  sink code=SC4025 symbol=cbt_poke_orphan ctx_ok=1
B: r1=31 r2=6 chunks=4 thread_ok=1 sink_calls=0
  seq=0 len=3 bytes=A5!
  seq=1 len=3 bytes=B6!
  seq=2 len=3 bytes=C7!
  seq=0 len=3 bytes=A4!
`);
    // The localized external surface is exactly the declared set — the
    // register symbol rides the localization keep-list.
    const { defined, undef } = nmSymbols(archive);
    const prefixDefined = [...defined].filter((s) => s.startsWith("cbt_")).sort();
    expect(prefixDefined).toEqual([
      "cbt_ask_host", "cbt_init", "cbt_poke_orphan",
      "cbt_set_callback", "cbt_set_panic_sink", "cbt_stream",
    ]);
    expect([...undef].filter((s) => s.startsWith("cbt_"))).toEqual([]);
  });

  localizationTest("CB8: callback re-entry poisons only the active thread instance", async () => {
    const { archive, outDir } = await buildLibrary(emission, { tag: "threads-reentry", profileFile: "profile_t.json" });
    const probe = buildProbe("probe_threads_reentry.c", archive, outDir, { pthread: true });
    const run = runProbe(probe);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`callbacks ready
callbacks ready
A: result=0 chunks=0 thread_ok=1 sink_calls=1 code=SC4026 symbol=cbt_stream ctx_ok=1
B: result=5 chunks=1 thread_ok=1 sink_calls=0
`);
  });

  /* ── CB9: the sanitized lane ─────────────────────────────────────────── */

  platformTest("CB9: CB1/CB2/CB8 under ASan", async () => {
    const { archive, outDir } = await buildLibrary(emission, { sanitize: true });
    const probe = buildProbe("probe.c", archive, outDir, { sanitize: true, pthread: true });
    const run = runProbe(probe, ["run"]);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(RUN_EXPECTED);
    const orphan = runProbe(probe, ["orphan"]);
    expect(orphan.signal).toBe("SIGABRT");
    expect(orphan.stdout).toBe(ORPHAN_EXPECTED);
    const reentry = runProbe(probe, ["reenter-reset"]);
    expect(reentry.signal).toBe("SIGABRT");
    expect(reentry.stdout).toBe(reentryExpected("cb_reset_results"));
  });
});
