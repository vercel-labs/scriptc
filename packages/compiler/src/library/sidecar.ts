import { InternalCompilerError } from "../errors.js";
/* The ask-2 contract sidecar emitter: projects the entry module's typed
 * contract into the profile-supplied schema (format 1) — a single JSON
 * document beside the archive carrying the version/identity spine, the
 * type table, the model/msg designations, helper signatures, shape flags,
 * channels, the ABI attestation, and the determinism attestations.
 *
 * The sidecar is the CONTRACT, not the program: no source spans, no
 * bodies, no IR, no environment or machine data, no absolute paths, no
 * timestamps. Emission is deterministic — top-level keys in the schema's
 * §1 order, every array order semantic (declaration order where the
 * schema says declaration, profile canonical order for abi.exports), so
 * re-running the identical invocation reproduces a byte-identical file.
 *
 * Declaration order is read from the SYNTAX TREE (frontend/lib-contract.ts)
 * — never from checker property enumeration, which hands back internal or
 * sorted order (the ratified record-field-order ruling: the IR's sorted
 * canonicalization is storage; AST order is the contract).
 *
 * Order must be DERIVABLE FROM ONE DECLARATION SITE or the build refuses
 * (ask 3's define-or-refuse rule): declaration merging into a tabled type
 * refuses with every site named (SC4010), conditional/mapped types
 * producing a tabled type refuse (SC4011), and a union COMPOSED of other
 * kind-tagged unions (`type Msg = A | B` — the reducer-composition
 * pattern) is allowed with a pinned order: depth-first source order of
 * the constituent declarations (A's arms in A's own declaration order,
 * then B's), an arm name appearing in several constituents keeping its
 * FIRST occurrence. Type aliases are transparent where the wire has no
 * alias identity: a reference alias tables the target declaration, while
 * a scalar alias projects as its underlying bool/number/string/bytes
 * TypeRef. Neither alias adds a table entry or reorders the target.
 *
 * Integer slots (ask 4): the profile's `sidecar.integer_slots` declares
 * specific number slots i64/u64 by slot path; the projection spells each
 * declared slot's TypeRef/descriptor `i64`, nested under `optional` when
 * the TypeScript slot is optional (the frozen format-1 vocabulary — u64 is
 * the stricter compile-time obligation over the same wire spelling), and
 * refuses paths that resolve to no bare or optional number slot,
 * and emits `integer_slots` as the resolved-decision list, in profile
 * declaration order, each entry recording the DECLARED class ({i64, u64}
 * — the flattening is TypeRef-only). The list is an ATTESTATION (schema
 * §5's invariant):
 * compileLibrary runs the integer-boundary inference before writing any
 * artifact, so a sidecar carrying an entry means every value that can
 * reach that slot proved whole-in-range. Undeclared numeric slots keep
 * spelling `f64` and the empty list stays a valid attestation that no
 * slot was integer-classed. `deterministic` is computed from the module
 * graph (ir/ir.ts's conservative ambient-surface scan), never
 * defaulted. */
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { libSidecarComputedDiag, libSidecarDiag, libSidecarMergedDiag, type ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { ContractFacts, ContractField, ContractTypeDecl, ContractTypeShape } from "../frontend/lib-contract.js";
import type { SrcLoc } from "../ir/ir.js";
import type { LibraryProfile, LibrarySidecarConfig } from "./library-profile.js";
import { BUILD_ID_SEED, hex16, lengthPrefixedStream, SOURCE_HASH_SEED, wyhash64 } from "./wyhash.js";

/** The sidecar schema's format this emitter writes. */
export const SIDECAR_FORMAT = 1;

/* ── the schema's closed vocabularies ──────────────────────────────────── */

export type TypeRef =
  | { kind: "bool" }
  | { kind: "f64" }
  | { kind: "i64" }
  | { kind: "bytes" }
  | { kind: "void" }
  | { kind: "optional"; inner: TypeRef }
  | { kind: "slice"; elem: TypeRef }
  | { kind: "node"; name: string }
  | { kind: "value"; name: string }
  | { kind: "enum"; name: string }
  | { kind: "union"; name: string };

export type PayloadDescriptor =
  | { kind: "void" }
  | { kind: "bytes" }
  | { kind: "number"; class: "f64" | "i64" }
  | { kind: "number_bytes"; number_field: string; number_class: "f64" | "i64"; bytes_field: string }
  | { kind: "record"; name: string }
  | { kind: "union"; name: string }
  | { kind: "enum"; name: string }
  | { kind: "scalar"; type: TypeRef };

export interface SidecarStruct {
  name: string;
  /** Present, with the literal value `true`, only when the compiler
   * synthesized this table entry for an anonymous inline record. Omitted
   * for records declared by name in the entry module. */
  synthesized?: true;
  fields: { name: string; type: TypeRef }[];
}
export interface SidecarEnum {
  name: string;
  members: string[];
}
export interface SidecarUnion {
  name: string;
  arms: { name: string; payload: TypeRef }[];
}
export interface SidecarHelper {
  name: string;
  params: TypeRef[];
  returns: TypeRef;
  arena: boolean;
}

/** The whole document, property-ordered exactly as §1 lists the fields
 * (JSON.stringify preserves insertion order — the construction order IS
 * the serialization order). */
export interface SidecarDoc {
  format: number;
  wire_version: number;
  abi_version: number;
  compiler_version: string;
  entry: string;
  source_hash: string;
  build_id: string;
  types: { structs: SidecarStruct[]; enums: SidecarEnum[]; unions: SidecarUnion[] };
  model: string;
  model_helpers: SidecarHelper[];
  model_unbound: string[];
  msg: { name: string; arms: { name: string; payload: PayloadDescriptor }[]; unbound: string[] };
  init_returns_cmd: boolean;
  update_returns_cmd: boolean;
  has_subscriptions: boolean;
  channels: {
    command_msg: boolean;
    frame_msg: boolean;
    key_msg: boolean;
    pinch_msg: boolean;
    appearance_msg: string | null;
    chrome_msg: string | null;
    env_msgs: { env: string; msg: string }[];
  };
  abi: { prefix: string; exports: string[]; snapshot_format: number };
  integer_slots: { slot: string; class: "i64" | "u64" }[];
  deterministic: boolean;
  async_free: boolean;
}

/* ── identity hashing (schema §2 + the "module-graph" source contract) ─── */

let releaseVersion: string | null = null;

/** The package version is stable within one compilation, but a long-lived
 * source/worktree process may observe a release stamp between compilations. */
export function clearSidecarCaches(): void {
  releaseVersion = null;
}

/** The compiler's exact release identifier — the published package
 * version, read once from the compiler package's own package.json (this
 * module lives two levels below the package root in src/ and dist/
 * alike). build_id input 1 and the sidecar's `compiler_version`. */
export function compilerReleaseVersion(): string {
  if (releaseVersion === null) {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    releaseVersion = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;
  }
  return releaseVersion;
}

/** One path under the sidecar's canonical rules: compilation-root-relative
 * POSIX, or `profile:`-namespaced when the file sits outside the root
 * (never absolute, no `.`/`..` segments). */
export function canonicalPath(rootDir: string, file: string): string {
  const rel = relative(rootDir, file);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return `profile:${file.split(/[\\/]/).pop()!}`;
  }
  return sep === "/" ? rel : rel.split(sep).join("/");
}

export interface CanonicalModule {
  /** Compilation-root-relative POSIX path (or `profile:`-namespaced when
   * outside the root), never absolute, no `.`/`..` segments. */
  canonical: string;
  bytes: Uint8Array;
}

/** Canonicalize + sort the module graph for hashing: root-relative POSIX
 * paths, ascending by plain bytewise comparison of the path strings. A
 * module outside the compilation root (the profile file's directory)
 * cannot spell a canonical relative path, so it rides the `profile:`
 * namespace under its basename — deterministic and absolute-path-free. */
export function canonicalModuleGraph(rootDir: string, sources: ReadonlyMap<string, string>): CanonicalModule[] {
  const enc = new TextEncoder();
  const entries: CanonicalModule[] = [];
  for (const [file, text] of sources) {
    entries.push({ canonical: canonicalPath(rootDir, file), bytes: enc.encode(text) });
  }
  entries.sort((a, b) => {
    const c = Buffer.compare(Buffer.from(a.canonical, "utf8"), Buffer.from(b.canonical, "utf8"));
    return c !== 0 ? c : Buffer.compare(a.bytes, b.bytes);
  });
  return entries;
}

