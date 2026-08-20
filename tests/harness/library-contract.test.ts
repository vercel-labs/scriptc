/* The contract sidecar (ask 2) — conformance over the schema's RULES,
 * never over any example's field lists. Both emissions run the same
 * assertions (the reference/differential posture of the K suite):
 *
 *   - the anti-alphabetical fixture pins DECLARATION order end to end:
 *     type names, record fields, enum members, union arms, msg arms, and
 *     helper order all read from the AST (a sorter anywhere reorders
 *     something here and the exact-order assertions catch it)
 *   - identity: the probe reads the exported build_id/abi_version getters
 *     BEFORE init and AFTER a poisoning trap (the ratified poisoned-guard
 *     exemption) and the harness compares them against the sidecar (V12)
 *   - determinism: two independent identical invocations produce
 *     hash-equal sidecar bytes (V13)
 *   - the V1–V14 validator passes the emitted documents and a
 *     structurally-faithful format-1 conformance document, and catches a
 *     targeted mutation per rule
 *   - absent forms: the pre-ask-4/ask-5 sequencing emits integer_slots []
 *     with every numeric slot f64, and the attestations are COMPUTED —
 *     the clock-touching fixture attests deterministic: false
 *   - SC4009: unprojectable designations refuse with the declaration
 *     named, never guessed around
 *   - ask-5 §4: the full-fence worked-example profile compiles a clean
 *     program and the computed attestation agrees — deterministic: true
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compileLibrary, validateSidecar, wyhash64, type SidecarDoc } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const fixtureRoot = join(repoRoot, "tests/library-mode");
/* Suite-flavor segment: the plain and SCRIPTC_SAN=1 suites may run
 * concurrently (the suite lock is per flavor) and both run these same
 * builds, so they must never share build dirs. */
const flavor = process.env["SCRIPTC_SAN"] === "1" ? "san" : "plain";
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/library-contract", flavor);

type Emission = "llvm" | "c";
const EMISSIONS: Emission[] = ["llvm", "c"];

const TOP_LEVEL_ORDER = [
  "format", "wire_version", "abi_version", "compiler_version", "entry",
  "source_hash", "build_id", "types", "model", "model_helpers",
  "model_unbound", "msg", "init_returns_cmd", "update_returns_cmd",
  "has_subscriptions", "channels", "abi", "integer_slots", "deterministic",
  "async_free",
];

/** Build one contract fixture for one emission. The fixture is COPIED
 * into the build dir so the compilation root (the profile's directory)
 * contains the whole module graph — the sidecar's entry and hash inputs
 * stay root-relative, absolute-path-free, and byte-reproducible across
 * build directories. */
async function buildContract(
  fixture: string,
  emission: Emission,
  tag = "",
  /** Build-root override. The default cache sits under the repo's
   * node_modules — fine for pure-TS fixtures, but an ENTRY under a
   * node_modules segment is npm surface to every path-keyed attribution
   * heuristic, so fixtures with a vendored node_modules build from a
   * root outside any node_modules (byte-reproducibility across build
   * directories is exactly what the canonical root-relative paths
   * guarantee, and the V13-style assertions prove it). */
  root = cacheDir,
): Promise<{ outDir: string; archive: string; cPath: string; sidecarPath: string; doc: SidecarDoc; bytes: Buffer }> {
  const dir = join(fixtureRoot, fixture);
  const outDir = join(root, `${fixture}-${emission}${tag}`);
  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".ts")) writeFileSync(join(outDir, name), readFileSync(join(dir, name)));
  }
  // A fixture with a vendored node_modules brings it along: the copied
  // compilation root resolves the same packages, and their canonical
  // root-relative paths keep the hash inputs byte-reproducible.
  if (existsSync(join(dir, "node_modules"))) {
    cpSync(join(dir, "node_modules"), join(outDir, "node_modules"), { recursive: true });
  }
  const profile = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")) as { emission: string };
  profile.emission = emission;
  writeFileSync(join(outDir, "profile.json"), JSON.stringify(profile, null, 2));
  const result = await compileLibrary({ profilePath: join(outDir, "profile.json"), outDir });
  if (!result.ok) {
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  }
  expect(result.backend).toBe(emission);
  expect(result.sidecarPath).toBeDefined();
  const bytes = readFileSync(result.sidecarPath!);
  return {
    outDir,
    archive: result.archivePath,
    cPath: result.cPath,
    sidecarPath: result.sidecarPath!,
    doc: JSON.parse(bytes.toString("utf8")) as SidecarDoc,
    bytes: bytes as Buffer,
  };
}

function nmDefined(archive: string, prefix: string): string[] {
  const out = execFileSync("nm", ["-gU", archive], { encoding: "utf8" });
  const set = new Set<string>();
  for (const line of out.split("\n")) {
    const sym = line.trim().split(/\s+/).pop();
    if (sym === undefined || sym === "" || sym.endsWith(":")) continue;
    const norm = sym.replace(/^_/, "");
    if (norm.startsWith(prefix)) set.add(norm);
  }
  return [...set].sort();
}

