/* Library-mode profile loader/validator (stage 1 of the library emission mode):
 * every malformation family the design names is SC4001 with the offending
 * JSON path in the message; a well-formed profile round-trips into the
 * resolved LibraryProfile shape (entry made absolute against the profile's
 * own directory, teachings and remediations riders captured — reserved
 * bytes of the structured trap-teaching encoding refused in both). */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { loadLibraryProfile, profileRemediation, profileTeaching } from "@scriptc/compiler";

const dir = mkdtempSync(join(tmpdir(), "scriptc-lib-profile-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function writeProfile(json: unknown): string {
  const p = join(dir, `p${n++}.json`);
  writeFileSync(p, typeof json === "string" ? json : JSON.stringify(json));
  return p;
}

const good = {
  profile_format: 1,
  name: "conformance-test",
  entry: "src/lib.ts",
  emission: "llvm",
  abi: {
    prefix: "kx_",
    init_symbol: "kx_init",
    sink_register_symbol: "kx_set_panic_sink",
    collect_symbol: "kx_collect",
    result_reset_symbol: null,
  },
  exports: [
    { export: "update", symbol: "kx_update", params: ["f64", "string"], returns: "bytes" },
    { export: "score", symbol: "kx_score", params: ["u32", "bool"], returns: "f64" },
  ],
};

function expectSc4001(json: unknown, fragment: string): void {
  const r = loadLibraryProfile(writeProfile(json));
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.diagnostics).toHaveLength(1);
  expect(r.diagnostics[0]!.code).toBe("SC4001");
  expect(r.diagnostics[0]!.message).toContain(fragment);
}