/** build_id (schema §2: compiler version, profile bytes, sorted module
 * graph — every input length-prefixed) and source_hash (the
 * "module-graph" contract: the sorted module graph alone, so the value is
 * stable across compiler releases). Both 16 lowercase hex digits. */
export function libraryIdentityHashes(
  compilerVersion: string,
  profileBytes: Uint8Array,
  modules: readonly CanonicalModule[],
): { buildId: string; sourceHash: string } {
  const enc = new TextEncoder();
  const graphChunks: Uint8Array[] = [];
  for (const m of modules) {
    graphChunks.push(enc.encode(m.canonical), m.bytes);
  }
  const buildChunks: Uint8Array[] = [enc.encode(compilerVersion), profileBytes, ...graphChunks];
  return {
    buildId: hex16(wyhash64(lengthPrefixedStream(buildChunks), BUILD_ID_SEED)),
    sourceHash: hex16(wyhash64(lengthPrefixedStream(graphChunks), SOURCE_HASH_SEED)),
  };
}

/** The profile's canonical `abi.exports` suffix order: the identity
 * getters first (abi_version, then build_id), the mode-provided entries
 * (sink registration, callback registration, init, collect, reset —
 * declared ones only), then the export map in profile order. Suffix =
 * symbol minus prefix. */
export function abiExportSuffixes(profile: LibraryProfile): string[] {
  const strip = (sym: string): string => sym.slice(profile.prefix.length);
  const out: string[] = [];
  if (profile.sidecar !== null) {
    out.push(strip(profile.sidecar.abiVersionSymbol), strip(profile.sidecar.buildIdSymbol));
  }
  out.push(strip(profile.sinkRegisterSymbol));
  if (profile.callbackRegisterSymbol !== null) out.push(strip(profile.callbackRegisterSymbol));
  out.push(strip(profile.initSymbol));
  if (profile.collectSymbol !== null) out.push(strip(profile.collectSymbol));
  if (profile.resultResetSymbol !== null) out.push(strip(profile.resultResetSymbol));
  for (const e of profile.exports) out.push(strip(e.symbol));
  return out;
}

/* ── classification of the entry's declared types ──────────────────────── */

/** One syntactic constituent of a kind-tagged union declaration: an
 * inline object-literal arm, or a REFERENCE to another named union (the
 * composition form, flattened depth-first by the projector). */
type TaggedPart =
  | { p: "arm"; name: string; fields: ContractField[]; loc: SrcLoc }
  | { p: "ref"; name: string; loc: SrcLoc };

type TaggedArm = { name: string; fields: ContractField[]; loc: SrcLoc };

type ScalarContractShape = Extract<ContractTypeShape, { k: "bool" | "number" | "text" | "bytes" }>;

type Classified =
  | { c: "struct"; storage: "node" | "value"; fields: ContractField[]; decl: ContractTypeDecl; index: number }
  | { c: "enum"; members: string[]; decl: ContractTypeDecl; index: number }
  | { c: "tagged"; parts: TaggedPart[]; decl: ContractTypeDecl; index: number }
  /** A named scalar has no sidecar identity: references project as the
   * underlying scalar and the alias contributes no table entry. */
  | { c: "scalar"; shape: ScalarContractShape; decl: ContractTypeDecl; index: number }
  /** `type A = B` — transparent: projection follows to the aliased
   * declaration; the alias itself never joins the table. */
  | { c: "alias"; target: string; decl: ContractTypeDecl; index: number }
  | { c: "unsupported"; why: string; computed?: "conditional" | "mapped"; decl: ContractTypeDecl; index: number };

/** The sidecar syntax's exact IR-shape projection. Record integer facts
 * carry this structural pattern into the post-lowering join so it can use
 * the same field-name AND field-type identity as ShapeRegistry. Tagged
 * payload records admit omission of `kind`: some lowering paths retain the
 * string discriminant field while others use only the surrounding union
 * tag. */
export type SidecarIrTypePattern =
  | { kind: "f64" | "string" | "bool" | "nullT" | "undefinedT" | "dyn" }
  | { kind: "bytes"; elem: "u8" }
  | { kind: "array"; elem: SidecarIrTypePattern }
  | SidecarIrRecordPattern
  | { kind: "union"; arms: SidecarIrTypePattern[] };

export interface SidecarIrRecordPattern {
  kind: "record";
  fields: { name: string; type: SidecarIrTypePattern }[];
  kindMayBeOmitted?: true;
}

interface PendingIntegerRecordFact {
  fields: ContractField[];
  tagged: boolean;
  targetField: string;
  cls: "i64" | "u64";
  path: string;
  loc: SrcLoc;
}

type SynthesizedRecordVariant =
  | { fields: ContractField[]; loc: SrcLoc }
  | { fields: null; loc: SrcLoc; why: string };

/** The composed-arm provenance of a synthesized record, kept separately
 * from whether this particular record's IR shape carries the discriminant. */
interface SynthesizedRecordContext {
  armName: string;
  variants: () => SynthesizedRecordVariant[];
}

function classify(decl: ContractTypeDecl, index: number): Classified {
  const s = decl.shape;
  if (s.k === "unsupported") {
    return s.computed === undefined
      ? { c: "unsupported", why: s.text, decl, index }
      : { c: "unsupported", why: s.text, computed: s.computed, decl, index };
  }
  if (s.k === "object") {
    return { c: "struct", storage: decl.form === "interface" ? "node" : "value", fields: s.fields, decl, index };
  }
  if (
    decl.form === "alias" &&
    (s.k === "bool" || s.k === "number" || s.k === "text" || s.k === "bytes")
  ) {
    return { c: "scalar", shape: s, decl, index };
  }
  if (decl.form === "alias" && s.k === "ref") return { c: "alias", target: s.name, decl, index };
  if (decl.form === "alias" && s.k === "stringLit") return { c: "enum", members: [s.text], decl, index };
  if (decl.form === "alias" && s.k === "union") {
    if (s.parts.every((p) => p.k === "stringLit")) {
      return { c: "enum", members: s.parts.map((p) => (p as { text: string }).text), decl, index };
    }
    const parts: TaggedPart[] = [];
    for (const p of s.parts) {
      if (p.k === "ref") {
        parts.push({ p: "ref", name: p.name, loc: decl.loc });
        continue;
      }
      if (p.k !== "object") {
        return { c: "unsupported", why: "a union mixing non-object constituents (a tagged union's arms are object literals with a string-literal 'kind', or references to other kind-tagged unions)", decl, index };
      }
      const kindField = p.fields.find((f) => f.name === "kind");
      if (kindField === undefined || kindField.shape.k !== "stringLit" || kindField.optional) {
        return { c: "unsupported", why: "a union constituent without a non-optional string-literal 'kind' discriminant", decl, index };
      }
      parts.push({ p: "arm", name: kindField.shape.text, fields: p.fields.filter((f) => f.name !== "kind"), loc: kindField.loc });
    }
    return { c: "tagged", parts, decl, index };
  }
  return { c: "unsupported", why: `a shape outside the sidecar's vocabulary (${s.k})`, decl, index };
}

/* ── the projector ─────────────────────────────────────────────────────── */

interface TableEntry {
  entry: SidecarStruct | SidecarEnum | SidecarUnion;
  kind: "struct" | "enum" | "union";
  anchor: number;
  sub: number;
  /** Present only for anonymous inline records. The generated name is not
   * injective (`A.B_C` and `A_B.C` both become `A_B_C`), so a table hit is
   * reusable only when it came from this exact source declaration. */
  synthesizedOrigin?: {
    container: string;
    member: string;
    fields: ContractField[];
    tagged: boolean;
  };
}

class SidecarError extends Error {
  constructor(
    readonly detail: string,
    readonly loc: SrcLoc,
  ) {
    super(detail);
  }
}

/** A refusal that carries its own minted diagnostic (SC4010/SC4011 —
 * the SC4009 default rides SidecarError). */
class SidecarRefusal extends Error {
  constructor(readonly diag: ScrDiagnostic) {
    super(diag.message);
  }
}