describe.each(EMISSIONS)("contract sidecar, %s emission", (emission) => {
  test("anti-alphabetical declaration order, schema shape, V11/V12 identity", async () => {
    const { outDir, archive, cPath, doc, bytes } = await buildContract("contract", emission);

    // The emitter's own self-check ran before writing; the test-side
    // validator agrees the document conforms.
    expect(validateSidecar(doc)).toEqual([]);

    // §0 serialization: top-level keys in the §1 order, trailing newline,
    // no BOM.
    expect(Object.keys(doc)).toEqual(TOP_LEVEL_ORDER);
    expect(bytes[0]).not.toBe(0xef);
    expect(bytes[bytes.length - 1]).toBe(0x0a);

    // The version/identity spine.
    expect(doc.format).toBe(1);
    expect(doc.wire_version).toBe(3);
    expect(doc.abi_version).toBe(7);
    expect(doc.compiler_version).toBe(
      (JSON.parse(readFileSync(join(repoRoot, "packages/compiler/package.json"), "utf8")) as { version: string }).version,
    );
    expect(doc.entry).toBe("lib.ts");
    expect(doc.source_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(doc.build_id).toMatch(/^[0-9a-f]{16}$/);
    expect(doc.build_id).not.toBe(doc.source_hash);

    // The type table: declaration order everywhere, exactly the reachable
    // set, synthesized entries anchored at their containing declaration.
    expect(doc.types.structs.map((s) => s.name)).toEqual(["Waypoint", "Shift", "Model", "Msg_blob_tag", "Msg_nudge", "helpers_extent"]);
    expect(doc.types.enums.map((e) => e.name)).toEqual(["Zone"]);
    expect(doc.types.unions.map((u) => u.name)).toEqual(["Route"]);
    expect(doc.types.enums[0]!.members).toEqual(["west", "north", "east"]);
    expect(doc.types.structs[0]!.fields).toEqual([
      { name: "zone", type: { kind: "enum", name: "Zone" } },
      { name: "note", type: { kind: "optional", inner: { kind: "bytes" } } },
      { name: "label", type: { kind: "bytes" } },
      { name: "id", type: { kind: "f64" } },
    ]);
    expect(doc.types.structs[2]!.fields.map((f) => f.name)).toEqual(["waypoints", "title", "speed", "route", "home", "active"]);
    expect(doc.types.structs[2]!.fields[4]!.type).toEqual({ kind: "optional", inner: { kind: "node", name: "Waypoint" } });
    expect(doc.types.structs[3]).toEqual({
      name: "Msg_blob_tag",
      synthesized: true,
      fields: [
        { name: "body", type: { kind: "bytes" } },
        { name: "status", type: { kind: "f64" } },
      ],
    });
    // Helper-return synthesized names are the same two-part pattern:
    // container 'helpers', member the helper name — no '_return' suffix.
    expect(doc.types.structs[5]).toEqual({
      name: "helpers_extent",
      synthesized: true,
      fields: [
        { name: "span", type: { kind: "f64" } },
        { name: "first", type: { kind: "bytes" } },
      ],
    });
    expect(doc.types.unions[0]!.arms).toEqual([
      { name: "warp", payload: { kind: "node", name: "Waypoint" } },
      { name: "step", payload: { kind: "value", name: "Shift" } },
      { name: "idle", payload: { kind: "void" } },
      { name: "annotate", payload: { kind: "bytes" } },
    ]);

    // The msg section: declaration-order arms (position IS the wire tag)
    // over all five descriptor families; the bytes-first two-field record
    // takes the record family (synthesized), never number_bytes.
    expect(doc.msg.name).toBe("Msg");
    expect(doc.msg.arms).toEqual([
      { name: "zoom", payload: { kind: "number", class: "f64" } },
      { name: "teleport", payload: { kind: "record", name: "Waypoint" } },
      { name: "rename", payload: { kind: "bytes" } },
      { name: "poll_done", payload: { kind: "number_bytes", number_field: "status", number_class: "f64", bytes_field: "body" } },
      { name: "flip", payload: { kind: "scalar", type: { kind: "bool" } } },
      { name: "route_set", payload: { kind: "union", name: "Route" } },
      { name: "zone_set", payload: { kind: "enum", name: "Zone" } },
      { name: "blob_tag", payload: { kind: "record", name: "Msg_blob_tag" } },
      { name: "nudge", payload: { kind: "record", name: "Msg_nudge" } },
      { name: "reset", payload: { kind: "void" } },
      { name: "endpoint_set", payload: { kind: "bytes" } },
      { name: "appearance", payload: { kind: "record", name: "Shift" } },
    ]);
    expect(doc.msg.unbound).toEqual(["poll_done", "endpoint_set"]);

    // Helpers in declaration order (array index = ABI call index), with
    // the arena bit derived from the return class.
    expect(doc.model).toBe("Model");
    expect(doc.model_helpers).toEqual([
      { name: "waypointsOf", params: [], returns: { kind: "slice", elem: { kind: "node", name: "Waypoint" } }, arena: true },
      { name: "headline", params: [], returns: { kind: "bytes" }, arena: true },
      { name: "waypointCount", params: [], returns: { kind: "f64" }, arena: false },
      { name: "extent", params: [], returns: { kind: "value", name: "helpers_extent" }, arena: true },
    ]);
    // Helpers are bindable surface: the unbound list may name one.
    expect(doc.model_unbound).toEqual(["title", "waypointCount"]);

    // Shape flags and channels: command_msg answers export presence by
    // suffix; the two host-constructed channels ride the exported consts.
    expect(doc.init_returns_cmd).toBe(false);
    expect(doc.update_returns_cmd).toBe(false);
    expect(doc.has_subscriptions).toBe(false);
    expect(doc.channels).toEqual({
      command_msg: true,
      frame_msg: false,
      key_msg: false,
      pinch_msg: false,
      appearance_msg: "appearance",
      chrome_msg: null,
      env_msgs: [{ env: "APP_ENDPOINT", msg: "endpoint_set" }],
    });

    // The absent forms and the computed attestations.
    expect(doc.integer_slots).toEqual([]);
    expect(doc.deterministic).toBe(true);
    expect(doc.async_free).toBe(true);

    // V11 both directions: the archive's prefix-carrying definitions are
    // exactly prefix + suffix over abi.exports — no extras, no misses.
    expect(doc.abi).toEqual({
      prefix: "kc_",
      exports: ["abi_version", "build_id", "set_panic_sink", "set_callback", "init", "boot", "send", "command_msg", "title", "helper_probe", "boom"],
      snapshot_format: 2,
    });
    expect(nmDefined(archive, "kc_")).toEqual(doc.abi.exports.map((s) => `kc_${s}`).sort());

    // The kept/returned program TU is a complete public artifact, even though
    // archive assembly privately compiles an identity-free projection beside
    // its tiny volatile identity object.
    const keptObject = join(outDir, "kept-program.o");
    execFileSync("clang", [
      "-std=c11",
      "-DSCR_LIB",
      ...(emission === "llvm"
        ? ["-Wno-override-module"]
        : ["-Wno-comment", "-I", join(repoRoot, "packages/runtime/src")]),
      "-c", cPath,
      "-o", keptObject,
    ]);
    expect(nmDefined(keptObject, "kc_")).toEqual(doc.abi.exports.map((s) => `kc_${s}`).sort());

    // V12 + the poisoned-guard exemption, end to end: the probe reads the
    // getters before init and after a trap; both reads equal the
    // sidecar's build_id.
    const probe = join(outDir, "probe");
    execFileSync("clang", ["-std=c11", join(fixtureRoot, "contract/probe.c"), archive, "-lm", "-o", probe]);
    const run = spawnSync(probe, [], { encoding: "utf8", timeout: 60_000 });
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      `pre build_id: ${doc.build_id} abi 7
contract ready
title: atlas
title2: atlas2
headline: atlas2!
counts: 2/2
sink[1]: scriptc: RangeError: array index 9 out of bounds (length 3)
survived, sink_calls=1
post build_id: ${doc.build_id} abi 7
identity stable: 1
`,
    );
  });

  test("V13: two independent identical invocations are hash-equal", async () => {
    const a = await buildContract("contract", emission, "-det1");
    const b = await buildContract("contract", emission, "-det2");
    const sha = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");
    expect(sha(a.bytes)).toBe(sha(b.bytes));
  });

  test("identity hashes cover statically-compiled npm modules; the type table stays authored surface", async () => {
    const npmRoot = join(tmpdir(), `scriptc-tests-library-contract-${flavor}`);
    const a = await buildContract("contract-npm", emission, "-npm1", npmRoot);
    const b = await buildContract("contract-npm", emission, "-npm2", npmRoot);
    expect(validateSidecar(a.doc)).toEqual([]);
    expect(a.doc.entry).toBe("lib.ts");
    expect(a.doc.deterministic).toBe(true);
    expect(a.doc.async_free).toBe(true);
    // Byte determinism holds with a vendored node_modules in the graph.
    const sha = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");
    expect(sha(a.bytes)).toBe(sha(b.bytes));
    // The contract vocabulary is the ENTRY's: no npm-derived type joined
    // the table (the opted-in package's .d.ts is dropped by construction).
    expect(a.doc.types.structs.map((s) => s.name)).toEqual(["Model"]);
    // The npm module's bytes are identity input: an edit inside the
    // package flips source_hash AND build_id on an otherwise-identical
    // rebuild of the same root.
    const pkgFile = join(b.outDir, "node_modules/adderkit/index.js");
    writeFileSync(pkgFile, `${readFileSync(pkgFile, "utf8")}// dist edit\n`);
    const again = await compileLibrary({ profilePath: join(b.outDir, "profile.json"), outDir: b.outDir });
    if (!again.ok) throw new Error(again.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mutated = JSON.parse(readFileSync(again.sidecarPath!, "utf8")) as SidecarDoc;
    expect(mutated.source_hash).not.toBe(a.doc.source_hash);
    expect(mutated.build_id).not.toBe(a.doc.build_id);
  });

  test("attestations and absent forms: tuple flags, subscriptions, a clock demotes deterministic", async () => {
    const { doc, sidecarPath } = await buildContract("contract-attest", emission);
    expect(validateSidecar(doc)).toEqual([]);
    // The neutral default path when the profile states none.
    expect(sidecarPath.endsWith(".lib.a.contract.json")).toBe(true);
    expect(doc.init_returns_cmd).toBe(true);
    expect(doc.update_returns_cmd).toBe(true);
    expect(doc.has_subscriptions).toBe(true);
    // Date.now() in the graph: computed, never defaulted (V14).
    expect(doc.deterministic).toBe(false);
    expect(doc.async_free).toBe(true);
    // Absent conventions state themselves as empty/null, not omissions.
    expect(doc.model_unbound).toEqual([]);
    expect(doc.msg.unbound).toEqual([]);
    expect(doc.model_helpers).toEqual([]);
    expect(doc.channels.appearance_msg).toBeNull();
    expect(doc.channels.chrome_msg).toBeNull();
    expect(doc.channels.env_msgs).toEqual([]);
    expect(doc.integer_slots).toEqual([]);
  });

  test("ask-5 §4 invariant: the full-fence profile compiles and attests deterministic: true", async () => {
    // The worked-example determinism profile (real manifest ids) over a
    // clean program: every fence loads, none is reached, compilation
    // succeeds, and the sidecar's COMPUTED attestation agrees with the
    // fences' construction — deterministic: true. A program that compiles
    // under full fences yet attests false is a bug in one of the two
    // scans (spec §4), and this pin is what recognizes it.
    const { doc } = await buildContract("fences-attest", emission);
    expect(validateSidecar(doc)).toEqual([]);
    expect(doc.deterministic).toBe(true);
    expect(doc.async_free).toBe(true);
  });

  test("ask-3 §2 adversarial order shapes + §3 spread-union composition", async () => {
    const { doc } = await buildContract("contract-order", emission);
    expect(validateSidecar(doc)).toEqual([]);

    // Shape 1 — cross-file payloads: Cargo's arms keep THEIR declaration
    // order (anti-alphabetical), and the payload records keep payloads.ts's
    // declaration order (Zeta, Wisp, Yank) — not the import list's
    // alphabetical order, not the arms' reference order (Yank, Zeta, Wisp),
    // not the alphabet. Entry-module declarations anchor first.
    expect(doc.types.structs.map((s) => s.name)).toEqual(["Model", "Zeta", "Wisp", "Yank"]);
    expect(doc.types.unions).toEqual([
      {
        name: "Cargo",
        arms: [
          { name: "veil", payload: { kind: "node", name: "Yank" } },
          { name: "sift", payload: { kind: "node", name: "Zeta" } },
          { name: "onyx", payload: { kind: "node", name: "Wisp" } },
        ],
      },
    ]);

    // Shape 2 — the enum table keeps anti-alphabetical member order, with
    // "Infinity" (a global-shadowing name) held verbatim in place.
    expect(doc.types.enums).toEqual([{ name: "Slot", members: ["zone", "Infinity", "alpha"] }]);

    // Shape 3 — the alias is transparent: the model field references
    // CargoAlias, the table speaks Cargo (the aliased declaration), and no
    // CargoAlias entry exists anywhere.
    expect(doc.types.structs[0]!.fields).toEqual([
      { name: "load", type: { kind: "union", name: "Cargo" } },
      { name: "slot", type: { kind: "enum", name: "Slot" } },
    ]);
    const allNames = [
      ...doc.types.structs.map((s) => s.name),
      ...doc.types.enums.map((e) => e.name),
      ...doc.types.unions.map((u) => u.name),
    ];
    expect(allNames).not.toContain("CargoAlias");

    // §3 composition (the reducer pattern): Msg = GadgetMsg | CoreMsg with
    // GadgetMsg = SpinMsg | { tap }. Depth-first source order — SpinMsg's
    // arms in SpinMsg's own declaration order, then the inline tap, then
    // CoreMsg's — and CoreMsg's duplicate "wind" drops (first occurrence,
    // SpinMsg's, wins). Position IS the wire tag.
    expect(doc.msg.name).toBe("Msg");
    expect(doc.msg.arms).toEqual([
      { name: "wind", payload: { kind: "number", class: "f64" } },
      { name: "unwind", payload: { kind: "void" } },
      { name: "tap", payload: { kind: "void" } },
      { name: "reset", payload: { kind: "void" } },
      { name: "boot", payload: { kind: "enum", name: "Slot" } },
    ]);
    // The constituents themselves never join the table: they are spelled
    // into Msg, not referenced as payload types.
    expect(allNames).toEqual(expect.not.arrayContaining(["SpinMsg", "GadgetMsg", "CoreMsg", "Msg"]));
  });
});

/* ── wyhash-64: the schema's one worked hashing definition ─────────────── */

test("wyhash64 matches the published final_version_3 vectors", () => {
  const enc = new TextEncoder();
  const vectors: [string, bigint, string][] = [
    ["", 0n, "42bc986dc5eec4d3"],
    ["a", 1n, "84508dc903c31551"],
    ["abc", 2n, "0bc54887cfc9ecb1"],
    ["message digest", 3n, "6e2ff3298208a67c"],
    ["abcdefghijklmnopqrstuvwxyz", 4n, "9a64e42e897195b9"],
    ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 5n, "9199383239c32554"],
    ["12345678901234567890123456789012345678901234567890123456789012345678901234567890", 6n, "7c1ccf6bba30f5a5"],
  ];
  for (const [text, seed, want] of vectors) {
    expect(wyhash64(enc.encode(text), seed).toString(16).padStart(16, "0")).toBe(want);
  }
});