describe("library profile validation", () => {
  test("well-formed profile resolves", () => {
    const path = writeProfile(good);
    const r = loadLibraryProfile(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.name).toBe("conformance-test");
    expect(r.profile.emission).toBe("llvm");
    expect(r.profile.optimization).toBe("release");
    expect(r.profile.prefix).toBe("kx_");
    expect(r.profile.initSymbol).toBe("kx_init");
    expect(r.profile.collectSymbol).toBe("kx_collect");
    expect(r.profile.resultResetSymbol).toBeNull();
    // entry resolves against the profile file's directory
    expect(r.profile.entry).toBe(join(dir, "src/lib.ts"));
    expect(r.profile.exports).toHaveLength(2);
    expect(r.profile.exports[1]!.params).toEqual(["u32", "bool"]);
  });

  test("teachings rider: per-code key wins, 'async' is the shared fallback", () => {
    const r = loadLibraryProfile(
      writeProfile({
        ...good,
        determinism: { teachings: { async: "use kx_schedule instead", SC4004: "wrap it in a sync facade" } },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(profileTeaching(r.profile, "SC4004")).toBe("wrap it in a sync facade");
    expect(profileTeaching(r.profile, "SC4005")).toBe("use kx_schedule instead");
    expect(profileTeaching(r.profile, "SC4001")).toBeUndefined();
  });

  test("remediations rider round-trips; embedder code keys pass as bare tokens", () => {
    const r = loadLibraryProfile(
      writeProfile({
        ...good,
        determinism: {
          teachings: { NS1207: "the host and this core disagree about the contract" },
          remediations: { NS1207: "rebuild the app from one build", SC4012: "pass the true byte length" },
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Embedder-prefixed codes are validated only as tokens free of the
    // reserved bytes — never for registry membership.
    expect(profileTeaching(r.profile, "NS1207")).toBe("the host and this core disagree about the contract");
    expect(profileRemediation(r.profile, "NS1207")).toBe("rebuild the app from one build");
    expect(profileRemediation(r.profile, "SC4012")).toBe("pass the true byte length");
    expect(profileRemediation(r.profile, "SC4004")).toBeUndefined();
  });

  test("teaching and remediation text reject the encoding's reserved bytes", () => {
    // 0x01 is the structured message's version marker, 0x1F its field
    // separator: either byte inside profile-authored text would corrupt
    // the assembled sink message, so the load refuses (SC4001). The full
    // ratified constraint bans every control byte below 0x20 except
    // newline in TEXT (and every control byte, newline included, in keys).
    expectSc4001(
      { ...good, determinism: { teachings: { SC4012: "bad \u0001 marker" } } },
      "determinism.teachings.SC4012",
    );
    expectSc4001(
      { ...good, determinism: { remediations: { SC4012: "bad \u001f separator" } } },
      "determinism.remediations.SC4012",
    );
    expectSc4001(
      { ...good, determinism: { teachings: { "NS\u001f12": "text is fine" } } },
      "reserved byte",
    );
    expectSc4001(
      { ...good, determinism: { teachings: { SC4012: "tabs\tare control bytes" } } },
      "determinism.teachings.SC4012",
    );
    const withNewline = loadLibraryProfile(
      writeProfile({ ...good, determinism: { teachings: { SC4012: "line one\nline two" } } }),
    );
    expect(withNewline.ok).toBe(true);
  });

  test("teaching and remediation text cap at 512 bytes, refuse over", () => {
    const atCap = loadLibraryProfile(
      writeProfile({ ...good, determinism: { teachings: { SC4012: "x".repeat(512) } } }),
    );
    expect(atCap.ok).toBe(true);
    expectSc4001({ ...good, determinism: { teachings: { SC4012: "x".repeat(513) } } }, "512 bytes");
    expectSc4001(
      { ...good, determinism: { remediations: { SC4012: "x".repeat(513) } } },
      "determinism.remediations.SC4012",
    );
    // The cap counts UTF-8 BYTES, not code points.
    expectSc4001({ ...good, determinism: { teachings: { SC4012: "\u00e9".repeat(300) } } }, "512");
  });

  test("parse error", () => expectSc4001("{ not json", "not valid JSON"));
  test("wrong format", () => expectSc4001({ ...good, profile_format: 2 }, "profile_format"));
  test("missing name", () => {
    const { name: _drop, ...rest } = good;
    expectSc4001(rest, "'name'");
  });
  test("bad emission", () => expectSc4001({ ...good, emission: "wasm" }, "emission"));
  test("optimization defaults to release and admits dev explicitly", () => {
    const dev = loadLibraryProfile(writeProfile({ ...good, optimization: "dev" }));
    expect(dev.ok).toBe(true);
    if (dev.ok) expect(dev.profile.optimization).toBe("dev");
    expectSc4001({ ...good, optimization: "fast" }, "optimization");
  });
  test("bad prefix identifier", () =>
    expectSc4001({ ...good, abi: { ...good.abi, prefix: "9bad_" } }, "abi.prefix"));
  test("symbol without the prefix", () =>
    expectSc4001({ ...good, abi: { ...good.abi, init_symbol: "other_init" } }, "prefix"));
  test("symbol not a C identifier", () =>
    expectSc4001({ ...good, abi: { ...good.abi, init_symbol: "kx_init-now" } }, "C identifier"));
  test("unknown field inside abi", () =>
    expectSc4001({ ...good, abi: { ...good.abi, init: "kx_init" } }, "unknown field 'abi.init'"));
  test("unknown field inside an export entry", () =>
    expectSc4001(
      { ...good, exports: [{ ...good.exports[0], param: [] }] },
      "unknown field 'exports[0].param'",
    ));
  test("unknown root fields refuse — the strict root (anti-inert posture)", () => {
    expectSc4001({ ...good, contract: {} }, "unknown field 'contract'");
    expectSc4001({ ...good, exporst: [] }, "unknown field 'exporst'");
  });
  test("the ask-5 keys at the root refuse with a pointer to their determinism.* home", () => {
    expectSc4001(
      { ...good, fences: [{ id: "stdlib.math.random" }] },
      "the ask-5 determinism surface lives under 'determinism.fences'",
    );
    expectSc4001({ ...good, teachings: { SC4005: "x" } }, "'determinism.teachings'");
    expectSc4001({ ...good, remediations: { SC4012: "x" } }, "'determinism.remediations'");
  });
  test("unknown keys INSIDE determinism stay reserved surface, ignored", () => {
    const r = loadLibraryProfile(writeProfile({ ...good, determinism: { deny: ["Math.random"] } }));
    expect(r.ok).toBe(true);
  });
  test("duplicate symbols", () =>
    expectSc4001(
      { ...good, exports: [{ export: "update", symbol: "kx_init", params: [], returns: "void" }] },
      "declared twice",
    ));
  test("duplicate export names", () =>
    expectSc4001(
      {
        ...good,
        exports: [
          { export: "update", symbol: "kx_a", params: [], returns: "void" },
          { export: "update", symbol: "kx_b", params: [], returns: "void" },
        ],
      },
      "mapped twice",
    ));
  test("unknown marshalling class", () =>
    expectSc4001(
      { ...good, exports: [{ export: "f", symbol: "kx_f", params: ["i16"], returns: "void" }] },
      "params[0]",
    ));
  test("the integer plumbing classes are param-only", () =>
    expectSc4001(
      { ...good, exports: [{ export: "f", symbol: "kx_f", params: [], returns: "u32" }] },
      "parameter-only",
    ));
  test("void is return-only", () =>
    expectSc4001(
      { ...good, exports: [{ export: "f", symbol: "kx_f", params: ["void"], returns: "void" }] },
      "params[0]",
    ));
});

/* ── the ask-2 sidecar section ─────────────────────────────────────────── */

const goodSidecar = {
  wire_version: 3,
  abi_version: 1,
  snapshot_format: 1,
  build_id_symbol: "kx_build_id",
  abi_version_symbol: "kx_abi_version",
  model: "Model",
  msg: "Msg",
};

describe("library profile sidecar section", () => {
  test("well-formed sidecar section resolves with its defaults", () => {
    const r = loadLibraryProfile(writeProfile({ ...good, sidecar: goodSidecar }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.sidecar).toEqual({
      path: null,
      wireVersion: 3,
      abiVersion: 1,
      snapshotFormat: 1,
      buildIdSymbol: "kx_build_id",
      abiVersionSymbol: "kx_abi_version",
      model: "Model",
      msg: "Msg",
      initExport: "init",
      updateExport: "update",
      subscriptionsExport: "subscriptions",
      subscriptionsExportDeclared: false,
      sourceHash: "module-graph",
      integerSlots: [],
    });
    // The profile's exact bytes ride along (build_id input 2).
    expect(r.profile.profileBytes.length).toBeGreaterThan(0);
  });

  test("no sidecar section means no sidecar config", () => {
    const r = loadLibraryProfile(writeProfile(good));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.sidecar).toBeNull();
  });

  test("unknown field inside sidecar refuses", () =>
    expectSc4001({ ...good, sidecar: { ...goodSidecar, extra: 1 } }, "sidecar.extra"));
  test("getter symbol without the prefix refuses", () =>
    expectSc4001({ ...good, sidecar: { ...goodSidecar, build_id_symbol: "zz_build_id" } }, "sidecar.build_id_symbol"));
  test("a getter symbol colliding with a mode symbol refuses", () =>
    expectSc4001({ ...good, sidecar: { ...goodSidecar, build_id_symbol: "kx_init" } }, "declared twice"));
  test("model and msg must differ", () =>
    expectSc4001({ ...good, sidecar: { ...goodSidecar, msg: "Model" } }, "differ"));
  test("an unknown source_hash contract refuses", () =>
    expectSc4001({ ...good, sidecar: { ...goodSidecar, source_hash: "sha256" } }, "module-graph"));
  test("a non-integer version constant refuses", () =>
    expectSc4001({ ...good, sidecar: { ...goodSidecar, wire_version: 1.5 } }, "sidecar.wire_version"));
  test("an absolute sidecar path refuses", () =>
    expectSc4001({ ...good, sidecar: { ...goodSidecar, path: "/tmp/contract.json" } }, "sidecar.path"));

  /* ── ask 4: the declared integer boundary surface ─────────────────── */

  test("i64/u64 are declarable in params and returns", () => {
    const r = loadLibraryProfile(
      writeProfile({
        ...good,
        exports: [{ export: "send", symbol: "kx_send", params: ["i64", "u64"], returns: "i64" }],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.exports[0]!.params).toEqual(["i64", "u64"]);
    expect(r.profile.exports[0]!.returns).toBe("i64");
  });

  test("sidecar integer_slots parse in declaration order", () => {
    const r = loadLibraryProfile(
      writeProfile({
        ...good,
        sidecar: {
          ...goodSidecar,
          integer_slots: [
            { slot: "Msg.count", class: "i64" },
            { slot: "Msg.id", class: "u64" },
          ],
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.sidecar!.integerSlots).toEqual([
      { slot: "Msg.count", cls: "i64" },
      { slot: "Msg.id", cls: "u64" },
    ]);
  });

  test("an integer_slots class outside i64/u64 refuses", () =>
    expectSc4001(
      { ...good, sidecar: { ...goodSidecar, integer_slots: [{ slot: "Msg.count", class: "u32" }] } },
      "integer_slots[0].class",
    ));
  test("a repeated integer_slots path refuses", () =>
    expectSc4001(
      {
        ...good,
        sidecar: {
          ...goodSidecar,
          integer_slots: [
            { slot: "Msg.count", class: "i64" },
            { slot: "Msg.count", class: "u64" },
          ],
        },
      },
      "repeats slot path",
    ));
  test("an unknown field inside an integer_slots entry refuses", () =>
    expectSc4001(
      { ...good, sidecar: { ...goodSidecar, integer_slots: [{ slot: "Msg.count", class: "i64", sign: true }] } },
      "integer_slots[0].sign",
    ));
});


/* ── the ask-5 fences array ────────────────────────────────────────────────
 * Selector strictness is RATIFIED: fence profiles pin per compiler
 * release, so an id or prefix matching nothing in this release's surface
 * manifest refuses SC4001 at load — there is no forward-compatible
 * acceptance of unknown selectors, and no silently-inert fence. Static
 * surfaces no detector can police refuse the same way, with the reason
 * named (folded constants, desugared methods). */

describe("library profile fences", () => {
  test("well-formed fences resolve: id and prefix selectors, covered surfaces, detectors", () => {
    const r = loadLibraryProfile(
      writeProfile({
        ...good,
        determinism: {
          fences: [
            { id: "stdlib.math.random", teaching: "randomness is an effect", remediation: "ask the host" },
            { prefix: "node-builtin.fs.", teaching: "files are effects" },
            { id: "stdlib.math.sin", teaching: "trig is host math", remediation: "request it as an effect" },
          ],
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.fences).toHaveLength(3);
    // The id fence covers exactly its entry; math.random is static, so it
    // carries a detector (the compile-time denial's reach witness).
    expect(r.profile.fences[0]!.declared).toBe("id 'stdlib.math.random'");
    expect(r.profile.fences[0]!.surfaces).toHaveLength(1);
    expect(r.profile.fences[0]!.surfaces[0]!.id).toBe("stdlib.math.random");
    expect(r.profile.fences[0]!.surfaces[0]!.detector).toBeDefined();
    // The prefix fence covers the whole fs member family.
    const fsIds = r.profile.fences[1]!.surfaces.map((s) => s.id);
    expect(fsIds).toContain("node-builtin.fs.readFileSync");
    expect(fsIds).toContain("node-builtin.fs.promises.readFile");
    // A fenced dynamic-only surface carries its own refusal code and no
    // detector: the teaching rides the refusal that already fires.
    const sin = r.profile.fences[2]!.surfaces[0]!;
    expect(sin.code).toBe("SC2012");
    expect(sin.detector).toBeUndefined();
  });

  test("a fence remediation feeds the trap-remediation lookup through covered codes", () => {
    const r = loadLibraryProfile(
      writeProfile({
        ...good,
        determinism: {
          remediations: { SC2012: "the explicit map key wins" },
          fences: [
            { id: "stdlib.math.sin", remediation: "request it as an effect" },
            { id: "node-builtin.crypto.createHash", remediation: "digests come from the host" },
          ],
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Explicit remediations keys win over fence-supplied text.
    expect(profileRemediation(r.profile, "SC2012")).toBe("the explicit map key wins");
    // A fence's remediation answers for its covered entries' codes
    // (crypto.createHash is SC2020) — spec §3's "in a fence entry or a
    // remediations map", one lookup either way.
    expect(profileRemediation(r.profile, "SC2020")).toBe("digests come from the host");
    expect(profileRemediation(r.profile, "SC4014")).toBeUndefined();
  });

  test("an id matching nothing in this release's manifest refuses (ratified strictness)", () => {
    expectSc4001(
      { ...good, determinism: { fences: [{ id: "stdlib.chrono.now" }] } },
      "determinism.fences[0].id",
    );
    expectSc4001(
      { ...good, determinism: { fences: [{ id: "stdlib.chrono.now" }] } },
      "names no entry",
    );
  });

  test("the ask-5 worked example's Date family resolves: the attestation's ground is fenceable", () => {
    // The spec's own worked prefix ('stdlib.date.') plus the other ambient
    // families the determinism attestation demotes on — every one resolves
    // against the manifest with detectors, so the §4 invariant is statable.
    const r = loadLibraryProfile(
      writeProfile({
        ...good,
        determinism: {
          fences: [
            { prefix: "stdlib.date." },
            { prefix: "node-builtin.process." },
            { prefix: "node-builtin.perf_hooks." },
          ],
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dateIds = r.profile.fences[0]!.surfaces.map((s) => s.id);
    expect(dateIds).toEqual([
      "stdlib.date.UTC",
      "stdlib.date.constructor",
      "stdlib.date.getDate",
      "stdlib.date.getDay",
      "stdlib.date.getFullYear",
      "stdlib.date.getHours",
      "stdlib.date.getMilliseconds",
      "stdlib.date.getMinutes",
      "stdlib.date.getMonth",
      "stdlib.date.getSeconds",
      "stdlib.date.getTime",
      "stdlib.date.getTimezoneOffset",
      "stdlib.date.getUTCDate",
      "stdlib.date.getUTCDay",
      "stdlib.date.getUTCFullYear",
      "stdlib.date.getUTCHours",
      "stdlib.date.getUTCMilliseconds",
      "stdlib.date.getUTCMinutes",
      "stdlib.date.getUTCMonth",
      "stdlib.date.getUTCSeconds",
      "stdlib.date.now",
      "stdlib.date.toISOString",
      "stdlib.date.valueOf",
    ]);
    expect(r.profile.fences[0]!.surfaces.every((s) => s.detector !== undefined)).toBe(true);
    const processIds = r.profile.fences[1]!.surfaces.map((s) => s.id);
    expect(processIds).toContain("node-builtin.process.env");
    expect(processIds).toContain("node-builtin.process.exit");
    // The live machine-state reads join the family too (the attestation
    // demotes on them, so the family fence must deny them).
    expect(processIds).toContain("node-builtin.process.resourceUsage");
    expect(processIds).toContain("node-builtin.process.cpuUsage");
    expect(processIds).toContain("node-builtin.process.isTTY");
    expect(r.profile.fences[1]!.surfaces.every((s) => s.detector !== undefined)).toBe(true);
    expect(r.profile.fences[2]!.surfaces.map((s) => s.id)).toEqual(["node-builtin.perf_hooks.performance.now"]);
  });

  test("Date getTime and valueOf fences keep distinct IR witnesses", () => {
    const r = loadLibraryProfile(
      writeProfile({
        ...good,
        determinism: {
          fences: [{ id: "stdlib.date.getTime" }, { id: "stdlib.date.valueOf" }],
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.fences[0]!.surfaces[0]!.detector?.libFns).toEqual([
      "date.getTime",
      "date.parseGetTime",
    ]);
    expect(r.profile.fences[1]!.surfaces[0]!.detector?.libFns).toEqual(["date.valueOf"]);
  });

  test("a prefix matching nothing refuses — the spec's illustrative spelling included", () => {
    // The worked example's 'node.fs.' is illustrative prose; the real
    // taxonomy spells 'node-builtin.fs.', and the strict refusal catches
    // the drift instead of shipping an inert fence.
    expectSc4001(
      { ...good, determinism: { fences: [{ prefix: "node.fs." }] } },
      "determinism.fences[0].prefix",
    );
  });

  test("exactly one of id/prefix per fence", () => {
    expectSc4001(
      { ...good, determinism: { fences: [{ id: "stdlib.math.random", prefix: "node-builtin.fs." }] } },
      "exactly one of 'id' or 'prefix'",
    );
    expectSc4001(
      { ...good, determinism: { fences: [{ teaching: "no selector" }] } },
      "exactly one of 'id' or 'prefix'",
    );
  });

  test("unknown fields inside a fence entry refuse (a typo silently disarms a denial)", () => {
    expectSc4001(
      { ...good, determinism: { fences: [{ id: "stdlib.math.random", teachng: "typo" }] } },
      "unknown field 'determinism.fences[0].teachng'",
    );
  });

  test("fence teaching/remediation strings share the reserved-byte and 512-byte rules", () => {
    expectSc4001(
      { ...good, determinism: { fences: [{ id: "stdlib.math.random", teaching: "bad \u0001 marker" }] } },
      "determinism.fences[0].teaching",
    );
    expectSc4001(
      { ...good, determinism: { fences: [{ id: "stdlib.math.random", remediation: "x".repeat(513) }] } },
      "determinism.fences[0].remediation",
    );
  });

  test("a compile-time-folded constant cannot be id-fenced; a prefix exempts it", () => {
    // os.EOL folds to a per-binary literal: nothing at runtime reads it,
    // so an id fence naming it would be a lie — refused with the reason.
    expectSc4001(
      { ...good, determinism: { fences: [{ id: "node-builtin.os.EOL" }] } },
      "fold",
    );
    // The family sweep stays usable: the prefix covers the os members and
    // exempts the folded constant.
    const r = loadLibraryProfile(
      writeProfile({ ...good, determinism: { fences: [{ prefix: "node-builtin.os." }] } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.fences[0]!.surfaces.map((s) => s.id)).not.toContain("node-builtin.os.EOL");
    expect(r.profile.fences[0]!.surfaces.map((s) => s.id)).toContain("node-builtin.os.homedir");

    // Math.PI is the same kind of per-binary numeric literal. An exact fence
    // must refuse because there is no runtime read to deny.
    expectSc4001(
      { ...good, determinism: { fences: [{ id: "stdlib.math.PI" }] } },
      "fold",
    );
    const math = loadLibraryProfile(
      writeProfile({ ...good, determinism: { fences: [{ prefix: "stdlib.math." }] } }),
    );
    expect(math.ok).toBe(true);
    if (!math.ok) return;
    const mathSurfaces = math.profile.fences[0]!.surfaces;
    expect(mathSurfaces.map((s) => s.id)).not.toContain("stdlib.math.PI");
    expect(mathSurfaces.map((s) => s.id)).not.toContain("stdlib.math.E");
    expect(mathSurfaces.find((s) => s.id === "stdlib.math.random")?.detector).toBeDefined();
  });

  test("a desugared surface no detector can police refuses, id and prefix alike", () => {
    expectSc4001(
      { ...good, determinism: { fences: [{ id: "stdlib.array.map" }] } },
      "desugars",
    );
    expectSc4001(
      { ...good, determinism: { fences: [{ prefix: "stdlib.array." }] } },
      "cannot be fenced",
    );
  });

  test("no fences array means no fences", () => {
    const r = loadLibraryProfile(writeProfile(good));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.fences).toEqual([]);
  });
});

describe("library profile host-callback channels", () => {
  const withCallbacks = {
    ...good,
    abi: { ...good.abi, callback_register_symbol: "kx_set_callback" },
    callbacks: [
      { name: "emitChunk", params: ["bytes", "u32"], returns: "void" },
      { name: "progress", params: ["f64", "f64"], returns: "i32" },
    ],
  };

  test("well-formed channels resolve in declaration order", () => {
    const r = loadLibraryProfile(writeProfile(withCallbacks));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.callbackRegisterSymbol).toBe("kx_set_callback");
    expect(r.profile.callbacks).toEqual([
      { name: "emitChunk", params: ["bytes", "u32"], returns: "void" },
      { name: "progress", params: ["f64", "f64"], returns: "i32" },
    ]);
  });

  test("a callback-free profile carries the empty surface", () => {
    const r = loadLibraryProfile(writeProfile(good));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.callbackRegisterSymbol).toBeNull();
    expect(r.profile.callbacks).toEqual([]);
  });

  test("channels without a registration symbol refuse (unreachable by any host)", () =>
    expectSc4001(
      { ...good, callbacks: [{ name: "emitChunk", params: ["bytes"], returns: "void" }] },
      "abi.callback_register_symbol",
    ));

  test("a registration symbol without channels refuses (the anti-inert posture)", () =>
    expectSc4001(
      { ...good, abi: { ...good.abi, callback_register_symbol: "kx_set_callback" } },
      "declares no channels",
    ));

  test("the registration symbol keeps the prefix and pairwise-distinct rules", () => {
    expectSc4001(
      { ...withCallbacks, abi: { ...withCallbacks.abi, callback_register_symbol: "other_set" } },
      "must start with the profile prefix",
    );
    expectSc4001(
      { ...withCallbacks, abi: { ...withCallbacks.abi, callback_register_symbol: "kx_init" } },
      "declared twice",
    );
  });

  test("declared integer classes refuse in callback parameter position", () =>
    expectSc4001(
      { ...withCallbacks, callbacks: [{ name: "x", params: ["i64"], returns: "void" }] },
      "export-map surface",
    ));

  test("buffer returns refuse with the ownership teaching", () =>
    expectSc4001(
      { ...withCallbacks, callbacks: [{ name: "x", params: [], returns: "bytes" }] },
      "ownership contract",
    ));

  test("duplicate channel names refuse", () =>
    expectSc4001(
      {
        ...withCallbacks,
        callbacks: [
          { name: "x", params: [], returns: "void" },
          { name: "x", params: [], returns: "void" },
        ],
      },
      "declared twice",
    ));

  test("a channel name colliding with an export-map export refuses", () =>
    expectSc4001(
      { ...withCallbacks, callbacks: [{ name: "update", params: [], returns: "void" }] },
      "both an export-map export and a callback channel name",
    ));

  test("unknown fields inside a channel entry refuse", () =>
    expectSc4001(
      { ...withCallbacks, callbacks: [{ name: "x", params: [], returns: "void", lifetime: "call" }] },
      "callbacks[0].lifetime",
    ));

  test("a channel name must be a plain identifier (the TS binding and the C name string)", () =>
    expectSc4001(
      { ...withCallbacks, callbacks: [{ name: "emit-chunk", params: [], returns: "void" }] },
      "not a valid channel name",
    ));

  test("the runtime's slot capacity caps the channel count", () =>
    expectSc4001(
      {
        ...withCallbacks,
        callbacks: Array.from({ length: 33 }, (_, i) => ({ name: `c${i}`, params: [], returns: "void" })),
      },
      "slot capacity is 32",
    ));
});