class Projector {
  private readonly byName = new Map<string, Classified>();
  private readonly multiSite = new Map<string, string[]>();
  private readonly table = new Map<string, TableEntry>();
  private readonly inProgress = new Set<string>();
  private readonly flatArms = new Map<string, TaggedArm[]>();
  private readonly allFlatArms = new Map<string, TaggedArm[]>();
  private readonly flattening = new Set<string>();
  private readonly allFlattening = new Set<string>();
  private readonly irPatterning = new Set<string>();
  private synthCounter = 0;
  /** The profile's declared integer slots (ask 4), by slot path; entries
   * move to `intConsumed` as the projection spells them — a declared path
   * the projection never touches refuses (a typo'd path would silently
   * drop an ABI obligation). */
  private readonly intDeclared = new Map<string, "i64" | "u64">();
  readonly intConsumed = new Map<string, "i64" | "u64">();
  /** The record-field slots' resolution facts for the inference: the
   * containing record's complete projected IR shape plus the target field
   * (IR shapes intern structurally by field names and field types). Pattern
   * construction is deferred until the whole contract graph has projected,
   * so an invalid later sibling still takes its ordinary SidecarError path. */
  private readonly pendingIntRecordFacts: PendingIntegerRecordFact[] = [];

  constructor(
    readonly facts: ContractFacts,
    readonly config: LibrarySidecarConfig,
    readonly entryLoc: SrcLoc,
  ) {
    // facts.types carries one entry per name (a repeated exported name is
    // a multi-site fact, refused below when the name is actually used).
    facts.types.forEach((decl, index) => this.byName.set(decl.name, classify(decl, index)));
    for (const m of facts.multiSiteTypes) this.multiSite.set(m.name, m.sites);
    for (const e of config.integerSlots) this.intDeclared.set(e.slot, e.cls);
  }

  /** Spell a projected slot i64 when the profile declared it (ask 4).
   * A NUMBER slot may be bare or optional: optional<number> composes the
   * schema's two existing constructors as optional<i64>, and the proof
   * applies only to its present numeric arm. Slices and named types still
   * refuse — the declaration must match the wire shape the schema freezes.
   * The document spells i64 for both classes (the frozen format-1
   * vocabulary has no u64; u64 is the stricter compile-time obligation
   * over the same wire spelling). */
  intify(ref: TypeRef, slotPath: string, loc: SrcLoc): TypeRef {
    const cls = this.intDeclared.get(slotPath);
    if (cls === undefined) return ref;
    if (ref.kind === "f64") {
      this.intConsumed.set(slotPath, cls);
      return { kind: "i64" };
    }
    if (ref.kind === "optional" && ref.inner.kind === "f64") {
      this.intConsumed.set(slotPath, cls);
      return { kind: "optional", inner: { kind: "i64" } };
    }
    {
      throw new SidecarError(
        `the profile declares integer slot '${slotPath}' (${cls}), but that slot is not a number or optional number slot (it projects as '${ref.kind}')`,
        loc,
      );
    }
  }

  /** intify for a struct field (declared or synthesized), recording the
   * record-resolution fact the inference maps onto interned IR shapes.
   * Synthesized records that are tagged-union payloads retain the source
   * arm's `kind` field in IR even though the wire struct omits it. */
  intifyStructField(
    ref: TypeRef,
    container: string,
    field: string,
    allFields: ContractField[],
    tagged: boolean,
    loc: SrcLoc,
    synthesizedContext?: SynthesizedRecordContext,
  ): TypeRef {
    const slotPath = `${container}.${field}`;
    const before = this.intConsumed.has(slotPath);
    const out = this.intify(ref, slotPath, loc);
    if (!before && this.intConsumed.has(slotPath)) {
      const cls = this.intConsumed.get(slotPath)!;
      if (synthesizedContext !== undefined) {
        this.recordIntegerSynthesizedRecordFacts(
          synthesizedContext,
          container,
          field,
          out,
          tagged,
          cls,
          slotPath,
        );
      } else {
        this.pendingIntRecordFacts.push({
          fields: allFields,
          tagged,
          targetField: field,
          cls,
          path: slotPath,
          loc,
        });
      }
    }
    return out;
  }