/* ── the validator over a full-vocabulary conformance document ──────────
 * Structurally faithful to the schema's format-1 shape (all five
 * descriptor families, i64 slots with the V10 bijection, node/value
 * storage, an eleven-arm event union) with neutral identifiers. The
 * assertions key on the RULES: each mutation violates exactly one rule
 * and must be caught with that rule's tag. */

function conformanceDoc(): Record<string, unknown> {
  return {
    format: 1,
    wire_version: 3,
    abi_version: 1,
    compiler_version: "0.0.1",
    entry: "src/lib.ts",
    source_hash: "9f83c0de5eedc0de",
    build_id: "b01dface00c0ffee",
    types: {
      structs: [
        {
          name: "ComposerDraft",
          fields: [
            { name: "bytes", type: { kind: "bytes" } },
            { name: "anchor", type: { kind: "i64" } },
            { name: "focus", type: { kind: "i64" } },
          ],
        },
        {
          name: "Turn",
          fields: [
            { name: "id", type: { kind: "i64" } },
            { name: "role", type: { kind: "enum", name: "Role" } },
            { name: "text", type: { kind: "bytes" } },
          ],
        },
        {
          name: "TurnRow",
          fields: [
            { name: "id", type: { kind: "i64" } },
            { name: "user", type: { kind: "bool" } },
            { name: "text", type: { kind: "bytes" } },
          ],
        },
        {
          name: "PanelState",
          fields: [
            { name: "offset", type: { kind: "f64" } },
            { name: "velocity", type: { kind: "f64" } },
          ],
        },
        {
          name: "CaretMove",
          fields: [
            { name: "direction", type: { kind: "enum", name: "CaretDirection" } },
            { name: "extend", type: { kind: "bool" } },
          ],
        },
        {
          name: "Selection",
          fields: [
            { name: "anchor", type: { kind: "i64" } },
            { name: "focus", type: { kind: "i64" } },
          ],
        },
        {
          name: "Composition",
          fields: [
            { name: "text", type: { kind: "bytes" } },
            { name: "cursor", type: { kind: "optional", inner: { kind: "i64" } } },
          ],
        },
        {
          name: "Model",
          fields: [
            { name: "turns", type: { kind: "slice", elem: { kind: "node", name: "Turn" } } },
            { name: "nextId", type: { kind: "i64" } },
            { name: "phase", type: { kind: "enum", name: "Phase" } },
            { name: "draft", type: { kind: "node", name: "ComposerDraft" } },
            { name: "endpoint", type: { kind: "bytes" } },
            { name: "panelTop", type: { kind: "f64" } },
          ],
        },
      ],
      enums: [
        { name: "Phase", members: ["idle", "sending", "failed"] },
        { name: "Role", members: ["user", "assistant"] },
        { name: "CaretDirection", members: ["previous", "next", "start", "end"] },
      ],
      unions: [
        {
          name: "EditEvent",
          arms: [
            { name: "insert_text", payload: { kind: "bytes" } },
            { name: "delete_backward", payload: { kind: "void" } },
            { name: "move_caret", payload: { kind: "value", name: "CaretMove" } },
            { name: "set_selection", payload: { kind: "value", name: "Selection" } },
            { name: "set_composition", payload: { kind: "value", name: "Composition" } },
            { name: "commit_composition", payload: { kind: "void" } },
          ],
        },
      ],
    },
    model: "Model",
    model_helpers: [
      { name: "sending", params: [], returns: { kind: "bool" }, arena: false },
      { name: "draftText", params: [], returns: { kind: "bytes" }, arena: true },
      { name: "turnRows", params: [], returns: { kind: "slice", elem: { kind: "node", name: "TurnRow" } }, arena: true },
    ],
    model_unbound: ["turns", "nextId", "phase", "draft", "endpoint"],
    msg: {
      name: "Msg",
      arms: [
        { name: "draft_edit", payload: { kind: "union", name: "EditEvent" } },
        { name: "send", payload: { kind: "void" } },
        { name: "chat_response", payload: { kind: "number_bytes", number_field: "status", number_class: "i64", bytes_field: "body" } },
        { name: "chat_failed", payload: { kind: "bytes" } },
        { name: "panel_moved", payload: { kind: "record", name: "PanelState" } },
        { name: "phase_set", payload: { kind: "enum", name: "Phase" } },
        { name: "endpoint_set", payload: { kind: "bytes" } },
        { name: "muted", payload: { kind: "scalar", type: { kind: "bool" } } },
      ],
      unbound: ["chat_response", "chat_failed", "endpoint_set"],
    },
    init_returns_cmd: false,
    update_returns_cmd: true,
    has_subscriptions: false,
    channels: {
      command_msg: false,
      frame_msg: false,
      key_msg: false,
      pinch_msg: false,
      appearance_msg: null,
      chrome_msg: "phase_set",
      env_msgs: [{ env: "APP_CHAT_ENDPOINT", msg: "endpoint_set" }],
    },
    abi: {
      prefix: "app_core_",
      exports: ["abi_version", "build_id", "set_panic_sink", "init", "dispatch_void", "dispatch_bytes", "model_snapshot", "helper_call", "collect"],
      snapshot_format: 1,
    },
    integer_slots: [
      { slot: "ComposerDraft.anchor", class: "i64" },
      { slot: "ComposerDraft.focus", class: "i64" },
      { slot: "Turn.id", class: "i64" },
      { slot: "TurnRow.id", class: "i64" },
      { slot: "Selection.anchor", class: "i64" },
      { slot: "Selection.focus", class: "i64" },
      { slot: "Composition.cursor", class: "i64" },
      { slot: "Model.nextId", class: "i64" },
      { slot: "Msg.chat_response.status", class: "i64" },
    ],
    deterministic: true,
    async_free: true,
  };
}