  /** Canonical union constructor mirroring the frontend: nested unions
   * flatten, structurally repeated arms collapse, and one surviving arm is
   * just that arm. */
  private irUnionPattern(arms: SidecarIrTypePattern[]): SidecarIrTypePattern {
    const flat: SidecarIrTypePattern[] = [];
    for (const arm of arms) {
      if (arm.kind === "union") flat.push(...arm.arms);
      else flat.push(arm);
    }
    const unique = new Map<string, SidecarIrTypePattern>();
    for (const arm of flat) unique.set(JSON.stringify(arm), arm);
    const canonical = [...unique.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, arm]) => arm);
    if (canonical.length === 0) throw new InternalCompilerError("sidecar pattern bug: empty union");
    return canonical.length === 1 ? canonical[0]! : { kind: "union", arms: canonical };
  }

  private irFieldPattern(field: ContractField): SidecarIrTypePattern {
    const inner = this.irTypePattern(field.shape, field.loc);
    return field.optional
      ? this.irUnionPattern([inner, { kind: "undefinedT" }])
      : inner;
  }

  private irRecordPattern(fields: ContractField[], tagged = false): SidecarIrRecordPattern {
    const projected = fields.map((field) => ({
      name: field.name,
      type: this.irFieldPattern(field),
    }));
    if (tagged) projected.push({ name: "kind", type: { kind: "string" } });
    projected.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      kind: "record",
      fields: projected,
      ...(tagged ? { kindMayBeOmitted: true as const } : {}),
    };
  }

  /** Flatten a tagged union for IR identity, preserving every source
   * constituent. This is deliberately separate from unionArms(): the
   * sidecar's wire table is first-discriminant-name-wins, while the
   * frontend's structural union interner retains later same-named arms
   * whenever their payload shapes differ. irUnionPattern performs the
   * frontend's structural deduplication after this walk. */
  private irTaggedArmPatterns(unionName: string, loc: SrcLoc): SidecarIrRecordPattern[] {
    return this.allUnionArms(unionName, loc).map((arm) => this.irRecordPattern(arm.fields, true));
  }

  /** Convert a sidecar-supported syntactic type into the exact structural
   * IR pattern the frontend maps it to. Projection has already refused
   * unsupported shapes before an integer fact is recorded, so the default
   * cases are internal consistency checks. */
  private irTypePattern(shape: ContractTypeShape, loc: SrcLoc): SidecarIrTypePattern {
    switch (shape.k) {
      case "number":
        return { kind: "f64" };
      case "text":
      case "stringLit":
        return { kind: "string" };
      case "bool":
        return { kind: "bool" };
      case "bytes":
        return { kind: "bytes", elem: "u8" };
      case "absent":
        return { kind: shape.unit === "null" ? "nullT" : "undefinedT" };
      case "array":
        return { kind: "array", elem: this.irTypePattern(shape.elem, loc) };
      case "union":
        return this.irUnionPattern(shape.parts.map((part) => this.irTypePattern(part, loc)));
      case "object":
        // A declared `{}` annotation is TypeScript's top non-nullish type,
        // not the inferred shape of an empty object literal. The frontend
        // therefore lowers it to dyn (type-mapper.ts's declared-empty rule).
        return shape.fields.length === 0
          ? { kind: "dyn" }
          : this.irRecordPattern(shape.fields);
      case "ref": {
        const resolved = this.resolve(shape.name, loc);
        if (resolved.c.c === "scalar") return this.irTypePattern(resolved.c.shape, loc);
        if (resolved.c.c === "enum") return { kind: "string" };
        if (resolved.c.c === "struct" && resolved.c.fields.length === 0) {
          return { kind: "dyn" };
        }
        if (this.irPatterning.has(resolved.name)) {
          throw new SidecarError(
            `the contract type graph is cyclic through '${resolved.name}' — recursive contract types cannot encode`,
            loc,
          );
        }
        this.irPatterning.add(resolved.name);
        try {
          return resolved.c.c === "struct"
            ? this.irRecordPattern(resolved.c.fields)
            : this.irUnionPattern(this.irTaggedArmPatterns(resolved.name, loc));
        } finally {
          this.irPatterning.delete(resolved.name);
        }
      }
      case "void":
      case "tuple":
      case "unsupported":
        throw new SidecarError(
          `an integer-slot record contains a shape outside the sidecar's structural vocabulary (${shape.k})`,
          loc,
        );
    }
  }

  /** A declared slot path that the whole projection never spelled: the
   * path names nothing (or names a slot outside the schema's integer
   * grammar), and silently ignoring it would drop an ABI obligation. */
  checkIntConsumed(): void {
    for (const [slot, cls] of this.intDeclared) {
      if (!this.intConsumed.has(slot)) {
        throw new SidecarError(
          `the profile declares integer slot '${slot}' (${cls}), but the projected contract has no number slot at that path (paths: 'Type.field', 'Union.arm', '<msg>.arm', '<msg>.arm.numberField', 'helpers.<name>.params[i]', 'helpers.<name>.return'; a profile export's integer class is declared on its 'exports' entry — the C signature itself attests it, never integer_slots)`,
          this.entryLoc,
        );
      }
    }
  }

  lookup(name: string, loc: SrcLoc): Exclude<Classified, { c: "unsupported" }> {
    const c = this.byName.get(name);
    if (c === undefined) {
      throw new SidecarError(`'${name}' is not an exported type declaration of the program's modules`, loc);
    }
    // Define-or-refuse: a name whose members gather from several
    // declaration sites has no single-source order — refuse the moment
    // the contract touches it, naming every site (SC4010).
    const sites = this.multiSite.get(name);
    if (sites !== undefined) {
      throw new SidecarRefusal(libSidecarMergedDiag(name, sites, c.decl.loc));
    }
    if (c.c === "unsupported") {
      if (c.computed !== undefined) {
        throw new SidecarRefusal(libSidecarComputedDiag(name, c.computed, c.decl.loc));
      }
      throw new SidecarError(`'${name}' cannot join the type table: it is ${c.why}`, c.decl.loc);
    }
    return c;
  }

  /** Follow `type A = B` alias chains to the aliased declaration: the
   * table derives from the target's declaration site, and the alias
   * introduces no entry and no reordering. */
  resolve(name: string, loc: SrcLoc): { name: string; c: Exclude<Classified, { c: "unsupported" | "alias" }> } {
    const seen = new Set<string>();
    let cur = name;
    for (;;) {
      if (seen.has(cur)) {
        throw new SidecarError(`the type alias chain through '${name}' is cyclic`, loc);
      }
      seen.add(cur);
      const c = this.lookup(cur, loc);
      if (c.c !== "alias") return { name: cur, c };
      cur = c.target;
    }
  }

  /** Resolve only aliases whose names have no wire identity. Named
   * records/enums/unions return null and retain their table projection. */
  private scalarShape(shape: ContractTypeShape, loc: SrcLoc): ScalarContractShape | null {
    if (shape.k === "bool" || shape.k === "number" || shape.k === "text" || shape.k === "bytes") {
      return shape;
    }
    if (shape.k !== "ref") return null;
    const resolved = this.resolve(shape.name, loc);
    return resolved.c.c === "scalar" ? resolved.c.shape : null;
  }

  /** A kind-tagged union's arms, its reference constituents flattened
   * DEPTH-FIRST IN SOURCE ORDER (the ask-3 composition rule, pinned by
   * conformance): an inline arm lands where it is spelled; a constituent
   * union contributes its own (recursively flattened) arms, in its own
   * declaration order, at the position of the reference. An arm name
   * arriving from several constituents keeps its FIRST occurrence; a
   * repeat among one declaration's own inline arms stays a refusal. */
  unionArms(unionName: string, loc: SrcLoc): { name: string; fields: ContractField[]; loc: SrcLoc }[] {
    const memo = this.flatArms.get(unionName);
    if (memo !== undefined) return memo;
    if (this.flattening.has(unionName)) {
      throw new SidecarError(`union composition is cyclic through '${unionName}' — a union cannot spread itself`, loc);
    }
    const c = this.lookup(unionName, loc);
    if (c.c !== "tagged") {
      throw new SidecarError(`'${unionName}' is not a kind-tagged union of object literals`, c.decl.loc);
    }
    this.flattening.add(unionName);
    try {
      const out: { name: string; fields: ContractField[]; loc: SrcLoc }[] = [];
      const originOf = new Map<string, string>();
      for (const part of c.parts) {
        if (part.p === "arm") {
          const origin = originOf.get(part.name);
          if (origin === unionName) {
            throw new SidecarError(`union '${unionName}' repeats arm '${part.name}'`, part.loc);
          }
          if (origin !== undefined) continue; // an earlier constituent's arm — first occurrence wins
          originOf.set(part.name, unionName);
          out.push({ name: part.name, fields: part.fields, loc: part.loc });
          continue;
        }
        const r = this.resolve(part.name, part.loc);
        if (r.c.c !== "tagged") {
          throw new SidecarError(
            `constituent '${part.name}' of union '${unionName}' is not a kind-tagged union — only kind-tagged unions compose by reference`,
            part.loc,
          );
        }
        for (const arm of this.unionArms(r.name, part.loc)) {
          if (originOf.has(arm.name)) continue; // first occurrence wins under depth-first order
          originOf.set(arm.name, r.name);
          out.push(arm);
        }
      }
      this.flatArms.set(unionName, out);
      return out;
    } finally {
      this.flattening.delete(unionName);
    }
  }

  /** Every source constituent of a composed tagged union, including later
   * occurrences of an already-seen discriminant name. The wire table keeps
   * first occurrence, but structural matching and integer obligations must
   * retain all shapes the frontend can lower under that discriminant. */
  private allUnionArms(unionName: string, loc: SrcLoc): TaggedArm[] {
    const memo = this.allFlatArms.get(unionName);
    if (memo !== undefined) return memo;
    if (this.allFlattening.has(unionName)) {
      throw new SidecarError(`union composition is cyclic through '${unionName}' — a union cannot spread itself`, loc);
    }
    const c = this.lookup(unionName, loc);
    if (c.c !== "tagged") {
      throw new SidecarError(`'${unionName}' is not a kind-tagged union of object literals`, c.decl.loc);
    }
    this.allFlattening.add(unionName);
    try {
      const out: TaggedArm[] = [];
      for (const part of c.parts) {
        if (part.p === "arm") {
          out.push({ name: part.name, fields: part.fields, loc: part.loc });
          continue;
        }
        const r = this.resolve(part.name, part.loc);
        if (r.c.c !== "tagged") {
          throw new SidecarError(
            `constituent '${part.name}' of union '${unionName}' is not a kind-tagged union — only kind-tagged unions compose by reference`,
            part.loc,
          );
        }
        out.push(...this.allUnionArms(r.name, part.loc));
      }
      this.allFlatArms.set(unionName, out);
      return out;
    } finally {
      this.allFlattening.delete(unionName);
    }
  }

  /** Lazily retain every source occurrence of a wire-selected arm. Most
   * synthesized records have no integer declaration, so the full composed
   * walk stays deferred until a nested slot actually needs proof facts. */
  private synthesizedArmContext(
    unionName: string,
    armName: string,
    loc: SrcLoc,
  ): SynthesizedRecordContext {
    return {
      armName,
      variants: () =>
        this.allUnionArms(unionName, loc)
          .filter((arm) => arm.name === armName)
          .map((arm) => ({ fields: arm.fields, loc: arm.loc })),
    };
  }

  /** Follow one inline-object field through every composed occurrence of
   * the selected arm. Missing or differently shaped occurrences remain in
   * the context as refusals, but only matter if an integer slot is declared
   * inside this nested synthesized record. */
  private nestedSynthesizedRecordContext(
    parent: SynthesizedRecordContext,
    member: string,
  ): SynthesizedRecordContext {
    return {
      armName: parent.armName,
      variants: () =>
        parent.variants().map((variant): SynthesizedRecordVariant => {
          if (variant.fields === null) return variant;
          const field = variant.fields.find((candidate) => candidate.name === member);
          if (field === undefined) {
            return {
              fields: null,
              loc: variant.loc,
              why: `has no field '${member}' leading to that nested record`,
            };
          }
          const fields = this.inlineRecordFields(field.shape);
          return fields === null
            ? {
                fields: null,
                loc: field.loc,
                why: `projects field '${member}' as a non-inline-record shape`,
              }
            : { fields, loc: field.loc };
        }),
    };
  }

  /** The object whose fields tableSynthesized will project through the
   * sidecar's optional/array wrappers, or null when the shape names or
   * projects something other than an inline record. */
  private inlineRecordFields(shape: ContractTypeShape): ContractField[] | null {
    if (shape.k === "object") return shape.fields;
    if (shape.k === "array") return this.inlineRecordFields(shape.elem);
    if (shape.k === "union") {
      const present = shape.parts.filter((part) => part.k !== "absent");
      return present.length === 1 && present.length !== shape.parts.length
        ? this.inlineRecordFields(present[0]!)
        : null;
    }
    return null;
  }

  /** Record a synthesized-record field obligation for every composed
   * occurrence of the wire-selected discriminant. The first arm supplies
   * the wire struct, but later same-named arms may lower to distinct record
   * shapes; every compatible numeric field therefore needs the same proof.
   * An absent, non-number, or newly optional field cannot satisfy the
   * selected wire slot and refuses at projection. */
  private recordIntegerSynthesizedRecordFacts(
    context: SynthesizedRecordContext,
    container: string,
    targetField: string,
    intifiedRef: TypeRef,
    tagged: boolean,
    cls: "i64" | "u64",
    path: string,
  ): void {
    const selectedOptional =
      intifiedRef.kind === "optional" && intifiedRef.inner.kind === "i64";
    if (intifiedRef.kind !== "i64" && !selectedOptional) {
      throw new InternalCompilerError(`sidecar pattern bug: synthesized integer field '${path}' has ref '${intifiedRef.kind}'`);
    }
    for (const variant of context.variants()) {
      if (variant.fields === null) {
        throw new SidecarError(
          `integer slot '${path}' (${cls}) selects synthesized record field '${targetField}', but another composed '${context.armName}' arm ${variant.why}`,
          variant.loc,
        );
      }
      const field = variant.fields.find((candidate) => candidate.name === targetField);
      if (field === undefined) {
        throw new SidecarError(
          `integer slot '${path}' (${cls}) selects synthesized record field '${targetField}', but another composed '${context.armName}' arm has no such field`,
          variant.loc,
        );
      }
      const ref = this.fieldRef(field, container);
      const candidateOptional = ref.kind === "optional" && ref.inner.kind === "f64";
      if (ref.kind !== "f64" && !candidateOptional) {
        throw new SidecarError(
          `integer slot '${path}' (${cls}) selects synthesized record field '${targetField}', but another composed '${context.armName}' arm projects that field as '${ref.kind}'`,
          field.loc,
        );
      }
      if (!selectedOptional && candidateOptional) {
        throw new SidecarError(
          `integer slot '${path}' (${cls}) selects required synthesized record field '${targetField}', but another composed '${context.armName}' arm makes that field optional`,
          field.loc,
        );
      }
      this.pendingIntRecordFacts.push({
        fields: variant.fields,
        tagged,
        targetField,
        cls,
        path,
        loc: variant.loc,
      });
    }
  }

  /** Record one integer obligation for every lowered structural arm carrying
   * the wire-selected discriminant. A composed union can repeat an arm name
   * with a different payload field name; the sidecar's scalar descriptor
   * omits that source name, so each compatible record shape must prove the
   * same boundary slot. Incompatible later payloads refuse rather than let a
   * non-integer value ride an integer-attested wire arm. */
  private recordIntegerUnionArmFacts(
    unionName: string,
    armName: string,
    intifiedRef: TypeRef,
    cls: "i64" | "u64",
    path: string,
    loc: SrcLoc,
  ): void {
    const selectedOptional =
      intifiedRef.kind === "optional" && intifiedRef.inner.kind === "i64";
    if (intifiedRef.kind !== "i64" && !selectedOptional) {
      throw new InternalCompilerError(`sidecar pattern bug: integer arm '${path}' has ref '${intifiedRef.kind}'`);
    }
    for (const arm of this.allUnionArms(unionName, loc)) {
      if (arm.name !== armName) continue;
      if (arm.fields.length !== 1) {
        throw new SidecarError(
          `integer slot '${path}' (${cls}) selects a scalar ${selectedOptional ? "optional " : ""}number payload, but another composed '${armName}' arm has ${arm.fields.length === 0 ? "no payload" : `${arm.fields.length} payload fields`}`,
          arm.loc,
        );
      }
      const field = arm.fields[0]!;
      const ref = this.fieldRef(field, unionName);
      const candidateOptional = ref.kind === "optional" && ref.inner.kind === "f64";
      if (ref.kind !== "f64" && !candidateOptional) {
        throw new SidecarError(
          `integer slot '${path}' (${cls}) selects a scalar ${selectedOptional ? "optional " : ""}number payload, but another composed '${armName}' arm projects as '${ref.kind}'`,
          arm.loc,
        );
      }
      if (!selectedOptional && candidateOptional) {
        throw new SidecarError(
          `integer slot '${path}' (${cls}) selects a required number payload, but another composed '${armName}' arm makes that payload optional`,
          arm.loc,
        );
      }
      this.pendingIntRecordFacts.push({
        fields: arm.fields,
        tagged: true,
        targetField: field.name,
        cls,
        path,
        loc: arm.loc,
      });
    }
  }

  /** Record a number_bytes obligation for every composed occurrence of the
   * wire-selected discriminant. Unlike a scalar descriptor, number_bytes
   * exposes both source field names, so a later same-named arm must retain
   * those names and the required number-then-bytes family. Text and bytes
   * are the same sidecar bytes payload but distinct IR shapes; compatible
   * occurrences therefore each need their own structural inference fact. */
  private recordIntegerNumberBytesArmFacts(
    unionName: string,
    armName: string,
    numberField: string,
    bytesField: string,
    cls: "i64" | "u64",
    path: string,
    loc: SrcLoc,
  ): void {
    for (const arm of this.allUnionArms(unionName, loc)) {
      if (arm.name !== armName) continue;
      const [number, bytes] = arm.fields;
      const numberShape = number === undefined ? null : this.scalarShape(number.shape, number.loc);
      const bytesShape = bytes === undefined ? null : this.scalarShape(bytes.shape, bytes.loc);
      const compatible =
        arm.fields.length === 2 &&
        number !== undefined &&
        bytes !== undefined &&
        !number.optional &&
        !bytes.optional &&
        number.name === numberField &&
        bytes.name === bytesField &&
        numberShape?.k === "number" &&
        (bytesShape?.k === "text" || bytesShape?.k === "bytes");
      if (!compatible) {
        throw new SidecarError(
          `integer slot '${path}' (${cls}) selects number_bytes payload fields '${numberField}' and '${bytesField}', but another composed '${armName}' arm does not have the same required number-then-bytes fields`,
          arm.loc,
        );
      }
      this.pendingIntRecordFacts.push({
        fields: arm.fields,
        tagged: true,
        targetField: numberField,
        cls,
        path,
        loc: arm.loc,
      });
    }
  }

  /** Project a syntactic field to a TypeRef, tabling every named type it
   * references. `container`/`member` seed synthesized names. */
  fieldRef(
    field: ContractField,
    container: string,
    synthesizedContext?: SynthesizedRecordContext,
  ): TypeRef {
    const inner = this.shapeRef(field.shape, container, field.name, field.loc, synthesizedContext);
    if (field.optional) {
      if (inner.kind === "optional") return inner;
      return { kind: "optional", inner };
    }
    return inner;
  }

  shapeRef(
    shape: ContractTypeShape,
    container: string,
    member: string,
    loc: SrcLoc,
    synthesizedContext?: SynthesizedRecordContext,
  ): TypeRef {
    switch (shape.k) {
      case "bool":
        return { kind: "bool" };
      case "number":
        // Every numeric slot spells f64 until ask-4 integer inference
        // lands (the schema's stated pre-inference sequencing).
        return { kind: "f64" };
      case "text":
      case "bytes":
        return { kind: "bytes" };
      case "array":
        return { kind: "slice", elem: this.shapeRef(shape.elem, container, member, loc, synthesizedContext) };
      case "union": {
        const present = shape.parts.filter((p) => p.k !== "absent");
        const absents = shape.parts.length - present.length;
        if (absents > 0 && present.length === 1) {
          const inner = this.shapeRef(present[0]!, container, member, loc, synthesizedContext);
          return inner.kind === "optional" ? inner : { kind: "optional", inner };
        }
        throw new SidecarError(
          `'${container}.${member}' is an inline union — declare it as a named kind-tagged union (or a string-literal-union enum) and reference it by name`,
          loc,
        );
      }
      case "ref": {
        // Scalar aliases dissolve to their underlying TypeRef. Named-type
        // aliases remain transparent to the aliased table declaration.
        const r = this.resolve(shape.name, loc);
        if (r.c.c === "scalar") {
          return this.shapeRef(r.c.shape, container, member, loc, synthesizedContext);
        }
        if (r.c.c === "struct") {
          this.tableNamed(r.name, loc);
          return { kind: r.c.storage, name: r.name };
        }
        if (r.c.c === "enum") {
          this.tableNamed(r.name, loc);
          return { kind: "enum", name: r.name };
        }
        if (r.name === this.config.msg) {
          throw new SidecarError(
            `'${container}.${member}' references the designated msg union '${r.name}' — the msg union is the dispatch surface, not a table type`,
            loc,
          );
        }
        this.tableNamed(r.name, loc);
        return { kind: "union", name: r.name };
      }
      case "object":
        return {
          kind: "value",
          name: this.tableSynthesized(
            container,
            member,
            shape.fields,
            false,
            loc,
            synthesizedContext === undefined
              ? undefined
              : this.nestedSynthesizedRecordContext(synthesizedContext, member),
          ),
        };
      case "stringLit":
        throw new SidecarError(
          `'${container}.${member}' is a bare string-literal type — declare a named string-literal union and reference it as an enum`,
          loc,
        );
      case "void":
        throw new SidecarError(`'${container}.${member}' is void — void exists only as a bare union arm's payload`, loc);
      case "absent":
        throw new SidecarError(`'${container}.${member}' is null/undefined alone — pair it with a value type for an optional slot`, loc);
      case "tuple":
        throw new SidecarError(`'${container}.${member}' is a tuple — the sidecar vocabulary has slices and named records, not positional tuples`, loc);
      case "unsupported":
        throw new SidecarError(`'${container}.${member}' has no sidecar projection: ${shape.text}`, loc);
    }
  }

  /** Ensure a declared type's table entry exists (recursively projecting
   * what it references). Cycles refuse: recursive contract types cannot
   * encode (schema rule V5). */
  tableNamed(name: string, loc: SrcLoc): void {
    if (this.table.has(name)) return;
    if (name === this.config.msg) {
      throw new SidecarError(`the designated msg union '${name}' cannot join the type table`, loc);
    }
    if (this.inProgress.has(name)) {
      throw new SidecarError(`the contract type graph is cyclic through '${name}' — recursive contract types cannot encode`, loc);
    }
    const c = this.lookup(name, loc);
    if (c.c === "alias") {
      // Callers table resolved names; a designation reaching here through
      // an alias still tables the aliased declaration, nothing else.
      this.tableNamed(this.resolve(name, loc).name, loc);
      return;
    }
    if (c.c === "scalar") {
      // Scalar aliases dissolve at their reference site and never have a
      // type-table entry of their own.
      return;
    }
    this.inProgress.add(name);
    try {
      if (c.c === "enum") {
        const seen = new Set<string>();
        for (const m of c.members) {
          if (seen.has(m)) throw new SidecarError(`enum '${name}' repeats member '${m}'`, c.decl.loc);
          seen.add(m);
        }
        this.table.set(name, { kind: "enum", entry: { name, members: c.members }, anchor: c.index, sub: -1 });
        return;
      }
      if (c.c === "struct") {
        const entry: SidecarStruct = { name, fields: [] };
        // Insert before projecting fields? No: cycle detection rides
        // inProgress; the entry lands complete.
        const seen = new Set<string>();
        for (const f of c.fields) {
          if (seen.has(f.name)) throw new SidecarError(`record '${name}' repeats field '${f.name}'`, f.loc);
          seen.add(f.name);
          entry.fields.push({
            name: f.name,
            type: this.intifyStructField(this.fieldRef(f, name), name, f.name, c.fields, false, f.loc),
          });
        }
        this.table.set(name, { kind: "struct", entry, anchor: c.index, sub: -1 });
        return;
      }
      // A named tagged union (never the msg union — fenced above), its
      // arms flattened depth-first (composition + the repeat refusal live
      // in unionArms).
      const entry: SidecarUnion = { name, arms: [] };
      for (const arm of this.unionArms(name, loc)) {
        let payload = this.armPayloadRef(name, arm);
        const slotPath = `${name}.${arm.name}`;
        const before = this.intConsumed.has(slotPath);
        payload = this.intify(payload, slotPath, arm.loc);
        if (!before && this.intConsumed.has(slotPath)) {
          this.recordIntegerUnionArmFacts(
            name,
            arm.name,
            payload,
            this.intConsumed.get(slotPath)!,
            slotPath,
            arm.loc,
          );
        }
        entry.arms.push({ name: arm.name, payload });
      }
      this.table.set(name, { kind: "union", entry, anchor: c.index, sub: -1 });
    } finally {
      this.inProgress.delete(name);
    }
  }

  /** A named union arm's payload TypeRef: void for bare arms, the single
   * payload field's type, or a synthesized by-value record for
   * multi-field inline payloads. */
  armPayloadRef(unionName: string, arm: { name: string; fields: ContractField[]; loc: SrcLoc }): TypeRef {
    if (arm.fields.length === 0) return { kind: "void" };
    const synthesizedContext = this.synthesizedArmContext(unionName, arm.name, arm.loc);
    if (arm.fields.length === 1) return this.fieldRef(arm.fields[0]!, unionName, synthesizedContext);
    return {
      kind: "value",
      name: this.tableSynthesized(unionName, arm.name, arm.fields, true, arm.loc, synthesizedContext),
    };
  }

  /** Table an anonymous inline record under the schema's synthesized-name
   * contract: `<Container>_<member>`, deterministic and stable across
   * identical re-compiles, unique in the one namespace. `tagged` records
   * whether this wire payload comes from a union arm whose lowered IR shape
   * also carries the discriminant. */
  tableSynthesized(
    container: string,
    member: string,
    fields: ContractField[],
    tagged: boolean,
    loc: SrcLoc,
    synthesizedContext?: SynthesizedRecordContext,
  ): string {
    const name = `${container}_${member}`;
    if (this.byName.has(name)) {
      throw new SidecarError(
        `the inline record at '${container}.${member}' needs the synthesized name '${name}', which a declared type already uses — rename one`,
        loc,
      );
    }
    const existing = this.table.get(name);
    if (existing !== undefined) {
      const origin = existing.synthesizedOrigin;
      if (
        origin !== undefined &&
        origin.container === container &&
        origin.member === member &&
        origin.fields === fields &&
        origin.tagged === tagged
      ) {
        return name; // the same inline declaration, revisited
      }
      const owner =
        origin === undefined
          ? `a declared type`
          : `another inline record at '${origin.container}.${origin.member}'`;
      throw new SidecarError(
        `the inline record at '${container}.${member}' needs the synthesized name '${name}', which ${owner} already uses — rename one`,
        loc,
      );
    }
    const entry: SidecarStruct = { name, synthesized: true, fields: [] };
    const anchor = this.byName.get(container)?.index ?? this.facts.types.length;
    const sub = this.synthCounter++;
    this.table.set(name, {
      kind: "struct",
      entry,
      anchor,
      sub,
      synthesizedOrigin: { container, member, fields, tagged },
    });
    const seen = new Set<string>();
    for (const f of fields) {
      if (seen.has(f.name)) throw new SidecarError(`the inline record at '${container}.${member}' repeats field '${f.name}'`, f.loc);
      seen.add(f.name);
      entry.fields.push({
        name: f.name,
        type: this.intifyStructField(
          this.fieldRef(f, name, synthesizedContext),
          name,
          f.name,
          fields,
          tagged,
          f.loc,
          synthesizedContext,
        ),
      });
    }
    return name;
  }

  /** A msg arm's payload descriptor (§5's five families). */
  msgDescriptor(msgName: string, arm: { name: string; fields: ContractField[]; loc: SrcLoc }): PayloadDescriptor {
    const fields = arm.fields;
    if (fields.length === 0) return { kind: "void" };
    const synthesizedContext = this.synthesizedArmContext(msgName, arm.name, arm.loc);
    if (fields.length === 2) {
      const [first, second] = [fields[0]!, fields[1]!];
      const firstShape = this.scalarShape(first.shape, first.loc);
      const secondShape = this.scalarShape(second.shape, second.loc);
      // Family 4 covers exactly the number-first two-field record; a
      // bytes-first spelling takes the record family instead
      // (declaration order is semantic everywhere — the clarified rule).
      if (
        !first.optional &&
        !second.optional &&
        firstShape?.k === "number" &&
        (secondShape?.k === "text" || secondShape?.k === "bytes")
      ) {
        // The number half is an ask-4 declarable slot:
        // `<msg>.<arm>.<numberField>` (the schema's number_bytes path).
        const slotPath = `${msgName}.${arm.name}.${first.name}`;
        const numRef = this.intify({ kind: "f64" }, slotPath, first.loc);
        if (numRef.kind === "i64") {
          this.recordIntegerNumberBytesArmFacts(
            msgName,
            arm.name,
            first.name,
            second.name,
            this.intConsumed.get(slotPath)!,
            slotPath,
            first.loc,
          );
        }
        return { kind: "number_bytes", number_field: first.name, number_class: numRef.kind as "f64" | "i64", bytes_field: second.name };
      }
    }
    if (fields.length === 1 && !fields[0]!.optional) {
      let ref = this.fieldRef(fields[0]!, msgName, synthesizedContext);
      // A bare or optional number payload is an ask-4 declarable slot:
      // `<msg>.<arm>`. Calling intify for every one-field family also makes
      // a declaration targeting a non-number refuse at the precise arm.
      const slotPath = `${msgName}.${arm.name}`;
      const before = this.intConsumed.has(slotPath);
      ref = this.intify(ref, slotPath, arm.loc);
      if (!before && this.intConsumed.has(slotPath)) {
        this.recordIntegerUnionArmFacts(
          msgName,
          arm.name,
          ref,
          this.intConsumed.get(slotPath)!,
          slotPath,
          arm.loc,
        );
      }
      switch (ref.kind) {
        case "bytes":
          return { kind: "bytes" };
        case "f64":
        case "i64":
          return { kind: "number", class: ref.kind };
        case "node":
        case "value":
          return { kind: "record", name: ref.name };
        case "union":
          return { kind: "union", name: ref.name };
        case "enum":
          return { kind: "enum", name: ref.name };
        case "void":
          return { kind: "void" };
        default:
          return { kind: "scalar", type: ref };
      }
    }
    // Everything else — bytes-first pairs, three-plus fields, optional
    // payload fields — tables a synthesized record (family 5).
    return {
      kind: "record",
      name: this.tableSynthesized(msgName, arm.name, fields, true, arm.loc, synthesizedContext),
    };
  }

  /** Materialize structural join patterns only after normal sidecar
   * projection has validated every field reachable from these facts. */
  finishedIntRecordFacts(): SidecarIntegerSlotFacts["records"] {
    return this.pendingIntRecordFacts.map(({ fields, tagged, ...fact }) => ({
      shape: this.irRecordPattern(fields, tagged),
      ...fact,
    }));
  }

  /** The finished type table, each array in declaration order (synthesized
   * entries anchor at their containing declaration). */
  finishedTable(): { structs: SidecarStruct[]; enums: SidecarEnum[]; unions: SidecarUnion[] } {
    const ordered = [...this.table.values()].sort((a, b) => a.anchor - b.anchor || a.sub - b.sub);
    return {
      structs: ordered.filter((e) => e.kind === "struct").map((e) => e.entry as SidecarStruct),
      enums: ordered.filter((e) => e.kind === "enum").map((e) => e.entry as SidecarEnum),
      unions: ordered.filter((e) => e.kind === "union").map((e) => e.entry as SidecarUnion),
    };
  }
}