describe("the V1-V14 validator", () => {
  test("a conforming full-vocabulary document passes", () => {
    expect(validateSidecar(conformanceDoc())).toEqual([]);
  });

  const expectViolation = (rule: string, mutate: (doc: Record<string, any>) => void): void => {
    const doc = conformanceDoc() as Record<string, any>;
    mutate(doc);
    const violations = validateSidecar(doc);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.startsWith(`${rule}:`)), violations.join("; ")).toBe(true);
  };

  test("V1: a missing required field refuses", () => {
    expectViolation("V1", (d) => {
      delete d["channels"];
    });
  });

  test("V1: top-level key order is the schema's order", () => {
    expectViolation("V1", (d) => {
      const v = d["format"];
      delete d["format"];
      d["format"] = v; // same fields, format now last
    });
  });

  test("V1: an unknown top-level field refuses (emitter-side posture)", () => {
    expectViolation("V1", (d) => {
      d["debug_info"] = {};
    });
  });

  test("V1: a synthesized struct marker is absent or literal true", () => {
    expectViolation("V1", (d) => {
      d["types"].structs[0].synthesized = false;
    });
  });

  test("V2: hashes are exactly 16 lowercase hex digits", () => {
    expectViolation("V2", (d) => {
      d["build_id"] = "B01DFACE00C0FFEE";
    });
  });

  test("V3: one namespace across the three arrays", () => {
    expectViolation("V3", (d) => {
      d["types"].enums.push({ name: "Model", members: ["x"] });
    });
  });

  test("V3: duplicate field names within a struct", () => {
    expectViolation("V3", (d) => {
      d["types"].structs[0].fields.push({ name: "bytes", type: { kind: "bool" } });
    });
  });

  test("V4: a dangling TypeRef refuses", () => {
    expectViolation("V4", (d) => {
      d["types"].structs[7].fields[0].type = { kind: "slice", elem: { kind: "node", name: "Ghost" } };
    });
  });

  test("V4: an unreachable table entry refuses", () => {
    expectViolation("V4", (d) => {
      d["types"].structs.push({ name: "Orphan", fields: [{ name: "x", type: { kind: "f64" } }] });
    });
  });

  test("V4: model must name a struct", () => {
    expectViolation("V4", (d) => {
      d["model"] = "Phase";
    });
  });

  test("V5: a reference cycle refuses", () => {
    expectViolation("V5", (d) => {
      d["types"].structs[1].fields.push({ name: "parent", type: { kind: "node", name: "Model" } });
    });
  });

  test("V6: more than 256 msg arms refuse", () => {
    expectViolation("V6", (d) => {
      for (let i = 0; i < 256; i++) d["msg"].arms.push({ name: `arm_${i}`, payload: { kind: "void" } });
    });
  });

  test("V7: number_bytes needs distinct non-empty field names", () => {
    expectViolation("V7", (d) => {
      d["msg"].arms[2].payload.bytes_field = "status";
    });
  });

  test("V7: scalar descriptors never carry a record TypeRef", () => {
    expectViolation("V7", (d) => {
      d["msg"].arms[7].payload = { kind: "scalar", type: { kind: "node", name: "PanelState" } };
    });
  });

  test("V8: model_unbound entries are model fields or helper entries", () => {
    expectViolation("V8", (d) => {
      d["model_unbound"].push("nope");
    });
  });

  test("V8: a helper name IS valid in model_unbound (bindable surface)", () => {
    const doc = conformanceDoc() as Record<string, any>;
    doc["model_unbound"].push("turnRows");
    expect(validateSidecar(doc)).toEqual([]);
  });

  test("V9: an env target must be a bytes arm", () => {
    expectViolation("V9", (d) => {
      d["channels"].env_msgs[0].msg = "send";
    });
  });

  test("V9: a chrome/appearance arm must be of the named-type family", () => {
    expectViolation("V9", (d) => {
      d["channels"].chrome_msg = "chat_failed";
    });
  });

  test("V9: a function channel true without the export suffix refuses", () => {
    expectViolation("V9", (d) => {
      d["channels"].frame_msg = true;
    });
  });

  test("V10: an i64 spelling without its integer_slots entry refuses", () => {
    expectViolation("V10", (d) => {
      d["integer_slots"] = d["integer_slots"].filter((s: { slot: string }) => s.slot !== "Model.nextId");
    });
  });

  test("V10: an integer_slots entry without its i64 spelling refuses", () => {
    expectViolation("V10", (d) => {
      d["integer_slots"].push({ slot: "Model.panelTop", class: "i64" });
    });
  });

  test("V10: slice elements are exempt from the bijection", () => {
    const doc = conformanceDoc() as Record<string, any>;
    // An i64 slice element has no expressible slot path in format 1; the
    // spelling alone must NOT demand an entry.
    doc["model_helpers"].push({
      name: "turnIds",
      params: [],
      returns: { kind: "slice", elem: { kind: "i64" } },
      arena: true,
    });
    expect(validateSidecar(doc)).toEqual([]);
  });
});

/* ── Focused sidecar projection fixtures ───────────────────────────────── */

let projectionCounter = 0;

async function sidecarProjection(source: string): Promise<SidecarDoc> {
  const outDir = join(cacheDir, `projection-${projectionCounter++}`);
  mkdirSync(outDir, { recursive: true });
  const entry = join(outDir, "lib.ts");
  writeFileSync(entry, source);
  const profile = {
    profile_format: 1,
    name: "sidecar-projection-fixture",
    entry: "lib.ts",
    emission: "c",
    abi: {
      prefix: "kp_",
      init_symbol: "kp_init",
      sink_register_symbol: "kp_set_panic_sink",
      collect_symbol: null,
      result_reset_symbol: null,
    },
    exports: [{ export: "boot", symbol: "kp_boot", params: [], returns: "f64" }],
    sidecar: {
      wire_version: 1,
      abi_version: 1,
      snapshot_format: 1,
      build_id_symbol: "kp_build_id",
      abi_version_symbol: "kp_abi_version",
      model: "Model",
      msg: "Msg",
    },
  };
  const profilePath = join(outDir, "profile.json");
  writeFileSync(profilePath, JSON.stringify(profile));
  const result = await compileLibrary({ profilePath, outDir });
  if (!result.ok) {
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  }
  return JSON.parse(readFileSync(result.sidecarPath!, "utf8")) as SidecarDoc;
}