/* ── the document builder ──────────────────────────────────────────────── */

export interface SidecarBuildInput {
  profile: LibraryProfile;
  facts: ContractFacts;
  compilerVersion: string;
  /** Entry module path, compilation-root-relative, POSIX separators. */
  entry: string;
  buildId: string;
  sourceHash: string;
  deterministic: boolean;
}

/** The declared integer slots (ask 4), resolved by the projection into
 * the facts the boundary inference maps onto lowered IR: helper slots by
 * function name and IR parameter index (the schema's helper param index
 * skips the model receiver, so `index` is already shifted +1), and
 * record-field slots by the containing record's complete structural IR
 * pattern plus the target field (IR record shapes intern by both field
 * names and field types, so the full signature is the join key). */
export interface SidecarIntegerSlotFacts {
  helpers: { fnName: string; kind: "param" | "return"; index?: number; cls: "i64" | "u64"; path: string }[];
  records: {
    shape: SidecarIrRecordPattern;
    targetField: string;
    cls: "i64" | "u64";
    path: string;
    loc: SrcLoc;
  }[];
}

export type SidecarBuildResult =
  | { ok: true; doc: SidecarDoc; json: string; integerSlotFacts: SidecarIntegerSlotFacts }
  | { ok: false; diagnostics: ScrDiagnostic[] };

/** Whether a helper's result rides the transient result arena (anything
 * materialized: buffers, slices, records, optionals) rather than a plain
 * scalar return. */
function helperArena(returns: TypeRef): boolean {
  return returns.kind !== "bool" && returns.kind !== "f64" && returns.kind !== "i64" && returns.kind !== "enum";
}

export function buildSidecar(input: SidecarBuildInput): SidecarBuildResult {
  const { profile, facts } = input;
  const config = profile.sidecar!;
  const entryLoc: SrcLoc = { file: profile.entry, start: 0, end: 0 };
  const diagnostics: ScrDiagnostic[] = [];

  for (const m of facts.malformedConsts) {
    diagnostics.push(libSidecarDiag(`exported const '${m.name}' ${m.detail}`, m.loc));
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  try {
    const projector = new Projector(facts, config, entryLoc);
    const helperIntFacts: SidecarIntegerSlotFacts["helpers"] = [];

    // The model: the designated root state type, a record in the table.
    const modelClass = projector.lookup(config.model, entryLoc);
    if (modelClass.c !== "struct") {
      throw new SidecarError(`the profile designates model '${config.model}', which is not a record type`, modelClass.decl.loc);
    }
    projector.tableNamed(config.model, entryLoc);
    const modelFieldNames = new Set(modelClass.fields.map((f) => f.name));

    // The msg union: declaration-order arms (composed constituents
    // flattened depth-first in source order, first occurrence winning a
    // duplicated arm name — the reducer-composition rule), positional
    // wire tags, at most 256 arms (tags ride a u8).
    const msgClass = projector.lookup(config.msg, entryLoc);
    if (msgClass.c !== "tagged") {
      throw new SidecarError(`the profile designates msg '${config.msg}', which is not a kind-tagged union of object literals`, msgClass.decl.loc);
    }
    const flatArms = projector.unionArms(config.msg, entryLoc);
    if (flatArms.length > 256) {
      throw new SidecarError(
        `msg union '${config.msg}' declares ${flatArms.length} arms — wire tags ride a u8, so at most 256 are permitted`,
        msgClass.decl.loc,
      );
    }
    const msgArms: { name: string; payload: PayloadDescriptor }[] = flatArms.map((arm) => ({
      name: arm.name,
      payload: projector.msgDescriptor(config.msg, arm),
    }));
    const armByName = new Map(msgArms.map((a) => [a.name, a.payload]));

    // Helpers: exported functions taking the model first, in declaration
    // order (the array index is the ABI call index), minus the designated
    // init/update/subscriptions entries.
    const designated = new Set([config.initExport, config.updateExport, config.subscriptionsExport]);
    const helpers: SidecarHelper[] = [];
    for (const fn of facts.functions) {
      if (designated.has(fn.name)) continue;
      const first = fn.params[0];
      if (first === undefined || first.shape === null || first.shape.k !== "ref" || first.shape.name !== config.model) continue;
      if (fn.generic) {
        throw new SidecarError(`helper '${fn.name}' is generic — a contract helper needs one concrete signature`, fn.loc);
      }
      const params: TypeRef[] = [];
      fn.params.slice(1).forEach((p, i) => {
        if (p.shape === null) {
          throw new SidecarError(`helper '${fn.name}' parameter ${i + 2} ('${p.name}') has no type annotation`, fn.loc);
        }
        const pPath = `helpers.${fn.name}.params[${i}]`;
        const ref = projector.intify(projector.shapeRef(p.shape, `helpers_${fn.name}`, p.name, fn.loc), pPath, fn.loc);
        if (projector.intConsumed.has(pPath)) {
          // IR param 0 is the model receiver the schema's index skips.
          helperIntFacts.push({ fnName: fn.name, kind: "param", index: i + 1, cls: projector.intConsumed.get(pPath)!, path: pPath });
        }
        params.push(ref);
      });
      if (fn.returns === null) {
        throw new SidecarError(`helper '${fn.name}' has no return type annotation`, fn.loc);
      }
      if (fn.returns.k === "void") {
        throw new SidecarError(`helper '${fn.name}' returns void — a contract helper returns a value the host can read`, fn.loc);
      }
      // Helper-return synthesized names are two-part like everything else:
      // container 'helpers', member the helper's name — `helpers_<name>`,
      // never a '_return' suffix (the ratified spelling).
      const rPath = `helpers.${fn.name}.return`;
      const returns = projector.intify(projector.shapeRef(fn.returns, "helpers", fn.name, fn.loc), rPath, fn.loc);
      if (projector.intConsumed.has(rPath)) {
        helperIntFacts.push({ fnName: fn.name, kind: "return", cls: projector.intConsumed.get(rPath)!, path: rPath });
      }
      if (helpers.some((h) => h.name === fn.name)) {
        throw new SidecarError(`helper '${fn.name}' is declared twice`, fn.loc);
      }
      helpers.push({ name: fn.name, params, returns, arena: helperArena(returns) });
    }
    const helperNames = new Set(helpers.map((h) => h.name));

    // Shape flags from the designated entries' declared signatures.
    const subscriptionsFn = facts.functions.find((f) => f.name === config.subscriptionsExport);
    if (config.subscriptionsExportDeclared && subscriptionsFn === undefined) {
      throw new SidecarRefusal(
        libSidecarDiag(
          `'sidecar.subscriptions_export' designates export '${config.subscriptionsExport}', but the entry module exports no function by that name`,
          { file: profile.profilePath, start: 0, end: 0 },
          `export a function named '${config.subscriptionsExport}' from the entry module, or omit 'sidecar.subscriptions_export' when the contract has no subscriptions entry`,
        ),
      );
    }
    const returnsCmd = (which: "init" | "update", exportName: string): boolean => {
      const fn = facts.functions.find((f) => f.name === exportName);
      if (fn === undefined) {
        throw new SidecarError(`the profile designates ${which} export '${exportName}', but the entry module exports no function by that name`, entryLoc);
      }
      const r = fn.returns;
      if (r !== null && r.k === "ref" && r.name === config.model) return false;
      if (r !== null && r.k === "tuple" && r.elems.length === 2 && r.elems[0]!.k === "ref" && (r.elems[0] as { name: string }).name === config.model) {
        return true;
      }
      throw new SidecarError(
        `${which} export '${exportName}' must declare its return as '${config.model}' (bare state) or a two-element tuple '[${config.model}, ...]' (state plus an effect value)`,
        fn.loc,
      );
    };
    const initReturnsCmd = returnsCmd("init", config.initExport);
    const updateReturnsCmd = returnsCmd("update", config.updateExport);
    const hasSubscriptions = subscriptionsFn !== undefined;

    // Unbound lists: model fields or helper entries (helpers are bindable
    // surface — the clarified rule) on the model side, arm names on the
    // msg side. Absent consts mean "the program declares none".
    const modelUnbound = facts.modelUnbound?.value ?? [];
    for (const name of modelUnbound) {
      if (!modelFieldNames.has(name) && !helperNames.has(name)) {
        throw new SidecarError(
          `modelUnbound names '${name}', which is neither a field of '${config.model}' nor a helper entry`,
          facts.modelUnbound!.loc,
        );
      }
    }
    const msgUnbound = facts.msgUnbound?.value ?? [];
    for (const name of msgUnbound) {
      if (!armByName.has(name)) {
        throw new SidecarError(`msgUnbound names '${name}', which is not an arm of '${config.msg}'`, facts.msgUnbound!.loc);
      }
    }

    // Channels: the four function channels answer export presence by
    // suffix; the two host-constructed channels and the env map ride the
    // exported-const conventions and must target conforming arms.
    const exports = abiExportSuffixes(profile);
    const exportSet = new Set(exports);
    const namedChannel = (constName: "appearanceMsg" | "chromeMsg"): string | null => {
      const c = facts[constName];
      if (c === null) return null;
      const payload = armByName.get(c.value);
      if (payload === undefined) {
        throw new SidecarError(`${constName} names '${c.value}', which is not an arm of '${config.msg}'`, c.loc);
      }
      if (payload.kind !== "record" && payload.kind !== "union" && payload.kind !== "enum" && payload.kind !== "scalar") {
        throw new SidecarError(
          `${constName} names arm '${c.value}', whose payload descriptor is '${payload.kind}' — a host-constructed channel arm needs a named-type-family payload`,
          c.loc,
        );
      }
      return c.value;
    };
    const envMsgs = facts.envMsgs?.value ?? [];
    const seenEnv = new Set<string>();
    for (const e of envMsgs) {
      if (seenEnv.has(e.env)) {
        throw new SidecarError(`envMsgs repeats environment variable '${e.env}'`, facts.envMsgs!.loc);
      }
      seenEnv.add(e.env);
      const payload = armByName.get(e.msg);
      if (payload === undefined) {
        throw new SidecarError(`envMsgs targets '${e.msg}', which is not an arm of '${config.msg}'`, facts.envMsgs!.loc);
      }
      if (payload.kind !== "bytes") {
        throw new SidecarError(
          `envMsgs targets arm '${e.msg}', whose payload descriptor is '${payload.kind}' — the host delivers an environment value as bytes`,
          facts.envMsgs!.loc,
        );
      }
    }

    // Every declared integer slot must have been spelled by now — the
    // whole contract (model, msg, helpers, channels) is projected.
    projector.checkIntConsumed();
    const intRecordFacts = projector.finishedIntRecordFacts();

    const doc: SidecarDoc = {
      format: SIDECAR_FORMAT,
      wire_version: config.wireVersion,
      abi_version: config.abiVersion,
      compiler_version: input.compilerVersion,
      entry: input.entry,
      source_hash: input.sourceHash,
      build_id: input.buildId,
      types: projector.finishedTable(),
      model: config.model,
      model_helpers: helpers,
      model_unbound: modelUnbound,
      msg: { name: config.msg, arms: msgArms, unbound: msgUnbound },
      init_returns_cmd: initReturnsCmd,
      update_returns_cmd: updateReturnsCmd,
      has_subscriptions: hasSubscriptions,
      channels: {
        command_msg: exportSet.has("command_msg"),
        frame_msg: exportSet.has("frame_msg"),
        key_msg: exportSet.has("key_msg"),
        pinch_msg: exportSet.has("pinch_msg"),
        appearance_msg: namedChannel("appearanceMsg"),
        chrome_msg: namedChannel("chromeMsg"),
        env_msgs: envMsgs,
      },
      abi: { prefix: profile.prefix, exports, snapshot_format: config.snapshotFormat },
      // Ask 4's resolved integer-class decisions, one entry per declared
      // slot in profile declaration order, each recording the DECLARED
      // class ({i64, u64} — the integer_slots vocabulary; only the
      // TypeRef/descriptor spellings above flatten to i64, the frozen
      // format-1 type vocabulary, because unsigned-ness is a
      // boundary-slot refinement, not a type-table concept). The V10
      // bijection with the i64-spelled slots above holds by construction
      // (intify is the only i64 speller and checkIntConsumed just proved
      // every declaration was spelled). The list is an ATTESTATION: the
      // compiler refuses the build before writing any artifact when an
      // integer-slot proof fails, so a sidecar carrying these entries
      // means every listed slot's obligations — including u64's
      // non-negative range — were discharged (§5). Profile-export
      // param/return classes are deliberately ABSENT: integer_slots is
      // the document-side complement (its entries mirror the document's
      // own i64-spelled slots — V10), while an export's class is
      // declared on the profile's exports entry and attested by the
      // artifact's own C signature (int64_t/uint64_t) under the same
      // prove-or-refuse gate; repeating it here would duplicate a fact
      // the ABI already states and break the V10 bijection (abi.exports
      // is a symbol list carrying no TypeRefs).
      integer_slots: config.integerSlots.map((e) => ({ slot: e.slot, class: e.cls })),
      deterministic: input.deterministic,
      // Structural in library mode: the SC4005 gate refused any graph
      // reaching async/timer/event-loop surface before emission, so a
      // sidecar exists only for async_free graphs.
      async_free: true,
    };
    return {
      ok: true,
      doc,
      json: JSON.stringify(doc, null, 2) + "\n",
      integerSlotFacts: { helpers: helperIntFacts, records: intRecordFacts },
    };
  } catch (e) {
    if (e instanceof SidecarRefusal) {
      return { ok: false, diagnostics: [e.diag] };
    }
    if (e instanceof SidecarError) {
      return { ok: false, diagnostics: [libSidecarDiag(e.detail, e.loc)] };
    }
    throw e;
  }
}

/**
 * A semantic-cache hit has already validated/projected the sidecar. Only the
 * exact-source identity fields may change after comment trivia edits; retain
 * the established property order and replace those two values in place.
 */
export function updateSidecarIdentity(
  json: string,
  buildId: string,
  sourceHash: string,
): string {
  const doc = JSON.parse(json) as SidecarDoc;
  doc.source_hash = sourceHash;
  doc.build_id = buildId;
  return JSON.stringify(doc, null, 2) + "\n";
}