describe("contract sidecar scalar aliases", () => {
  test("aliases dissolve recursively across records, msg payloads, and helpers", async () => {
    const doc = await sidecarProjection(`export type Scalar = number;
export type Volume = Scalar;
export type Label = string;
export type Enabled = boolean;
export type Bytes = Uint8Array;
export interface Model {
  volume: Volume;
  label: Label;
  enabled: Enabled;
  data: Bytes;
  maybe?: Scalar;
  samples: Volume[];
}
export type Msg =
  | { kind: "set"; value: Volume }
  | { kind: "rename"; value: Label }
  | { kind: "toggle"; value: Enabled }
  | { kind: "upload"; value: Bytes }
  | { kind: "packet"; size: Volume; body: Label }
  | { kind: "noop" };
export function init(): Model {
  return {
    volume: 1,
    label: "one",
    enabled: true,
    data: new Uint8Array([1]),
    samples: [1, 2],
  };
}
export function update(m: Model, msg: Msg): Model { return m; }
export function inspect(
  m: Model,
  volume: Volume,
  label: Label,
  enabled: Enabled,
  data: Bytes,
): Scalar {
  return enabled ? volume + label.length + data.length : m.volume;
}
let state = init();
export function boot(): number {
  state = update(state, { kind: "noop" });
  return state.volume;
}
`);

    expect(validateSidecar(doc)).toEqual([]);
    expect(doc.types.structs).toEqual([
      {
        name: "Model",
        fields: [
          { name: "volume", type: { kind: "f64" } },
          { name: "label", type: { kind: "bytes" } },
          { name: "enabled", type: { kind: "bool" } },
          { name: "data", type: { kind: "bytes" } },
          { name: "maybe", type: { kind: "optional", inner: { kind: "f64" } } },
          { name: "samples", type: { kind: "slice", elem: { kind: "f64" } } },
        ],
      },
    ]);
    expect(doc.types.enums).toEqual([]);
    expect(doc.types.unions).toEqual([]);
    expect(doc.msg.arms).toEqual([
      { name: "set", payload: { kind: "number", class: "f64" } },
      { name: "rename", payload: { kind: "bytes" } },
      { name: "toggle", payload: { kind: "scalar", type: { kind: "bool" } } },
      { name: "upload", payload: { kind: "bytes" } },
      { name: "packet", payload: { kind: "number_bytes", number_field: "size", number_class: "f64", bytes_field: "body" } },
      { name: "noop", payload: { kind: "void" } },
    ]);
    expect(doc.model_helpers).toEqual([
      {
        name: "inspect",
        params: [{ kind: "f64" }, { kind: "bytes" }, { kind: "bool" }, { kind: "bytes" }],
        returns: { kind: "f64" },
        arena: false,
      },
    ]);
  });
});

/* ── SC4009: unprojectable designations refuse, never guess ────────────── */

let refusalCounter = 0;
async function sidecarRefusal(
  source: string,
  sidecarPatch: Record<string, unknown> = {},
  extraFiles: Record<string, string> = {},
): Promise<{ code: string; message: string; file: string; hint?: string }[]> {
  const outDir = join(cacheDir, `refusal-${refusalCounter++}`);
  mkdirSync(outDir, { recursive: true });
  const entry = join(outDir, "lib.ts");
  writeFileSync(entry, source);
  for (const [name, text] of Object.entries(extraFiles)) writeFileSync(join(outDir, name), text);
  const profile = {
    profile_format: 1,
    name: "sidecar-refusal-fixture",
    entry: "lib.ts",
    emission: "c",
    abi: {
      prefix: "ks_",
      init_symbol: "ks_init",
      sink_register_symbol: "ks_set_panic_sink",
      collect_symbol: null,
      result_reset_symbol: null,
    },
    exports: [{ export: "boot", symbol: "ks_boot", params: [], returns: "f64" }],
    sidecar: {
      wire_version: 1,
      abi_version: 1,
      snapshot_format: 1,
      build_id_symbol: "ks_build_id",
      abi_version_symbol: "ks_abi_version",
      model: "Model",
      msg: "Msg",
      ...sidecarPatch,
    },
  };
  const profilePath = join(outDir, "profile.json");
  writeFileSync(profilePath, JSON.stringify(profile));
  const result = await compileLibrary({ profilePath, outDir });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  return result.diagnostics.map((d) => (
    d.hint === undefined
      ? { code: d.code, message: d.message, file: d.loc.file }
      : { code: d.code, message: d.message, file: d.loc.file, hint: d.hint }
  ));
}

const REFUSAL_BASE = `export interface Model { count: number; }
export type Msg = { kind: "tick" } | { kind: "set"; value: string };
export function init(): Model { return { count: 0 }; }
export function update(m: Model, msg: Msg): Model { return { count: m.count + 1 }; }
let state = init();
export function boot(): number { state = update(state, { kind: "tick" }); return state.count; }
`;

describe("contract sidecar array spellings", () => {
  test("readonly T[] and ReadonlyArray<T> project identically to T[]", async () => {
    const doc = await sidecarProjection(`export interface Model {
  plainIds: number[];
  readonlyIds: readonly number[];
  genericIds: ReadonlyArray<number>;
  maybeIds?: readonly number[];
}
export type Msg =
  | { kind: "replace"; ids: ReadonlyArray<number> }
  | { kind: "keep" };
export function init(): Model {
  return { plainIds: [1], readonlyIds: [2], genericIds: [3] };
}
export function update(m: Model, msg: Msg): Model {
  if (msg.kind === "keep") return m;
  return { plainIds: msg.ids.slice(), readonlyIds: msg.ids, genericIds: m.genericIds };
}
export function inspect(m: Model, left: readonly number[], right: ReadonlyArray<number>): readonly number[] {
  return [m.plainIds.length, left.length, right.length];
}
let state = init();
export function boot(): number {
  state = update(state, { kind: "replace", ids: [4, 5] });
  return state.readonlyIds.length;
}
`);
    const slice = { kind: "slice", elem: { kind: "f64" } } as const;
    const model = doc.types.structs.find((s) => s.name === "Model");
    expect(model?.fields).toEqual([
      { name: "plainIds", type: slice },
      { name: "readonlyIds", type: slice },
      { name: "genericIds", type: slice },
      { name: "maybeIds", type: { kind: "optional", inner: slice } },
    ]);
    expect(doc.msg.arms).toEqual([
      { name: "replace", payload: { kind: "scalar", type: slice } },
      { name: "keep", payload: { kind: "void" } },
    ]);
    expect(doc.model_helpers).toEqual([
      { name: "inspect", params: [slice, slice], returns: slice, arena: true },
    ]);
  });

  test.each(["Array", "ReadonlyArray"])("a local %s<T> alias is not mistaken for the global array type", async (name) => {
    const diags = await sidecarRefusal(`export type ${name}<T> = { value: T };
export interface Model { item: ${name}<number>; }
export type Msg = { kind: "keep" } | { kind: "alsoKeep" };
export function init(): Model { return { item: { value: 1 } }; }
export function update(m: Model, msg: Msg): Model { return m; }
let state = init();
export function boot(): number {
  state = update(state, { kind: "keep" });
  return state.item.value;
}
`);
    expect(diags[0]!.code).toBe("SC4009");
    expect(diags[0]!.message).toContain(`${name}<number>`);
  });

  test("an imported ReadonlyArray binding is not mistaken for the global array type", async () => {
    const diags = await sidecarRefusal(
      `import type { Box as ReadonlyArray } from "./box.ts";
export interface Model { item: ReadonlyArray<number>; }
export type Msg = { kind: "keep" } | { kind: "alsoKeep" };
export function init(): Model { return { item: { value: 1 } }; }
export function update(m: Model, msg: Msg): Model { return m; }
let state = init();
export function boot(): number {
  state = update(state, { kind: "keep" });
  return state.item.value;
}
`,
      {},
      { "box.ts": "export type Box<T> = { value: T };\n" },
    );
    expect(diags[0]!.code).toBe("SC4009");
    expect(diags[0]!.message).toContain("ReadonlyArray<number>");
  });

  test("a local Uint8Array interface remains a named record", async () => {
    const doc = await sidecarProjection(`export interface Uint8Array { value: number; }
export interface Model { data: Uint8Array; }
export type Msg = { kind: "keep" } | { kind: "alsoKeep" };
export function init(): Model { return { data: { value: 1 } }; }
export function update(m: Model, msg: Msg): Model { return m; }
let state = init();
export function boot(): number {
  state = update(state, { kind: "keep" });
  return state.data.value;
}
`);
    expect(doc.types.structs.find((s) => s.name === "Uint8Array")?.fields).toEqual([
      { name: "value", type: { kind: "f64" } },
    ]);
    expect(doc.types.structs.find((s) => s.name === "Model")?.fields).toEqual([
      { name: "data", type: { kind: "node", name: "Uint8Array" } },
    ]);
  });
});

describe("SC4009: contract sidecar refusals", () => {
  test("an explicit subscriptions export naming nothing refuses at the profile", async () => {
    const diags = await sidecarRefusal(REFUSAL_BASE, { subscriptions_export: "watch" });
    expect(diags[0]!.code).toBe("SC4009");
    expect(diags[0]!.message).toContain("'sidecar.subscriptions_export'");
    expect(diags[0]!.message).toContain("'watch'");
    expect(diags[0]!.file).toMatch(/[/\\]profile\.json$/);
  });

  test("an omitted subscriptions export remains optional", async () => {
    const doc = await sidecarProjection(REFUSAL_BASE);
    expect(doc.has_subscriptions).toBe(false);
  });

  test("a model designation naming nothing refuses", async () => {
    const diags = await sidecarRefusal(REFUSAL_BASE, { model: "Nope" });
    expect(diags[0]!.code).toBe("SC4009");
    expect(diags[0]!.message).toContain("'Nope'");
  });

  test("a msg designation that is not a tagged union refuses", async () => {
    const diags = await sidecarRefusal(REFUSAL_BASE, { msg: "Model", model: "Msg" });
    expect(diags[0]!.code).toBe("SC4009");
  });

  test("an inline union field refuses toward a named declaration", async () => {
    const diags = await sidecarRefusal(
      REFUSAL_BASE.replace("{ count: number; }", '{ count: number; mode: "a" | "b"; }').replace(
        "return { count: 0 };",
        'return { count: 0, mode: "a" };',
      ).replace("return { count: m.count + 1 };", 'return { count: m.count + 1, mode: m.mode };'),
    );
    expect(diags[0]!.code).toBe("SC4009");
    expect(diags[0]!.message).toContain("inline union");
  });

  test("a malformed convention const refuses", async () => {
    const diags = await sidecarRefusal(REFUSAL_BASE + `export const envMsgs = ["nope"];\n`);
    expect(diags[0]!.code).toBe("SC4009");
    expect(diags[0]!.message).toContain("envMsgs");
  });

  test("an env channel targeting a non-bytes arm refuses", async () => {
    const diags = await sidecarRefusal(REFUSAL_BASE + `export const envMsgs = [{ env: "APP_X", msg: "tick" }];\n`);
    expect(diags[0]!.code).toBe("SC4009");
    expect(diags[0]!.message).toContain("bytes");
  });

  test("a helper without a return annotation refuses", async () => {
    const diags = await sidecarRefusal(REFUSAL_BASE + `export function peek(m: Model) { return m.count; }\n`);
    expect(diags[0]!.code).toBe("SC4009");
    expect(diags[0]!.message).toContain("peek");
  });

  test("a repeated arm within ONE declaration still refuses (dedup is cross-constituent only)", async () => {
    const diags = await sidecarRefusal(
      `export interface Model { count: number; }
export type Msg = { kind: "tick" } | { kind: "tick"; fast: boolean };
export function init(): Model { return { count: 0 }; }
export function update(m: Model, msg: Msg): Model { return m; }
export function boot(): number { return init().count; }
`,
    );
    expect(diags[0]!.code).toBe("SC4009");
    expect(diags[0]!.message).toContain("repeats arm 'tick'");
  });

  test("a union composing a non-union constituent refuses", async () => {
    const diags = await sidecarRefusal(
      `export interface Model { count: number; }
export type Mode = "a" | "b";
export type Msg = { kind: "tick" } | Mode;
export function init(): Model { return { count: 0 }; }
export function update(m: Model, msg: Msg): Model { return m; }
export function boot(): number { return init().count; }
`,
    );
    expect(diags[0]!.code).toBe("SC4009");
    expect(diags[0]!.message).toContain("'Mode'");
    expect(diags[0]!.message).toContain("only kind-tagged unions compose by reference");
  });
});

/* ── ask-3 §3 define-or-refuse: order not derivable from ONE site ────────
 * SC4010 (multi-site declarations: interface merging, module
 * augmentation, a same-name exported type in another module) and SC4011
 * (conditional/mapped types producing a tabled or designated type). The
 * teaching names every contributing site, file:line each. */

describe("SC4010: multi-site declarations feeding a tabled type refuse", () => {
  test("interface merging in one file names both sites", async () => {
    // Merged declarations must agree on export (TS2395), so the second
    // block is exported too — still two sites, still refused.
    const diags = await sidecarRefusal(
      `export interface Model { count: number; }
export interface Model { extra: number; }
export type Msg = { kind: "tick" } | { kind: "set"; value: string };
export function init(): Model { return { count: 0, extra: 0 }; }
export function update(m: Model, msg: Msg): Model { return { count: m.count + 1, extra: m.extra }; }
let state = init();
export function boot(): number { state = update(state, { kind: "tick" }); return state.count; }
`,
    );
    expect(diags[0]!.code).toBe("SC4010");
    expect(diags[0]!.message).toContain("'Model'");
    expect(diags[0]!.message).toContain("lib.ts:1");
    expect(diags[0]!.message).toContain("lib.ts:2");
    expect(diags[0]!.hint).toContain("lib.ts:1");
    expect(diags[0]!.hint).toContain("lib.ts:2");
  });

  test("module augmentation from another file names both sites", async () => {
    const diags = await sidecarRefusal(
      `import type { Box } from "./payload.ts";
import "./augment.ts";
export interface Model { box: Box; }
export type Msg = { kind: "tick" };
export function init(): Model { return { box: { n: 0, extra: 1 } }; }
export function update(m: Model, msg: Msg): Model { return m; }
export function boot(): number { return update(init(), { kind: "tick" }).box.n; }
`,
      {},
      {
        "payload.ts": `export interface Box { n: number; }\n`,
        "augment.ts": `import "./payload.ts";\ndeclare module "./payload.ts" {\n  interface Box { extra: number; }\n}\nexport {};\n`,
      },
    );
    expect(diags[0]!.code).toBe("SC4010");
    expect(diags[0]!.message).toContain("'Box'");
    expect(diags[0]!.message).toContain("payload.ts:1");
    expect(diags[0]!.message).toContain("augment.ts:3");
  });

  test("a same-name exported type in two modules refuses when referenced (one namespace)", async () => {
    const diags = await sidecarRefusal(
      `import type { Box } from "./a.ts";
import type { Box as BoxDupe } from "./b.ts";
export interface Model { box: Box; n: number; }
export type Msg = { kind: "tick" };
export function init(): Model { return { box: { n: 1 }, n: 2 }; }
export function update(m: Model, msg: Msg): Model { return m; }
export function boot(): number { return init().n; }
`,
      {},
      {
        "a.ts": `export interface Box { n: number; }\n`,
        "b.ts": `export interface Box { m: number; }\n`,
      },
    );
    expect(diags[0]!.code).toBe("SC4010");
    expect(diags[0]!.message).toContain("'Box'");
    expect(diags[0]!.message).toContain("a.ts:1");
    expect(diags[0]!.message).toContain("b.ts:1");
  });
});

describe("SC4011: computed types producing a tabled/designated type refuse", () => {
  test("a conditional type as the designated msg", async () => {
    const diags = await sidecarRefusal(
      `export interface Model { count: number; }
export type Msg = true extends true ? ({ kind: "tick" } | { kind: "set"; value: string }) : never;
export function init(): Model { return { count: 0 }; }
export function update(m: Model, msg: Msg): Model { return m; }
export function boot(): number { return init().count; }
`,
    );
    expect(diags[0]!.code).toBe("SC4011");
    expect(diags[0]!.message).toContain("'Msg'");
    expect(diags[0]!.message).toContain("conditional");
  });

  test("a mapped type reaching the table", async () => {
    const diags = await sidecarRefusal(
      `export type Flags = { [K in "on" | "off"]: boolean };
export interface Model { count: number; flags: Flags; }
export type Msg = { kind: "tick" };
export function init(): Model { return { count: 0, flags: { on: true, off: false } }; }
export function update(m: Model, msg: Msg): Model { return m; }
export function boot(): number { return init().count; }
`,
    );
    expect(diags[0]!.code).toBe("SC4011");
    expect(diags[0]!.message).toContain("'Flags'");
    expect(diags[0]!.message).toContain("mapped");
  });
});
