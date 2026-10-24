import { InternalCompilerError } from "../errors.js";
import { keyedHelperName, type KeyedNameOwner } from "./lowering/stable-names.js";
import { mockCallRecordType, mockContextType } from "./mock-shapes.js";
import * as ts from "./ts7/adapter.js";
import { bodyReadsArguments } from "./arguments-usage.js";
import type { IrRecordShape, IrType, IrUnionDef, IrUnionDiscriminant } from "../ir/ir.js";
import {
  BYTES_ELEMENT_NAME,
  arrayOf,
  isDynTypedRefType,
  BOOL,
  bytesOf,
  canConvertToDyn,
  canDynCheckTo,
  CHILD_T,
  CRYPTOHASH_T,
  CRYPTOHMAC_T,
  DATE_T,
  DYN,
  F64,
  funcOf,
  isSupportedArrayElem,
  isSupportedIndexValue,
  isSupportedMapKey,
  isSupportedMapValue,
  isSupportedSetElem,
  iterableArmsElem,
  isUnitType,
  mapOf,
  NULL_T,
  PROCSTREAM_T,
  RUNTIME_EMITTER_CLASS,
  RUNTIME_ERROR_CLASSES,
  RUNTIME_STREAM_CLASSES,
  ZLIB_STREAM_MODES,
  setOf,
  STRING,
  SYMBOL_T,
  typeEquals,
  typeKey,
  maybePromiseUnionArmsOk,
  unionContainerArmsOk,
  UNDEFINED_T,
  VOID,
} from "../ir/ir.js";
import { BIGINT_T, KEY_ORDER_FIELD } from "../ir/ir.js";
import { literalValues } from "./literal-values.js";
import { remapUnionDiscriminant } from "./union-discriminants.js";

import { isJsSourceFile, isNodeTypesPath } from "./program.js";
import { isProvenanceSourceFile } from "./provenance-registry.js";
import { functionCanReturnUndefined } from "./function-completion.js";
import { accessorSlotProp, recordTextCodecClass } from "../ir/ir.js";
// typeKey moved to ir/ir.ts (the backend needs it too, for per-type
// helper interning); re-exported here so frontend call sites keep their
// import path.
export { typeKey };

/** The checker omits the erased receiver parameter from callable arity. */
function runtimeParameterCount(parameters: readonly ts.ParameterDeclaration[]): number {
  const first = parameters[0];
  return (
    parameters.length - (first && ts.isIdentifier(first.name) && first.name.text === "this" ? 1 : 0)
  );
}

/** Empty JS object inference describes no fixed layout. Keep these values
 * in checked storage across fields, parameters and function signatures. */
export function jsOpenObjectType(
  decl: ts.Node | undefined,
  type: IrType,
  shapes: ShapeRegistry,
  unions: UnionRegistry,
): IrType {
  if (!decl || !isJsSourceFile(ts.getSourceFileOfNode(decl))) return type;
  const arms = type.kind === "union" ? unions.get(type.unionId)?.arms : [type];
  const present = arms?.filter((arm) => arm.kind !== "undefinedT");
  const parameter = ts.isParameter(decl)
    ? decl
    : decl.parent && ts.isParameter(decl.parent)
      ? decl.parent
      : null;
  // Array parameters in JavaScript also accept typed arrays. Keep
  // their runtime storage at the boundary, including default [] parameters.
  if (
    parameter &&
    !parameter.dotDotDotToken &&
    present?.length === 1 &&
    present[0]!.kind === "array"
  )
    return DYN;
  if (
    parameter &&
    !parameter.dotDotDotToken &&
    present?.length === 1 &&
    present[0]!.kind === "bytes"
  )
    return DYN;
  // An unannotated JavaScript parameter's object default is a fallback,
  // not a closed class contract. Published code routinely passes another
  // implementation of the same protocol through a boxed callable.
  if (
    parameter?.initializer &&
    !parameter.type &&
    present?.some((arm) => arm.kind === "object") &&
    arms?.every((arm) =>
      canConvertToDyn(
        arm,
        (id) => shapes.get(id),
        (id) => unions.get(id),
      ),
    )
  )
    return DYN;
  if (present?.length !== 1 || present[0]!.kind !== "record") return type;
  const shape = shapes.get(present[0]!.shapeId);
  // JavaScript dictionaries allow missing keys and inherited properties.
  // A typed index slot cannot represent either of those reads faithfully.
  if (shape?.indexValue && !shape.tuple) return DYN;
  const unitOnly = (field: IrType): boolean =>
    isUnitType(field) ||
    field.kind === "void" ||
    (field.kind === "union" && unions.get(field.unionId)?.arms.every(isUnitType) === true);
  return shape &&
    !shape.tuple &&
    !shape.indexValue &&
    (shape.fields.length === 0 || shape.fields.some((field) => unitOnly(field.type)))
    ? DYN
    : type;
}

/** The modules whose RequestOptions interface maps to the checked dynamic. */
const HTTP_REQUEST_OPTION_MODULES: ReadonlySet<string> = new Set([
  "http",
  "node:http",
  "https",
  "node:https",
]);

/** The WebCrypto interfaces whose values are checked-dynamic: the crypto
 * global, SubtleCrypto, CryptoKey handles and the algorithm dictionaries
 * (scr_webcrypto.c). */
export const WEBCRYPTO_DYN_TYPES: ReadonlySet<string> = new Set([
  "Crypto",
  "SubtleCrypto",
  "CryptoKey",
  "Algorithm",
  "KeyAlgorithm",
  "HmacImportParams",
  "HmacKeyAlgorithm",
  "CryptoKeyPair",
  "EcKeyAlgorithm",
  "RsaHashedKeyAlgorithm",
  "EcKeyGenParams",
  "EcKeyImportParams",
  "EcdsaParams",
  "RsaHashedKeyGenParams",
  "RsaHashedImportParams",
  "RsaPssParams",
  "HmacKeyGenParams",
  "AesKeyGenParams",
  "AesKeyAlgorithm",
  "JsonWebKey",
  "AesGcmParams",
  "AesCbcParams",
  "AesCtrParams",
  "Pbkdf2Params",
  "HkdfParams",
  "AesDerivedKeyParams",
]);

/** node:crypto's key and signature option interfaces: the key functions,
 * KeyObject.export and sign/verify take them as checked-dynamic arguments
 * (scr_lib.c, scr_pki.c). */
export const CRYPTO_KEY_OPTION_DYN_TYPES: ReadonlySet<string> = new Set([
  "AsymmetricKeyExportOptions",
  "ECKeyPairKeyObjectOptions",
  "ECKeyPairOptions",
  "ED25519KeyPairOptions",
  "JsonWebKeyInput",
  "JwkKeyExportOptions",
  "KeyExportOptions",
  "PrivateKeyInput",
  "PublicKeyInput",
  "RSAKeyPairKeyObjectOptions",
  "X25519KeyPairOptions",
  "RSAKeyPairOptions",
  "SignKeyObjectInput",
  "SignPrivateKeyInput",
  "SigningOptions",
  "VerifyKeyObjectInput",
  "VerifyPublicKeyInput",
]);

export const FETCH_AMBIENT_TYPES = [
  "Response",
  "Request",
  "ResponseInit",
  "RequestInit",
  "Event",
  "CustomEvent",
  "MessageEvent",
  "EventTarget",
  "AddEventListenerOptions",
  "EventListenerOptions",
  "EventInit",
  "CustomEventInit",
  "AbortController",
  "AbortSignal",
  "Headers",
  "ReadableStream",
  "ReadableStreamDefaultReader",
  "ReadableStreamDefaultController",
  "ReadableStreamReadResult",
  "ReadableStreamReadValueResult",
  "ReadableStreamReadDoneResult",
  "TransformStream",
  "WritableStream",
  "WritableStreamDefaultWriter",
  "Blob",
  "File",
  "BlobPropertyBag",
  "FilePropertyBag",
  "BlobOptions",
  "FileOptions",
] as const;

/** node:crypto's Cipheriv and Decipheriv names in @types/node. */
export const CIPHER_TYPE_NAMES: ReadonlySet<string> = new Set([
  "Cipheriv",
  "Decipheriv",
  "CipherCCM",
  "CipherGCM",
  "CipherOCB",
  "CipherChaCha20Poly1305",
  "DecipherCCM",
  "DecipherGCM",
  "DecipherOCB",
  "DecipherChaCha20Poly1305",
]);

/** node:util.parseArgs's public and @types/node helper type names, plus
 * util.debuglog's DebugLogger (a native function value with an `enabled`
 * accessor) and the DebugLoggerFunction its callback receives. Values
 * behind this surface use the checked-dynamic tree; see mapTypeInner. */
const PARSE_ARGS_DYN_TYPES = new Set([
  "DebugLogger",
  "DebugLoggerFunction",
  "ParseArgsConfig",
  "ParseArgsOptionDescriptor",
  "ParseArgsOptionsConfig",
  "ParseArgsResult",
  "ParseArgsToken",
  "ParsedResults",
  "PreciseParsedResults",
  "ParsedValues",
  "ParsedPositionals",
  "ParsedTokens",
  "ParsedOptionToken",
  "ParsedPositionalToken",
  "PreciseTokenForOptions",
  "TokenForOptions",
  "OptionToken",
  "Token",
]);

/** True for the parseArgs type family that deliberately rides dyn. Exported
 * for the property-read bridge after TypeScript narrows a token union arm. */
export function isParseArgsDynTypeName(name: string): boolean {
  return PARSE_ARGS_DYN_TYPES.has(name);
}

export interface DeclaredOrderPriorityRef {
  rank: readonly number[];
}

export type DeclaredOrderPriority = readonly number[] | DeclaredOrderPriorityRef;

function priorityRank(priority: DeclaredOrderPriority): readonly number[] {
  return Array.isArray(priority) ? priority : (priority as DeclaredOrderPriorityRef).rank;
}

function comparePriority(left: DeclaredOrderPriority, right: DeclaredOrderPriority): number {
  const a = priorityRank(left);
  const b = priorityRank(right);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The frontend's record-shape interner. Records are monomorphic structural
 * shapes: fields sorted by name form the canonical identity, and two types
 * with the same canonical field list share one shapeId (and later one C
 * struct). Owned by the Lowerer; `mapType` needs it to intern the object
 * types it encounters, which is why it is threaded through as a parameter. */
export class ShapeRegistry {
  /** Existing layouts change only when a recursive placeholder closes. */
  revision = 0;
  /** Each shape id with a second hash of its key (keyedHelperName). */
  readonly keyedNameKeys = new Map<string, number>();
  private readonly byKey = new Map<string, string>();
  private readonly byId = new Map<string, IrRecordShape>();
  /** Historical emit-order rank of the declaration-order metadata each
   * shape kept. Collection runs at rank 0; retained reachability bodies
   * install their old emit positions while they lower. This lets a body
   * reached after an init replace metadata the worklist encountered first
   * when the old emitter would have lowered that body first. */
  private readonly declaredOrderPriority = new Map<string, DeclaredOrderPriority>();
  private readonly declaredOrderCandidates = new Map<
    string,
    { order: string[]; priority: DeclaredOrderPriority }[]
  >();
  /** Derived shapes whose order is inherited from another shape. The
   * source can settle after the derived shape was interned (notably
   * Partial<T> inside a retained generic body), so refresh the adopted
   * writer after all priority candidates have closed. */
  private readonly derivedDeclaredOrderFinalizers: (() => void)[] = [];
  private currentDeclaredOrderPriority: DeclaredOrderPriority = [0, 0];
  /** All interned shapes in first-seen order. */
  readonly shapes: IrRecordShape[] = [];
  /** ts.Types currently being mapped — a BACK-REFERENCE to one of these is
   * the recursive knot (`interface TreeNode { children: TreeNode[] }`):
   * mapType answers a NAMED RECURSIVE SHAPE (recursiveRef) whose fields
   * fill in when the outer frame completes. */
  readonly inProgress = new Set<ts.Type>();
  /** RECURSIVE shape ids, keyed by CHECKER TYPE identity: one shapeId per
   * declaration site (the checker canonicalizes interface/alias types per
   * declaration, and caches generic instantiations, so the same spelling
   * is the same ts.Type). Cross-declaration structural unification exists
   * only through the byKey registration finalizeRecursive performs — a
   * one-level unfolding that references the same knot (`{ next: T }` where
   * `type T = { next: T }`) folds into the knot's id; two INDEPENDENT
   * structurally identical recursive declarations intern as distinct
   * shapes, so values of one fence at the other's slots with the ordinary
   * shape-mismatch diagnostic (tsc admits the assignment; the exact-shape
   * stance reports it — the documented v1 width/assignability consequence
   * of per-declaration identity). */
  private readonly recIds = new Map<ts.Type, string>();
  /** Placeholder ids minted but not yet finalized: mid-construction, or
   * permanently pending when the outer mapping failed (such shapes are
   * referenced by nothing reachable and prune at module assembly). */
  private readonly pendingRec = new Set<string>();

  /** The interning key of a canonical field list — shared by intern and
   * finalizeRecursive so the two registration paths can never disagree. */
  private keyOf(
    fields: { name: string; type: IrType }[],
    tuple: boolean,
    indexValue?: IrType,
  ): string {
    return (
      (tuple ? "tuple!" : "") +
      (indexValue ? `idx<${typeKey(indexValue)}>!` : "") +
      JSON.stringify(fields.map((f) => [f.name, typeKey(f.type)]))
    );
  }

  /** Runs one lowering unit under its historical emit-order rank. Shape
   * ids remain demand-assigned; only first-seen declaration-order metadata
   * uses this rank, because Object.keys/JSON/inspect observe it. */
  withDeclaredOrderPriority<T>(priority: DeclaredOrderPriority, fn: () => T): T {
    const previous = this.currentDeclaredOrderPriority;
    this.currentDeclaredOrderPriority = priority;
    try {
      return fn();
    } finally {
      this.currentDeclaredOrderPriority = previous;
    }
  }

  private adoptDeclaredOrder(shape: IrRecordShape, declaredOrder: string[] | undefined): void {
    if (declaredOrder === undefined) return;
    const candidates = this.declaredOrderCandidates.get(shape.id);
    const candidate = { order: declaredOrder, priority: this.currentDeclaredOrderPriority };
    if (candidates) candidates.push(candidate);
    else this.declaredOrderCandidates.set(shape.id, [candidate]);
    const previous = this.declaredOrderPriority.get(shape.id);
    if (
      previous !== undefined &&
      comparePriority(previous, this.currentDeclaredOrderPriority) <= 0
    ) {
      return;
    }
    shape.declaredOrder = this.withExtendedNames(shape.id, declaredOrder);
    this.declaredOrderPriority.set(shape.id, this.currentDeclaredOrderPriority);
  }

  /** Mutable generic-instance ranks settle only after reachability closes.
   * Re-choose each shape's first historical writer from the retained
   * candidates before derived metadata and helper bodies finalize. */
  settleDeclaredOrderPriorities(): void {
    for (const [shapeId, candidates] of this.declaredOrderCandidates) {
      let best = candidates[0];
      if (!best) continue;
      for (const candidate of candidates.slice(1)) {
        if (comparePriority(candidate.priority, best.priority) < 0) best = candidate;
      }
      const shape = this.byId.get(shapeId);
      if (!shape) continue;
      shape.declaredOrder = this.withExtendedNames(shapeId, best.order);
      this.declaredOrderPriority.set(shapeId, best.priority);
    }
    for (const finalize of this.derivedDeclaredOrderFinalizers) finalize();
  }

  /** Tracks a derived shape that inherits its key order unchanged from a
   * source shape. Identity-gating preserves first-writer-wins when an
   * equivalent derived shape was already adopted from another source. */
  inheritDeclaredOrder(shapeId: string, originalOrder: string[], sourceShapeId: string): void {
    this.derivedDeclaredOrderFinalizers.push(
      this.declaredOrderFinalizer(
        shapeId,
        originalOrder,
        () => this.get(sourceShapeId)?.declaredOrder,
      ),
    );
  }

  /** Captures the current historical rank for a derived shape whose order
   * must be recomputed after retained reachability settles its source. */
  declaredOrderFinalizer(
    shapeId: string,
    originalOrder: string[],
    order: () => string[] | undefined,
  ): () => void {
    return () => {
      const shape = this.byId.get(shapeId);
      // Only the writer whose array the shape actually adopted may revise
      // it. Another structurally-equal type at the same historical rank
      // still obeys first-writer-wins.
      if (shape?.declaredOrder !== originalOrder) return;
      const next = order();
      if (next !== undefined) shape.declaredOrder = this.withExtendedNames(shape.id, next);
    };
  }

  /** The shape id a back-reference to an in-progress type resolves to:
   * reuses the type's persistent recursive id or mints a PLACEHOLDER
   * entry (empty fields) the outer frame finalizes. `describe` names a new
   * placeholder (checkerTypeDescription). */
  recursiveRef(t: ts.Type, describe: () => string): string {
    let id = this.recIds.get(t);
    if (id === undefined) {
      id = recursivePlaceholderName(this, "r", describe(), (name) => this.byId.has(name));
      const shape: IrRecordShape = { id, fields: [] };
      this.byId.set(id, shape);
      this.shapes.push(shape);
      this.recIds.set(t, id);
      this.pendingRec.add(id);
    }
    return id;
  }

  /** The FINALIZED recursive shape for a checker type — undefined while
   * never mapped, mid-construction, or permanently failed. */
  recursiveShapeFor(t: ts.Type): string | undefined {
    const id = this.recIds.get(t);
    return id !== undefined && !this.pendingRec.has(id) ? id : undefined;
  }

  /** True when a back-reference minted a placeholder for `t` that the
   * outer frame has not (yet) finalized. */
  recursivePending(t: ts.Type): boolean {
    const id = this.recIds.get(t);
    return id !== undefined && this.pendingRec.has(id);
  }

  /** Completes a recursive placeholder with its computed field list and
   * registers the structural key (first writer wins — the key may already
   * belong to a structurally identical shape; the recursive id stays
   * authoritative for its own checker type either way). */
  finalizeRecursive(
    t: ts.Type,
    fields: { name: string; type: IrType }[],
    indexValue?: IrType,
    declaredOrder?: string[],
  ): string {
    const id = this.recIds.get(t);
    if (id === undefined)
      throw new InternalCompilerError(
        "shape registry bug: finalizeRecursive without a placeholder",
      );
    if (this.pendingRec.has(id)) {
      const shape = this.byId.get(id)!;
      shape.fields = fields;
      if (indexValue) shape.indexValue = indexValue;
      this.adoptDeclaredOrder(shape, declaredOrder);
      this.pendingRec.delete(id);
      this.revision++;
      const key = this.keyOf(fields, false, indexValue);
      if (!this.byKey.has(key)) this.byKey.set(key, id);
    }
    return id;
  }

  /** Interns a canonical (name-sorted) field list, returning its shapeId.
   * `tuple` shapes (fields "0".."n-1" from a tuple type) intern SEPARATELY
   * from structurally identical numeric-keyed object records: the flag is
   * part of the identity because the two serialize differently (a tuple is
   * a JSON array, an object a JSON object). A string index signature's
   * value type (`indexValue`) is part of the identity too: the same
   * declared fields with and without an overflow portion — or with
   * differently-typed ones — are different structs. */
  intern(
    fields: { name: string; type: IrType }[],
    tuple = false,
    indexValue?: IrType,
    declaredOrder?: string[],
  ): string {
    const key = this.keyOf(fields, tuple, indexValue);
    let id = this.byKey.get(key);
    if (id === undefined) {
      id = keyedHelperName(this, "r", key, "");
      const shape: IrRecordShape = {
        id,
        fields,
        ...(tuple ? { tuple: true as const } : {}),
        ...(indexValue ? { indexValue } : {}),
        // First-seen declaration order — metadata, NOT identity (see the
        // IrRecordShape doc): a later structurally-equal type keeps the
        // first one's order.
        ...(declaredOrder ? { declaredOrder } : {}),
      };
      this.byKey.set(key, id);
      this.byId.set(id, shape);
      this.shapes.push(shape);
      if (declaredOrder !== undefined) {
        this.declaredOrderCandidates.set(id, [
          { order: declaredOrder, priority: this.currentDeclaredOrderPriority },
        ]);
        this.declaredOrderPriority.set(id, this.currentDeclaredOrderPriority);
      }
    } else {
      this.adoptDeclaredOrder(this.byId.get(id)!, declaredOrder);
    }
    return id;
  }

  get(shapeId: string): IrRecordShape | undefined {
    return this.byId.get(shapeId);
  }

  /** Names extendShape added to a shape, which every key-order table the
   * shape adopts lists after its declared names. */
  private readonly extendedNames = new Map<string, string[]>();

  /** The members extendShape attached to a shape (empty for most). */
  attachedNames(shapeId: string): readonly string[] {
    return this.extendedNames.get(shapeId) ?? [];
  }

  private withExtendedNames(shapeId: string, order: string[]): string[] {
    const extra = this.extendedNames.get(shapeId);
    if (!extra) return order;
    const missing = extra.filter((name) => !order.includes(name));
    return missing.length === 0 ? order : [...order, ...missing];
  }

  /** Gives a shape with orderVariants its KEY_ORDER_FIELD, in place,
   * after the bodies lowered (key-order-witness.ts adds the field to each
   * of the shape's literals). Allocation zeroes it, which every other
   * construction keeps. */
  addKeyOrderField(shapeId: string): void {
    const shape = this.byId.get(shapeId);
    if (!shape || shape.fields.some((f) => f.name === KEY_ORDER_FIELD)) return;
    shape.fields = [...shape.fields, { name: KEY_ORDER_FIELD, type: F64 }].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    this.revision++;
    const key = this.keyOf(shape.fields, false, shape.indexValue);
    if (!this.byKey.has(key)) this.byKey.set(key, shapeId);
  }

  /** Adds optional fields to an interned shape in place: members a type
   * assertion attaches to the shape's values (`r as R & { tag: string }`
   * followed by `view.tag = ...`; see assertion-members.ts). Every value
   * of the shape holds them absent until a write through such a view, so
   * the shape keeps its id, both structural keys resolve to it, and its
   * key-order table lists the new names after the declared ones. Runs
   * before any body lowers; existing layouts change, so the revision
   * advances like a closing recursive placeholder. */
  extendShape(shapeId: string, extra: readonly { name: string; type: IrType }[]): void {
    const shape = this.byId.get(shapeId);
    if (!shape || shape.tuple || extra.length === 0) return;
    const fresh = extra.filter((f) => !shape.fields.some((x) => x.name === f.name));
    if (fresh.length === 0) return;
    shape.fields = [...shape.fields, ...fresh].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    this.extendedNames.set(shapeId, [
      ...(this.extendedNames.get(shapeId) ?? []),
      ...fresh.map((f) => f.name),
    ]);
    if (shape.declaredOrder)
      shape.declaredOrder = this.withExtendedNames(shapeId, shape.declaredOrder);
    const candidates = this.declaredOrderCandidates.get(shapeId);
    if (candidates) {
      for (const c of candidates) c.order = this.withExtendedNames(shapeId, c.order);
    }
    this.revision++;
    const key = this.keyOf(shape.fields, false, shape.indexValue);
    if (!this.byKey.has(key)) this.byKey.set(key, shapeId);
  }
}

/** The id of a recursive placeholder described by `description`. Two
 * different types can still share a description (checkerTypeDescription stops
 * after a few levels of type arguments); the later one takes the first free
 * name with a numbered suffix. */
function recursivePlaceholderName(
  owner: KeyedNameOwner,
  prefix: string,
  description: string,
  taken: (name: string) => boolean,
): string {
  let name = keyedHelperName(owner, prefix, `recursive:${description}`, "");
  for (let n = 1; taken(name); n++)
    name = keyedHelperName(owner, prefix, `recursive:${description}#${n}`, "");
  return name;
}

/** How many levels of type arguments checkerTypeDescription describes. */
const RECURSIVE_NAME_DEPTH = 3;

/** A checker type's description for names that must not depend on checker
 * type ids (a recursive placeholder, a generic class instance keyed by a
 * literal): its printed form, the structural position of its first
 * declaration, and the same for its type arguments (two instantiations
 * print the same when their type arguments are type parameters or classes
 * of the same name from different declarations). */
export function checkerTypeDescription(
  t: ts.Type,
  ctx: Pick<TypeMapperCtx, "checker" | "positionOf">,
  depth = 0,
): string {
  const symbol = t.getAliasSymbol() ?? t.getSymbol();
  const declaration = symbol?.declarations[0];
  const where = declaration
    ? (ctx.positionOf?.(declaration) ??
      `${ts.getSourceFileOfNode(declaration).fileName}:${declaration.pos}`)
    : "";
  let description = `${ctx.checker.typeToString(t)}@${where}`;
  if (depth < RECURSIVE_NAME_DEPTH) {
    const aliasArguments =
      t.getAliasSymbol() !== undefined ? (t.getAliasTypeArguments() ?? []) : [];
    const typeArguments =
      aliasArguments.length > 0
        ? aliasArguments
        : t.isTypeReference()
          ? ctx.checker.getTypeArguments(t)
          : [];
    if (typeArguments.length > 0)
      description += `<${typeArguments.map((arg) => checkerTypeDescription(arg, ctx, depth + 1)).join(",")}>`;
  }
  return description;
}

/** The frontend's union interner — mirrors ShapeRegistry. A union's
 * canonical identity includes its typeKey-sorted arms and literal
 * discriminator contract. An arm's index in that list IS its runtime tag.
 * Owned by the Lowerer; threaded through mapType like ShapeRegistry. */
export class UnionRegistry {
  /** Existing arm/discriminator contracts change when a placeholder closes. */
  revision = 0;
  /** Each union id with a second hash of its key (keyedHelperName). */
  readonly keyedNameKeys = new Map<string, number>();
  private readonly byKey = new Map<string, string>();
  private readonly byId = new Map<string, IrUnionDef>();
  private readonly armTags = new Map<string, Map<string, number[]>>();
  /** All interned unions in first-seen order. */
  readonly unions: IrUnionDef[] = [];
  /** ts.Types currently being mapped — a back-reference to one is the
   * recursive knot passing through a union (`type Tree = Leaf | Branch`
   * whose Branch arm carries `Tree[]`, the optional field `a?: A` of a
   * mutually recursive pair): mapType answers a NAMED RECURSIVE UNION
   * (recursiveRef) whose arms fill in when the outer frame completes. */
  readonly inProgress = new Set<ts.Type>();
  /** Recursive union ids, keyed by checker type identity — the
   * ShapeRegistry.recIds story exactly (per-declaration identity, byKey
   * folding one-level unfoldings in). */
  private readonly recIds = new Map<ts.Type, string>();
  private readonly pendingRec = new Set<string>();

  /** The union id a back-reference to an in-progress union resolves to:
   * reuses the type's persistent recursive id or mints a PLACEHOLDER
   * entry (empty arms) the outer frame finalizes. `describe` names a new
   * placeholder (checkerTypeDescription). */
  recursiveRef(t: ts.Type, describe: () => string): string {
    let id = this.recIds.get(t);
    if (id === undefined) {
      id = recursivePlaceholderName(this, "u", describe(), (name) => this.byId.has(name));
      const def: IrUnionDef = { id, arms: [] };
      this.byId.set(id, def);
      this.unions.push(def);
      this.recIds.set(t, id);
      this.pendingRec.add(id);
    }
    return id;
  }

  /** The FINALIZED recursive union for a checker type — undefined while
   * never mapped, mid-construction, or permanently failed. */
  recursiveUnionFor(t: ts.Type): string | undefined {
    const id = this.recIds.get(t);
    return id !== undefined && !this.pendingRec.has(id) ? id : undefined;
  }

  /** True when a back-reference minted a placeholder for `t` that the
   * outer frame has not (yet) finalized. */
  recursivePending(t: ts.Type): boolean {
    const id = this.recIds.get(t);
    return id !== undefined && this.pendingRec.has(id);
  }

  /** Completes a recursive placeholder with its canonical arm list and
   * registers the structural key (first writer wins, like shapes). */
  finalizeRecursive(t: ts.Type, arms: IrType[], discriminant?: IrUnionDiscriminant): string {
    const id = this.recIds.get(t);
    if (id === undefined)
      throw new InternalCompilerError(
        "union registry bug: finalizeRecursive without a placeholder",
      );
    if (this.pendingRec.has(id)) {
      const def = this.byId.get(id)!;
      def.arms.push(...arms);
      if (discriminant) def.discriminant = discriminant;
      this.pendingRec.delete(id);
      this.armTags.delete(id);
      this.revision++;
      const key = JSON.stringify([arms.map(typeKey), discriminant]);
      if (!this.byKey.has(key)) this.byKey.set(key, id);
    }
    return id;
  }

  /** Interns canonical arms and discriminator cases, returning their unionId. */
  intern(arms: IrType[], discriminant?: IrUnionDiscriminant): string {
    const key = JSON.stringify([arms.map(typeKey), discriminant]);
    let id = this.byKey.get(key);
    if (id === undefined) {
      id = keyedHelperName(this, "u", key, "");
      const def: IrUnionDef = { id, arms, ...(discriminant ? { discriminant } : {}) };
      this.byKey.set(key, id);
      this.byId.set(id, def);
      this.unions.push(def);
    }
    return id;
  }

  /** An exact arm transformation keeps the source's semantic variants. */
  transform(source: IrUnionDef, arms: IrType[]): string {
    return this.intern(arms, remapUnionDiscriminant(source, arms));
  }

  get(unionId: string): IrUnionDef | undefined {
    return this.byId.get(unionId);
  }

  /** Index large arm lists once. Exact equality still resolves type-key
   * collisions, including optional function ABI flags. */
  armTag(unionId: string, arm: IrType): number {
    const def = this.byId.get(unionId);
    if (!def) return -1;
    if (def.arms.length < 8) return def.arms.findIndex((candidate) => typeEquals(candidate, arm));
    let tags = this.armTags.get(unionId);
    if (!tags) {
      tags = new Map<string, number[]>();
      def.arms.forEach((candidate, tag) => {
        const key = typeKey(candidate);
        const previous = tags!.get(key);
        if (previous) previous.push(tag);
        else tags!.set(key, [tag]);
      });
      this.armTags.set(unionId, tags);
    }
    return tags.get(typeKey(arm))?.find((tag) => typeEquals(def.arms[tag]!, arm)) ?? -1;
  }
}

/** Human-readable rendering of an IrType for diagnostics (records expand to
 * their canonical field list, unions to their arms; `checker.typeToString`
 * can't — it never sees IR types). Bound the traversal as well as its output:
 * cycle detection alone still expands a shared acyclic graph exponentially.
 * The same budget covers every sibling, and deep wrapper chains truncate
 * before exhausting the JS stack. Small types retain their full spelling. */
export function formatIrType(
  t: IrType,
  shapes: ShapeRegistry,
  unions: UnionRegistry,
  seen: Set<string> = new Set(),
): string {
  const maxLength = 4096;
  const maxDepth = 32;
  let output = "";
  let truncated = false;
  const append = (text: string): void => {
    if (truncated) return;
    // Reserve the marker so a full buffer can always report truncation.
    const remaining = maxLength - 3 - output.length;
    if (text.length > remaining) {
      output += text.slice(0, remaining) + "...";
      truncated = true;
    } else {
      output += text;
    }
  };
  const list = (types: readonly IrType[], separator: string, depth: number): void => {
    for (let i = 0; i < types.length && !truncated; i++) {
      if (i > 0) append(separator);
      visit(types[i]!, depth);
    }
  };
  const visit = (t: IrType, depth: number): void => {
    if (truncated) return;
    if (depth >= maxDepth) return append("...");
    const child = (type: IrType): void => visit(type, depth + 1);
    switch (t.kind) {
      case "f64":
        return append("number");
      case "string":
        return append("string");
      case "bool":
        return append("boolean");
      case "dyn":
      case "jsval":
        return append("unknown");
      case "caught":
        // What tsc calls the binding; the fence messages carry the real story.
        return append("unknown");
      case "void":
        return append("void");
      case "undefinedT":
        return append("undefined");
      case "nullT":
        return append("null");
      case "array": {
        // Union/func elements need the parens TS syntax would ("(number |
        // string)[]" — without them the [] reads as binding to the last arm).
        const parens = t.elem.kind === "union" || t.elem.kind === "func";
        if (parens) append("(");
        child(t.elem);
        return append(parens ? ")[]" : "[]");
      }
      case "bytes":
        // The u8 kind reads as Uint8Array (Buffer maps here too — one
        // runtime representation; the message stays honest either way).
        return append(BYTES_ELEMENT_NAME[t.elem]);
      case "map":
        append("Map<");
        child(t.key);
        append(", ");
        child(t.value);
        return append(">");
      case "set":
        append("Set<");
        child(t.elem);
        return append(">");
      case "func":
        append("(");
        list(t.params, ", ", depth + 1);
        append(") => ");
        return child(t.ret);
      case "object":
        // Runtime-provided error classes carry '%'-prefixed IR names
        // ("%Error") so user classes can never collide; diagnostics show the
        // source-level name.
        return append(t.className.startsWith("%") ? t.className.slice(1) : t.className);
      case "classval":
        // The static side, in TS's own spelling.
        append("typeof ");
        return append(t.className.startsWith("%") ? t.className.slice(1) : t.className);
      case "record": {
        const shape = shapes.get(t.shapeId);
        if (!shape) return append(`{ /* unknown shape ${t.shapeId} */ }`);
        const codec = recordTextCodecClass(shape);
        if (codec !== null) return append(codec);
        if (seen.has(t.shapeId)) return append("..."); // the recursive knot
        seen.add(t.shapeId);
        try {
          if (shape.tuple) {
            const byIndex = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
            append("[");
            for (let i = 0; i < byIndex.length && !truncated; i++) {
              if (i > 0) append(", ");
              child(byIndex[i]!.type);
            }
            return append("]");
          }
          if (shape.fields.length === 0 && !shape.indexValue) return append("{}");
          append("{ ");
          for (let i = 0; i < shape.fields.length && !truncated; i++) {
            if (i > 0) append("; ");
            const f = shape.fields[i]!;
            // Accessor slots print in TS's accessor spelling, not the
            // reserved '%'-field encoding.
            const slot = accessorSlotProp(f.name);
            if (slot && f.type.kind === "func") {
              append(slot.kind === "get" ? "get " : "set ");
              append(slot.prop);
              if (slot.kind === "get") {
                append("(): ");
                child(f.type.ret);
              } else {
                append("(");
                child(f.type.params[0] ?? VOID);
                append(")");
              }
            } else {
              append(f.name);
              append(": ");
              child(f.type);
            }
          }
          if (shape.indexValue) {
            if (shape.fields.length > 0) append("; ");
            append("[key: string]: ");
            child(shape.indexValue);
          }
          return append(" }");
        } finally {
          seen.delete(t.shapeId); // sibling occurrences still expand
        }
      }
      case "union": {
        const def = unions.get(t.unionId);
        if (!def) return append(`/* union ${t.unionId} */`);
        if (seen.has(t.unionId)) return append("..."); // the recursive knot
        seen.add(t.unionId);
        try {
          return list(def.arms, " | ", depth + 1);
        } finally {
          seen.delete(t.unionId);
        }
      }
      case "regex":
        return append("RegExp");
      case "date":
        return append("Date");
      case "url":
        return append("URL");
      case "searchParams":
        return append("URLSearchParams");
      case "symbol":
        return append("symbol");
      case "bigint":
        return append("bigint");
      case "stats":
        return append("Stats");
      case "fileHandle":
        return append("FileHandle");
      case "dir":
        return append("Dir");
      case "spawnRes":
        return append("SpawnSyncReturns");
      case "child":
        return append("ChildProcess");
      case "netServer":
        return append("Server");
      case "netSocket":
        return append("Socket");
      case "http2Session":
        return append("Http2Session");
      case "http2Stream":
        return append("Http2Stream");
      case "dgramSocket":
        return append("dgram.Socket");
      case "testCtx":
        return append("TestContext");
      case "httpReq":
        return append("IncomingMessage");
      case "httpRes":
        return append("ServerResponse");
      case "httpClientReq":
        return append("ClientRequest");
      case "secureCtx":
        return append("SecureContext");
      case "cryptoHash":
        return append("Hash");
      case "cryptoHmac":
        return append("Hmac");
      case "fsWatcher":
        return append("FSWatcher");
      case "childStream":
        return append("Readable");
      case "childWriter":
        return append("Writable");
      case "procStream":
        return append("WriteStream");
      case "moduleNs":
        append("module namespace '");
        append(t.moduleId);
        return append("'");
      case "promise":
        append("Promise<");
        child(t.inner);
        return append(">");
      case "generator":
        append(t.async ? "AsyncGenerator<" : "Generator<");
        list([t.yieldT, t.retT, t.nextT], ", ", depth + 1);
        return append(">");
      default: {
        const _exhaustive: never = t;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  };
  visit(t, 0);
  return output;
}

/** True when the declaration sits inside `declare module "<name>"` (or
 * its node:-prefixed twin) — the disambiguator for builtin-module type
 * names that repeat across modules (net.Server vs http.Server). Both
 * @types/node and the shipped fallback declare builtins this way. */
/** ES OrdinaryOwnPropertyKeys order over string keys: canonical array
 * indices (the exact string spelling of an integer in [0, 2^32-1)) come
 * first in ascending numeric order, everything else follows in the given
 * (insertion/declaration) order. This is JS's enumeration order for the
 * objects records model — Object.keys, JSON.stringify, spread, inspect. */
function esOwnKeyOrder(names: string[]): string[] {
  const isArrayIndex = (name: string): boolean => {
    const n = Number(name);
    return Number.isInteger(n) && n >= 0 && n < 4294967295 && String(n) === name;
  };
  const indices = names.filter(isArrayIndex).sort((a, b) => Number(a) - Number(b));
  return indices.length === 0 ? names : [...indices, ...names.filter((n) => !isArrayIndex(n))];
}

/** The hidden field that marks the perf_hooks entry record shape. */
export const PERF_ENTRY_MARKER = "%perfEntry";

/** PerformanceEntry's toJSON fields, in toJSON's order. */
export const PERF_ENTRY_FIELDS = ["name", "entryType", "startTime", "duration", "detail"];

/** The record shape behind PerformanceEntry, PerformanceMark and
 * PerformanceMeasure values (see mapType). The marker is an always-absent
 * optional, so dyn conversions and key walks never see it. */
export function perfEntryShape(shapes: ShapeRegistry, unions: UnionRegistry): string {
  return shapes.intern(
    [
      { name: PERF_ENTRY_MARKER, type: withUndefinedArm(F64, unions)! },
      { name: "detail", type: DYN },
      { name: "duration", type: F64 },
      { name: "entryType", type: STRING },
      { name: "name", type: STRING },
      { name: "startTime", type: F64 },
    ],
    false,
    undefined,
    PERF_ENTRY_FIELDS,
  );
}

/** The `{ stdout, stderr }` record a promisified exec/execFile call
 * fulfills with (see mapType), in Node's key order. */
export function execResultShape(shapes: ShapeRegistry): string {
  return shapes.intern(
    [
      { name: "stderr", type: STRING },
      { name: "stdout", type: STRING },
    ],
    false,
    undefined,
    ["stdout", "stderr"],
  );
}

/** toJSON()'s plain object over an entry: the same fields without the
 * marker. */
export function perfEntryJsonShape(shapes: ShapeRegistry): string {
  return shapes.intern(
    [
      { name: "detail", type: DYN },
      { name: "duration", type: F64 },
      { name: "entryType", type: STRING },
      { name: "name", type: STRING },
      { name: "startTime", type: F64 },
    ],
    false,
    undefined,
    PERF_ENTRY_FIELDS,
  );
}

function isDeclaredInAmbientModule(d: ts.Declaration, name: string): boolean {
  let node: ts.Node | undefined = d.parent;
  while (node) {
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      const spec = node.name.text;
      return spec === name || spec === `node:${name}`;
    }
    node = node.parent;
  }
  return false;
}

/** True when the declaration's nearest enclosing namespace is `name`
 * (`declare global { namespace NodeJS { ... } }` — the NodeJS-global
 * interfaces @types/node declares outside any ambient module). */
export function isDeclaredInAmbientNamespace(d: ts.Declaration, name: string): boolean {
  let node: ts.Node | undefined = d.parent;
  while (node) {
    if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      return node.name.text === name;
    }
    node = node.parent;
  }
  return false;
}

/** Whether `type` is one of the stream spellings the general stream
 * representation (TypeMapperCtx.generalNodeStreams) maps differently:
 * NodeJS.ReadableStream / NodeJS.WritableStream, @types/node's
 * stream.Readable / stream.Writable, or the fallback declarations'
 * ChildStdin. */
export function isGeneralNodeStreamInterface(
  type: ts.Type,
  ctx: Pick<TypeMapperCtx, "isStdlibFile">,
): boolean {
  const psym = type.getSymbol() ?? type.getAliasSymbol();
  if (psym === undefined) return false;
  return psym.declarations.some((d) => {
    if (!(ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d))) return false;
    if (!ctx.isStdlibFile(ts.getSourceFileOfNode(d))) return false;
    if (ts.symbolName(psym) === "ReadableStream" || ts.symbolName(psym) === "WritableStream")
      return ts.isInterfaceDeclaration(d) && isDeclaredInAmbientNamespace(d, "NodeJS");
    if (ts.symbolName(psym) === "ChildStdin") return isDeclaredInAmbientModule(d, "child_process");
    return (
      (ts.symbolName(psym) === "Readable" || ts.symbolName(psym) === "Writable") &&
      isNodeTypesPath(ts.getSourceFileOfNode(d).fileName) &&
      isDeclaredInAmbientModule(d, "stream")
    );
  });
}

/** A type declared in the shipped WebAssembly namespace (scriptc.d.ts):
 * its modules, instances, memories, tables, globals, error classes and the
 * Exports/Imports records. */
export function isWebAssemblyType(
  type: ts.Type,
  ctx: Pick<TypeMapperCtx, "checker" | "isStdlibFile">,
): boolean {
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  if (!symbol) return false;
  return symbol.declarations.some(
    (d) =>
      ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
      isDeclaredInAmbientNamespace(d as ts.Declaration, "WebAssembly"),
  );
}

/** True when a type contains a record anywhere (the trigger for the
 * shape-mismatch diagnostic SC2002 — non-record mismatches are tsc's or
 * the validator's business). */
export function containsRecord(t: IrType): boolean {
  switch (t.kind) {
    case "record":
      return true;
    case "array":
      return containsRecord(t.elem);
    case "func":
      return t.params.some(containsRecord) || containsRecord(t.ret);
    default:
      // Unions deliberately return false: a union-involving mismatch has its
      // own diagnostic (SC2003 via containsUnion), not the record one.
      return false;
  }
}

/** True when a type contains a union anywhere reachable without a registry
 * (the trigger for the union-mismatch diagnostic SC2003 — e.g. a value
 * narrowed to a SUB-union flowing into the full union's slot, which would
 * need a runtime re-tag). */
export function containsUnion(t: IrType): boolean {
  switch (t.kind) {
    case "union":
      return true;
    case "array":
      return containsUnion(t.elem);
    case "func":
      return t.params.some(containsUnion) || containsUnion(t.ret);
    default:
      return false;
  }
}

/** ts.Type → IrType. Returns null for anything outside the supported
 * surface; the caller (badType) classifies the shape and reports the
 * matching type fence — SC2005 generic signatures, SC2006 index
 * signatures, SC2007 overloads, SC2008 intersections, SC2009 component
 * fences, SC2020 library types, SC2001 for the remainder — with
 * checker.typeToString.
 *
 * Literal types are widened FIRST (`const x = 1` has type `1`, `true` has
 * type `true`; internally `boolean` is the union `true | false`) — mapping
 * without widening is the classic bug this function exists to centralize.
 *
 * `ctx.shapes` is the Lowerer's shape registry: object types over data
 * properties intern their canonical shape there and map to
 * `{ kind: "record", shapeId }`.
 */
/** Computes the program-wide IR name for a class declaration. Injected by
 * the Lowerer so type mapping and lowering agree on qualified names in
 * multi-file programs (two files may each declare `class Point`). */
export type ClassNamer = (decl: ts.ClassLikeDeclaration) => string;

/** Resolves a type-parameter ts.Type to a concrete IR type, or null when it
 * isn't one / isn't bound. Injected by the Lowerer while it instantiates a
 * generic function body (monomorphization): inside the body the checker
 * reports the UNSUBSTITUTED types (`T`, `T[]`, `{ v: T }`), so the
 * substitution has to happen inside mapType's recursion — carried by the
 * TypeMapperCtx exactly like ClassNamer. */
export type TypeParamResolver = (t: ts.Type) => IrType | null;

/** Resolves a type-parameter ts.Type to the CHECKER type it is bound to in
 * the current instantiation, or null. The ts-level twin of
 * TypeParamResolver, needed where the IR type has already lost information
 * mapType's widening discipline drops: `T[K]` inside a generic body resolves
 * through the BOUND checker types (K's literal names the property), which no
 * IrType binding can carry. */
export type TypeParamTsResolver = (t: ts.Type) => ts.Type | null;

/** Everything mapType needs besides the type itself: the checker, the two
 * interners (owned by the Lowerer), and the Lowerer-injected hooks. Built
 * once per Lowerer and threaded through the recursion — adding a hook means
 * one new field here, not a new parameter at every call site. */
export interface TypeMapperCtx {
  /** Set only while a union maps an arm that is the type inferred from an
   * empty object literal, beside another non-nullish arm: that arm holds
   * only the literal's objects, so it maps to the empty record (see the
   * empty object type rule in the object mapping). */
  emptyLiteralArm?: boolean;
  /** The class value a generic factory's result type names when the factory
   * returns one of its own local classes through a constructor type
   * (`function struct<S>(v: S): Struct<S> { class Base {}; return Base as
   * Struct<S>; }`), by the checker type: the declared result inside the
   * instance being lowered, the instantiated result at its calls. */
  localClassValue?: (type: ts.Type) => IrType | null;
  checker: ts.TypeChecker;
  /** The structural position of a declaration (structural-positions.ts),
   * which names recursive placeholders independently of where unrelated
   * code sits. The Lowerer supplies it. */
  positionOf?: (node: ts.Node) => string;
  /** JavaScript declarations whose instance or object-literal types only
   * the checked-dynamic representation holds (js-dynamic-objects.ts).
   * Absent when the program has none: every mapping is unchanged. */
  jsDynamicDeclaration?: (decl: ts.Node) => boolean;
  /** Set while mapping a generic callable member's erased type
   * (erasedGenericMemberType): the signature's own type parameters
   * resolve to `unknown` instead of refusing the mapping. */
  erasingSignature?: ts.Signature;
  /** True while an erased generic body lowers (its type parameters are
   * bound to `unknown`). */
  isErasing?: () => boolean;
  shapes: ShapeRegistry;
  unions: UnionRegistry;
  classNamer: ClassNamer;
  resolveTypeParam?: TypeParamResolver;
  /** The ts-level twin of resolveTypeParam (bound CHECKER types), consulted
   * only where literal identity matters — indexed accesses (`T[K]`) inside
   * generic bodies whose K is bound to a literal key. */
  resolveTypeParamTs?: TypeParamTsResolver;
  /** GENERIC program classes (monomorphization by flow): the mapping of a
   * concrete instantiation reference (`Box<number>`) — the Lowerer
   * registers/reuses the instantiation (`Box%0`) and answers its object
   * type; null when a type argument doesn't map, the cap tripped, or the
   * family never collected. The argument mapper retains substitutions from
   * class-derived interfaces as well as the current function bindings.
   * Absent in checkers with no lowering attached (generic instance types
   * stay unmapped there). */
  genericClassInstance?: (
    decl: ts.ClassLikeDeclaration,
    typeRef: ts.Type,
    mapArgument: (type: ts.Type) => IrType | null,
  ) => IrType | null;
  /** MIXIN class nodes (the class inside a mixin function): one shared
   * AST node, one instantiation per call site — the node's instance type
   * resolves to the instantiation CURRENTLY collecting/lowering (`this`
   * inside members, self-referential member types), null outside any
   * mixin context (the type alone cannot name a call site). */
  mixinClassInstance?: (decl: ts.ClassLikeDeclaration) => IrType | null;
  localClassInstance?: (decl: ts.ClassLikeDeclaration, instanceType?: ts.Type) => IrType | null;
  /** The runtime-provided class whose static side a type is (`typeof
   * EventEmitter`, `ErrorConstructor`), when values of it construct. */
  runtimeClassValue?: (type: ts.Type) => string | null;
  /** Live class protocols retain identity and receiver dispatch rather than
   * copying an instance into an unrelated record layout. */
  classImplementedProtocol?: (type: ts.Type) => boolean;
  /** MIXIN instance INTERSECTIONS (`Tagged.C & Derived` — values built
   * through a mixin result): resolved by chain structure to the unique
   * pinned instantiation they describe; null when ambiguous or when no
   * part names a mixin class node (lower-mixins.ts). */
  mixinIntersectionInstance?: (widened: ts.Type) => IrType | null;
  /** True for the STANDARD LIBRARY's files — the shipped ambient .d.ts or a
   * lib.*.d.ts bundled with typescript (program.isSourceFileDefaultLibrary).
   * Map/RegExp/Promise recognition needs declaration provenance: the name
   * alone proves nothing (a user's own `interface Map` maps as a record). */
  isStdlibFile: (sf: ts.SourceFile) => boolean;

  isNpmFile: (sf: ts.SourceFile) => boolean;
  /** True for a declaration file explicitly mapped by coverage's
   * --external-types option. These declarations are trusted as structural
   * type descriptions for project-owned values, but their imported runtime
   * bindings are fenced separately by the Lowerer. */
  isExternalTypeFile: (sf: ts.SourceFile) => boolean;
  /** The program's general stream representation (lowerToIr decides it
   * per program): NodeJS.ReadableStream / NodeJS.WritableStream and
   * @types/node's stream.Readable / stream.Writable map to the runtime
   * stream classes instead of the child/process stdio handles, so values
   * from every stream producer share their slots. Off (the default), the
   * stdio handles keep those spellings. */
  generalNodeStreams?: boolean;
  /** With generalNodeStreams, the program's checked-dynamic stream slots
   * (lowerToIr decides it per program, dyn-streams.ts): NodeJS.ReadableStream
   * and NodeJS.WritableStream map to the checked-dynamic representation, so
   * a slot holds a native stream (a boxed runtime stream, identity kept) or
   * a JavaScript stream object. Members dispatch per value at run time. */
  dynNodeStreams?: boolean;
  /** Successful context-free mappings, keyed by the
   * TypeScript server's stable type id. A generated facade can reference the
   * same large record/function type thousands of times; remapping its full
   * member graph each time is quadratic work. Generic/mixin contexts opt out
   * through canMemoizeType because the same checker type can map differently
   * under different instantiation bindings. */
  typeMemo?: Map<string, IrType>;
  canMemoizeType?: () => boolean;
  /** True for files the Lowerer actually compiles (its module order). A
   * class type can reach the entry through the TYPE world alone — a jsdoc
   * `typeof import('./mod')` over a module never imported at value level
   * pulls the file into the ts.Program without ever entering the lowered
   * program, so its classes never register and an object type naming one
   * would ICE the validator. Such instance types stay unmapped (null):
   * callers fence them like any other unsupported type. */
  isProgramFile: (sf: ts.SourceFile) => boolean;

  moduleNamespaceId?: (type: ts.Type) => string | null;
  /** The LifetimeRegion instance type (@scriptc/experimental), when `decl`
   * is that package's class declaration (lowering/lifetime-regions.ts). */
  lifetimeRegionClass?: (decl: ts.ClassDeclaration) => IrType | null;
  /** The InternTable instance type (@scriptc/experimental), when `decl` is
   * that package's class declaration (lowering/intern-tables.ts). */
  internTableClass?: (decl: ts.ClassDeclaration) => IrType | null;
  /** The ThreadSlots instance type (@scriptc/experimental), when `decl` is
   * that package's class declaration (lowering/thread-slots.ts). */
  threadSlotsClass?: (decl: ts.ClassDeclaration) => IrType | null;
}
/** A generator type's normalized value channels (Generator<T, TReturn,
 * TNext> and the IteratorResult alias share this):
 * - yield: `never` (a generator that never yields) rides the VOID
 *   sentinel; any/unknown ride dyn; undefined-only yields have no C value
 *   form (null); else the mapped type.
 * - return: void/undefined/never carry no value (VOID — the done-value is
 *   the undefined arm); any/unknown carry checked values. A defaulted or
 *   inferred return channel can still return a value and must preserve it.
 * - next: void/undefined/never mean valueless resumes (the undefined
 *   unit); any/unknown ride dyn; else the mapped type (`.next(v)` then
 *   requires its argument — fenced at the call site).
 * Mixed dyn/concrete value channels both use checked values because the
 * shared result record's value slot has one representation. */
function genChannels(
  yieldTs: ts.Type | undefined,
  retTs: ts.Type | undefined,
  nextTs: ts.Type | undefined,
  ctx: TypeMapperCtx,
): { yieldT: IrType; retT: IrType; nextT: IrType } | null {
  if (!yieldTs) return null;
  const UNITISH = ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never;
  const ANYISH = ts.TypeFlags.Any | ts.TypeFlags.Unknown;
  let yieldT: IrType | null;
  if (yieldTs.flags & ts.TypeFlags.Never) yieldT = VOID;
  else if (yieldTs.flags & ANYISH) yieldT = DYN;
  else {
    yieldT = mapType(yieldTs, ctx);
    if (yieldT?.kind === "void" || (yieldT && isUnitType(yieldT))) yieldT = null;
  }
  if (!yieldT) return null;
  const retT =
    retTs === undefined || retTs.flags & UNITISH
      ? VOID
      : retTs.flags & ANYISH
        ? DYN
        : mapType(retTs, ctx);
  if (!retT || (retT.kind !== "void" && isUnitType(retT))) return null;
  const nextT =
    nextTs === undefined || nextTs.flags & UNITISH
      ? UNDEFINED_T
      : nextTs.flags & ANYISH
        ? DYN
        : mapType(nextTs, ctx);
  if (!nextT || nextT.kind === "void" || nextT.kind === "nullT") return null;
  const ownChannel = (t: IrType): boolean =>
    t.kind === "f64" || t.kind === "bool" || t.kind === "string";
  // A record yield channel keeps its type beside a dyn return (an
  // `IterableIterator<Row>`). A record return channel beside a dyn yield
  // does not: the value a delegating `yield*` answers (Effect.gen's
  // generators) is often an object whose methods a record would drop.
  const dynMix =
    (yieldT.kind === "dyn" && retT.kind !== "dyn" && retT.kind !== "void" && !ownChannel(retT)) ||
    (retT.kind === "dyn" &&
      yieldT.kind !== "dyn" &&
      yieldT.kind !== "void" &&
      !ownChannel(yieldT) &&
      yieldT.kind !== "record");
  if (dynMix) return { yieldT: DYN, retT: DYN, nextT };
  return { yieldT, retT, nextT };
}

/** SELF-REFERENTIAL types recurse through mapType with no structural floor:
 * `function somefn() { return somefn; }` maps the return type by mapping the
 * function's own type again (the 15-stack-overflow-self-return signature),
 * and `new.target` in a class-field function expression builds the same
 * loop through the containing class. Legitimate types bottom out fast —
 * anything this deep is cyclic (or pathological), and unmappable (null) is
 * the honest answer: every call site already owns a fence or checked-dyn
 * fallback for it. */
const MAP_TYPE_MAX_DEPTH = 64;
let mapTypeDepth = 0;
/** Bumped whenever mapType resolves a type through CONTEXT-SENSITIVE or
 * collection-sensitive hooks (a generic body's type parameter, a mixin
 * instantiation, a generic class instance) — mappings that can make the same
 * ts.Type answer differently across instantiation contexts or collection
 * phases.
 * The recursive-shape machinery keys shape identity by checker type, which
 * is sound only for context-FREE mappings: a recursive frame that observes
 * a bump between entry and exit stays fenced (recursive generic-open types
 * stay fenced instead of interning a per-context-wrong shape). */
let contextResolutions = 0;

/** node:url's legacy record interfaces: url.parse()'s Url instance (and
 * its two query-typed refinements), url.format()'s UrlObject input, the
 * URL form's URLFormatOptions, and urlToHttpOptions's result. The values
 * are checked-dynamic objects — Node's Url instance carries its class name
 * and null fields, format() reads any object's fields with JS truthiness,
 * and urlToHttpOptions answers a null-prototype object. */
const LEGACY_URL_TYPES = new Set([
  "Url",
  "UrlObject",
  "UrlWithParsedQuery",
  "UrlWithStringQuery",
  "URLFormatOptions",
  "UrlHttpOptions",
]);

export function isLegacyUrlType(
  type: ts.Type,
  ctx: Pick<TypeMapperCtx, "checker" | "isStdlibFile">,
): boolean {
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  return isLegacyUrlSymbol(symbol, ctx);
}

/** A symbol declared as one of node:url's legacy record interfaces, or as
 * a member of one. */
export function isLegacyUrlSymbol(
  symbol: ts.Symbol | null | undefined,
  ctx: Pick<TypeMapperCtx, "checker" | "isStdlibFile">,
): boolean {
  if (!symbol) return false;
  for (const d of symbol.declarations) {
    if (!ctx.isStdlibFile(ts.getSourceFileOfNode(d))) continue;
    let family = false;
    for (let n: ts.Node | undefined = d; n; n = n.parent) {
      if (ts.isInterfaceDeclaration(n) && LEGACY_URL_TYPES.has(n.name.text)) family = true;
      if (ts.isModuleDeclaration(n) && ts.isStringLiteral(n.name)) {
        if (family && (n.name.text === "url" || n.name.text === "node:url")) return true;
        break;
      }
    }
  }
  return false;
}

/** os.constants and its groups — @types/node's `namespace constants`
 * (errno, dlopen, priority) and SignalConstants, and the fallback's twins:
 * the runtime's checked-dynamic constants object, whose members vary by
 * platform. */
export function isOsConstantsType(
  type: ts.Type,
  ctx: Pick<TypeMapperCtx, "checker" | "isStdlibFile">,
): boolean {
  return (
    isOsConstantsSymbol(type.getAliasSymbol(), ctx, true) ||
    isOsConstantsSymbol(type.getSymbol(), ctx, true)
  );
}

/** A symbol declared as os.constants or one of its groups (a namespace, or
 * with `types`, the SignalConstants alias; without it, the `signals`
 * constant). The binding-symbol form needs no type query. */
export function isOsConstantsSymbol(
  symbol: ts.Symbol | null | undefined,
  ctx: Pick<TypeMapperCtx, "checker" | "isStdlibFile">,
  types = false,
): boolean {
  if (!symbol) return false;
  for (const d of symbol.declarations) {
    const alias = types && ts.isTypeAliasDeclaration(d) && d.name.text === "SignalConstants";
    const signals =
      !types && ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && d.name.text === "signals";
    if (
      !(alias || signals || ts.isModuleDeclaration(d)) ||
      !ctx.isStdlibFile(ts.getSourceFileOfNode(d))
    )
      continue;
    let inConstants = ts.isModuleDeclaration(d) && d.name.text === "constants";
    for (let n: ts.Node | undefined = d.parent; n; n = n.parent) {
      if (!ts.isModuleDeclaration(n)) continue;
      if (ts.isStringLiteral(n.name)) {
        if ((n.name.text === "os" || n.name.text === "node:os") && (alias || inConstants))
          return true;
        break;
      }
      if (n.name.text === "constants") inConstants = true;
    }
  }
  return false;
}

/** worker_threads' Worker and MessagePort: owned runtime handles that keep
 * their live object representation (DYN) wherever they are stored. */
function isWorkerHandleSymbol(
  symbol: ts.Symbol | undefined,
  ctx: Pick<TypeMapperCtx, "checker" | "isStdlibFile">,
): boolean {
  return (
    ((symbol !== undefined && ts.symbolName(symbol) === "Worker") ||
      (symbol !== undefined && ts.symbolName(symbol) === "MessagePort") ||
      (symbol !== undefined && ts.symbolName(symbol) === "MessageChannel") ||
      (symbol !== undefined && ts.symbolName(symbol) === "BroadcastChannel")) &&
    symbol.declarations.some(
      (d) =>
        (ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "worker_threads"),
    )
  );
}

/** The `{ message: any }` object type (or its union with undefined) that
 * worker_threads declares as receiveMessageOnPort's result. */
/** A union of dns lookup option bags with numbers and nullish values that
 * includes LookupAllOptions (whose `all: true` arm has no record form). */
function isLookupOptionsUnion(type: ts.Type, ctx: Pick<TypeMapperCtx, "isStdlibFile">): boolean {
  if (!type.isUnionType()) return false;
  let all = false;
  for (const member of ts.constituentTypes(type)) {
    if (member.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined))
      continue;
    const symbol = member.getSymbol();
    if (
      symbol === undefined ||
      !/^Lookup(One|All)?Options$/.test(ts.symbolName(symbol)) ||
      !symbol.declarations.some((d) => ctx.isStdlibFile(ts.getSourceFileOfNode(d)))
    )
      return false;
    if (ts.symbolName(symbol) === "LookupAllOptions") all = true;
  }
  return all;
}

/** The binary and stream members of fetch's BodyInit (undici-types):
 * NodeJS.ArrayBufferView expands to the typed arrays and DataView. */
const FETCH_BODY_MEMBERS: ReadonlySet<string> = new Set([
  "ArrayBuffer",
  "SharedArrayBuffer",
  "AsyncIterable",
  "Iterable",
  "Blob",
  "FormData",
  "URLSearchParams",
  "ReadableStream",
  "DataView",
  "Buffer",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

/** fetch's request body type, BodyInit, however TypeScript spells it
 * (`RequestInit["body"]`, `NonNullable<...>`, an optional member): a
 * union of strings, the stdlib binary and stream types and nullish
 * values that includes both FormData and URLSearchParams. Native fetch
 * reads such a body at run time, so it rides checked-dynamic storage. */
function isFetchBodyUnion(type: ts.Type, ctx: Pick<TypeMapperCtx, "isStdlibFile">): boolean {
  if (!type.isUnionType()) return false;
  let formData = false;
  let searchParams = false;
  for (const member of ts.constituentTypes(type)) {
    if (member.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined))
      continue;
    const symbol = member.getSymbol();
    if (
      symbol === undefined ||
      !FETCH_BODY_MEMBERS.has(ts.symbolName(symbol)) ||
      !symbol.declarations.some((d) => ctx.isStdlibFile(ts.getSourceFileOfNode(d)))
    )
      return false;
    if (ts.symbolName(symbol) === "FormData") formData = true;
    if (ts.symbolName(symbol) === "URLSearchParams") searchParams = true;
  }
  return formData && searchParams;
}

/** A mapped object type (Omit, Pick, Partial) whose members all come from
 * one stdlib interface that maps to the checked dynamic. */
function isDynInterfaceSubset(type: ts.Type, ctx: TypeMapperCtx): boolean {
  if (!(type.flags & ts.TypeFlags.Object) || type.isClassOrInterface()) return false;
  const alias = type.getAliasSymbol();
  if (alias === undefined) return false;
  const props = ctx.checker.getPropertiesOfType(type);
  if (props.length === 0) return false;
  let owner: ts.InterfaceDeclaration | undefined;
  for (const prop of props) {
    const decl = prop.declarations[0];
    const parent = decl?.parent;
    if (
      parent === undefined ||
      !ts.isInterfaceDeclaration(parent) ||
      !ctx.isStdlibFile(ts.getSourceFileOfNode(parent)) ||
      (owner !== undefined && owner !== parent)
    )
      return false;
    owner = parent;
  }
  return (
    owner !== undefined && mapType(ctx.checker.getTypeAtLocation(owner.name), ctx)?.kind === "dyn"
  );
}

/** fetch's HeadersInit (undici-types): a union of the stdlib Headers
 * class with header-pair arrays and/or a header record, plus nullish
 * values. Native fetch reads it at run time like the init around it. */
function isFetchHeadersUnion(type: ts.Type, ctx: Pick<TypeMapperCtx, "isStdlibFile">): boolean {
  if (!type.isUnionType()) return false;
  let headers = false;
  let other = false;
  for (const member of ts.constituentTypes(type)) {
    if (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) continue;
    const symbol = member.getSymbol();
    if (
      symbol !== undefined &&
      ts.symbolName(symbol) === "Headers" &&
      symbol.declarations.some((d) => ctx.isStdlibFile(ts.getSourceFileOfNode(d)))
    ) {
      headers = true;
      continue;
    }
    const alias = ts.symbolNameOf(member.getAliasSymbol());
    if (
      (symbol !== undefined && ts.symbolName(symbol) === "Array") ||
      (symbol !== undefined && ts.symbolName(symbol) === "ReadonlyArray") ||
      alias === "Record" ||
      alias === "HeaderRecord"
    ) {
      other = true;
      continue;
    }
    return false;
  }
  return headers && other;
}

function isReceiveMessageResult(
  type: ts.Type,
  ctx: Pick<TypeMapperCtx, "checker" | "isStdlibFile">,
): boolean {
  const members = type.isUnionType() ? ts.constituentTypes(type) : [type];
  let found = false;
  for (const member of members) {
    if (member.flags & ts.TypeFlags.Undefined) continue;
    const decl = member.getSymbol() ? member.getSymbol()!.declarations[0] : undefined;
    let fn: ts.Node | undefined = decl?.parent;
    while (fn && ts.isUnionTypeNode(fn)) fn = fn.parent;
    if (
      !decl ||
      !ts.isTypeLiteralNode(decl) ||
      !fn ||
      !ts.isFunctionDeclaration(fn) ||
      fn.name?.text !== "receiveMessageOnPort" ||
      !ctx.isStdlibFile(ts.getSourceFileOfNode(decl)) ||
      !isDeclaredInAmbientModule(fn, "worker_threads")
    ) {
      return false;
    }
    found = true;
  }
  return found;
}

/** True for a type built only from worker handles, null/undefined, and
 * arrays of those: values that keep the live DYN representation. */
export function isWorkerHandleType(
  type: ts.Type,
  ctx: Pick<TypeMapperCtx, "checker" | "isStdlibFile">,
): boolean {
  const members = type.isUnionType() ? ts.constituentTypes(type) : [type];
  let handle = false;
  for (const member of members) {
    if (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) continue;
    if (ctx.checker.isArrayType(member)) {
      const element = ctx.checker.getTypeArguments(member as ts.TypeReference)[0];
      if (element === undefined || !isWorkerHandleType(element, ctx)) return false;
    } else if (!isWorkerHandleSymbol(member.getSymbol(), ctx)) {
      return false;
    }
    handle = true;
  }
  return handle;
}

/** The return annotation of an `async *` declaration spelled with the
 * protocol interfaces the generator object implements —
 * `AsyncIterator<T>`, `AsyncIterableIterator<T>` or `AsyncIterable<T>` (pi's
 * `async *[Symbol.asyncIterator](): AsyncIterator<T>`): the body always
 * produces an async generator, so the declaration maps exactly like an
 * `AsyncGenerator<T, TReturn, TNext>` annotation. Values of these types
 * elsewhere stay unmapped (they can hold any object implementing the
 * protocol). Null when the annotation is not one of them. */
export function mapAsyncGeneratorAnnotation(type: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const { checker } = ctx;
  const symbol = type.getSymbol();
  if (
    !symbol ||
    !["AsyncIterator", "AsyncIterableIterator", "AsyncIterable"].includes(ts.symbolName(symbol)) ||
    !symbol.declarations.some(
      (d) => ts.isInterfaceDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  )
    return null;
  const args = checker.getTypeArguments(type as ts.TypeReference);
  const channels = genChannels(args[0], args[1], args[2], ctx);
  if (!channels) return null;
  if (!genResultRecord(channels.yieldT, channels.retT, ctx.shapes, ctx.unions)) return null;
  return { kind: "generator", async: true, ...channels };
}

/** The native fetch handles (Headers, Request, Response), optionally in
 * arrays or with null/undefined: checked-dynamic handles wherever they are
 * stored, like the worker handles above. */
export function isFetchHandleType(
  type: ts.Type,
  ctx: Pick<TypeMapperCtx, "checker" | "isStdlibFile">,
): boolean {
  const members = type.isUnionType() ? ts.constituentTypes(type) : [type];
  let handle = false;
  for (const member of members) {
    if (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) continue;
    if (ctx.checker.isArrayType(member)) {
      const element = ctx.checker.getTypeArguments(member as ts.TypeReference)[0];
      if (element === undefined || !isFetchHandleType(element, ctx)) return false;
    } else {
      const symbol = member.getSymbol();
      if (
        !symbol ||
        (ts.symbolName(symbol) !== "Headers" &&
          ts.symbolName(symbol) !== "Request" &&
          ts.symbolName(symbol) !== "Response") ||
        !symbol.declarations.some(
          (d) =>
            (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
            ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
        )
      )
        return false;
    }
    handle = true;
  }
  return handle;
}

export function mapType(type: ts.Type, ctx: TypeMapperCtx): IrType | null {
  if (mapTypeDepth >= MAP_TYPE_MAX_DEPTH) return null;
  // These intrinsic domains cannot depend on generic bindings, declaration
  // provenance, or recursive shape state. Enum literals retain the ordinary
  // widening path, including mixed numeric/string enum representations.
  const flags = type.flags;
  if ((flags & ts.TypeFlags.EnumLike) === 0) {
    if (flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) return F64;
    if (flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral | ts.TypeFlags.TemplateLiteral))
      return STRING;
    if (flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) return BOOL;
  }
  const localValue = ctx.localClassValue?.(type);
  if (localValue) {
    contextResolutions++;
    return localValue;
  }
  const topLevel = mapTypeDepth === 0;
  const typeId = (type as { id?: number }).id;
  const memoizable = typeId !== undefined && (ctx.canMemoizeType?.() ?? true);
  // An empty literal's type maps to the empty record as an unreduced union's
  // arm (emptyLiteralArm) and to the checked-dynamic value elsewhere: the two
  // answers keep separate memo entries.
  const memoKey = memoizable ? `${ctx.emptyLiteralArm ? 1 : 0}:${typeId}` : null;
  if (memoKey !== null) {
    const memo = ctx.typeMemo?.get(memoKey);
    if (memo !== undefined) return memo;
  }
  const sensitivityAtEntry = contextResolutions;
  mapTypeDepth++;
  try {
    let mapped: IrType | null;
    try {
      mapped = mapTypeInner(type, ctx);
    } catch (e) {
      // typescript-go's API can panic serializing a union's members (an
      // empty tuple cloned as an array literal, `s.match(re) || []`): a
      // union the checker cannot describe has no representation.
      if (!topLevel || !ts.isUnreadableConstituentsPanic(e)) throw e;
      mapped = null;
    }
    if (
      mapped !== null &&
      memoKey !== null &&
      topLevel &&
      contextResolutions === sensitivityAtEntry &&
      (ctx.canMemoizeType?.() ?? true)
    ) {
      ctx.typeMemo?.set(memoKey, mapped);
    }
    return mapped;
  } finally {
    mapTypeDepth--;
  }
}

/** Local class types need the enclosing specialization's registered layout.
 * Static-block classes are sent through the same hook for an explicit fence. */
function classExprNeedsContext(decl: ts.ClassLikeDeclaration): boolean {
  for (
    let p: ts.Node | undefined = decl.parent;
    p !== undefined && !ts.isSourceFile(p);
    p = p.parent
  ) {
    if (ts.isFunctionLike(p) || ts.isClassStaticBlockDeclaration(p)) return true;
  }
  return false;
}

/** True for the type of a TypeScript object literal with no contextual
 * type (`const options = { ...location, path }`) that spreads a value
 * mapping to the checked dynamic (a stdlib options type such as
 * http.RequestOptions). A literal with a contextual type is built in that
 * type's representation instead, and JavaScript literals keep their own
 * rules. */
function spreadsCheckedDynamic(symbol: ts.Symbol | undefined, ctx: TypeMapperCtx): boolean {
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.ObjectLiteral) === 0) return false;
  const decl = symbol.declarations[0];
  if (decl === undefined || !ts.isObjectLiteralExpression(decl)) return false;
  if (isJsSourceFile(ts.getSourceFileOfNode(decl))) return false;
  if (ctx.checker.getContextualType(decl)) return false;
  return decl.properties.nodes.some(
    (prop) =>
      ts.isSpreadAssignment(prop) &&
      mapType(ctx.checker.getTypeAtLocation(prop.expression), ctx)?.kind === "dyn",
  );
}

function mapTypeInner(type: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const { checker, unions, classNamer, resolveTypeParam } = ctx;
  // TypeScript's intrinsic globalThis symbol has no declaration. A stored
  // reference needs native object identity, including var's undefined state.
  const intrinsic = type.getSymbol();
  const isIntrinsicGlobal = (symbol: ts.Symbol | undefined): boolean =>
    symbol !== undefined &&
    ts.symbolName(symbol) === "globalThis" &&
    symbol.declarations.length === 0;
  if (isIntrinsicGlobal(intrinsic)) return DYN;
  // `typeof globalThis & { key?: T }` (the global-singleton spelling) is the
  // same global object with declared extra members.
  if (
    type.isIntersectionType() &&
    ts.constituentTypes(type).some((part) => isIntrinsicGlobal(part.getSymbol()))
  )
    return DYN;
  if (ctx.jsDynamicDeclaration !== undefined && intrinsic !== undefined) {
    const objectLiteral = (intrinsic.flags & ts.SymbolFlags.ObjectLiteral) !== 0;
    const classInstance =
      (intrinsic.flags & ts.SymbolFlags.Class) !== 0 && type.isClassOrInterface();
    if (
      (objectLiteral || classInstance) &&
      intrinsic.declarations.some((decl) => ctx.jsDynamicDeclaration!(decl))
    )
      return DYN;
  }
  {
    const moduleId = ctx.moduleNamespaceId?.(type) ?? null;
    if (moduleId !== null) return { kind: "moduleNs", moduleId };
  }
  // A TypeScript object literal that spreads a checked-dynamic value
  // (`{ ...requestOptions, path, timeout }`): its keys are the source's
  // runtime keys, which no record shape holds, so the literal rides
  // checked-dynamic storage like its source.
  if (spreadsCheckedDynamic(intrinsic, ctx)) return DYN;
  // worker_threads.receiveMessageOnPort's `{ message: any } | undefined`:
  // the runtime's { message } object, a checked-dynamic value.
  if (isReceiveMessageResult(type, ctx)) return DYN;
  if (isFetchBodyUnion(type, ctx) || isFetchHeadersUnion(type, ctx)) return DYN;
  // Omit/Pick/Partial of a stdlib interface that rides checked-dynamic
  // storage (`Omit<RequestInit, "body" | "headers">`): every member comes
  // from that interface, so the value is a subset of the same runtime-read
  // options object and rides the same storage.
  if (isDynInterfaceSubset(type, ctx)) return DYN;
  // The lookup-function option union (`LookupOneOptions | LookupAllOptions
  // | number | undefined`): with a LookupAllOptions arm it is an option bag
  // dns.lookup reads at run time, so it rides checked-dynamic storage.
  if (isLookupOptionsUnion(type, ctx)) return DYN;
  // @types/node spells child_process.ExecFileException as an intersection
  // type alias over two Error-derived metadata interfaces. The value is
  // still one ordinary Error; recognize the owned alias before generic
  // intersection mapping decomposes it into unsupported utility types.
  const directAlias = type.getAliasSymbol();
  if (
    directAlias !== undefined &&
    ts.symbolName(directAlias) === "ExecFileException" &&
    directAlias.declarations.some((decl) => ctx.isStdlibFile(ts.getSourceFileOfNode(decl)))
  ) {
    return { kind: "object", className: "%Error" };
  }
  // child_process.ExecException, exec's callback error, is an interface
  // extending Error with optional metadata members; the value is one
  // ordinary Error as well.
  const execException = type.getSymbol();
  if (
    execException !== undefined &&
    ts.symbolName(execException) === "ExecException" &&
    execException.declarations.some(
      (decl) =>
        ts.isInterfaceDeclaration(decl) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(decl)) &&
        isDeclaredInAmbientModule(decl, "child_process"),
    )
  ) {
    return { kind: "object", className: "%Error" };
  }
  if (isOsConstantsType(type, ctx) || isLegacyUrlType(type, ctx)) return DYN;
  // The WebAssembly API's values have the checked-dynamic representation, so
  // declarations that merely mention them compile; each reached use of the
  // API itself is refused at its site (builtins/webassembly.ts).
  if (isWebAssemblyType(type, ctx)) return DYN;
  // A union over one of them (quickjs-wasi's `BufferSource | WebAssembly.Module`
  // option) holds that dynamic value too, so the whole union is dynamic.
  if (type.isUnionType() && ts.constituentTypes(type).some((t) => isWebAssemblyType(t, ctx)))
    return DYN;
  // JavaScript inference merges WebAssembly.instantiate's overloads into
  // `Promise<WebAssemblyInstantiatedSource> & Promise<Instance>`: a promise
  // of a WebAssembly value either way.
  if (
    type.isIntersectionType() &&
    ts.constituentTypes(type).every((t) => {
      if (ts.symbolNameOf(t.getSymbol()) !== "Promise") return false;
      const arg = ctx.checker.getTypeArguments(t as ts.TypeReference)[0];
      return arg !== undefined && isWebAssemblyType(arg, ctx);
    })
  )
    return { kind: "promise", inner: DYN };
  // Immutable<T> (@scriptc/types) is a deep-readonly view: the value is
  // still the T it maps.
  const immutableSource = immutableSourceType(type, ctx);
  if (immutableSource !== null) return mapType(immutableSource, ctx);
  // Inside an erased generic signature or body, every type that mentions
  // an erased type parameter is `unknown` (`T[]`, `Map<string, T>`,
  // `[A, B]`, `T[K]`, callbacks over `T`): its values cross through the
  // checked-dynamic boundary, as JavaScript sees them. The erased
  // signature itself maps its parameters and result this way.
  if (
    (ctx.erasingSignature || ctx.isErasing?.()) &&
    !(type.flags & ts.TypeFlags.TypeParameter) &&
    !checker.getCallSignatures(type).some((sig) => sig === ctx.erasingSignature) &&
    !ERASURE_KEPT_CONTAINERS.has(ts.symbolNameOf(type.getSymbol()) ?? "") &&
    mentionsErasedTypeParam(type, ctx, 0)
  ) {
    contextResolutions++;
    return DYN;
  }
  // Readonly<C> over a program class (Object.freeze's result type) is the
  // same instance.
  const readonlyClass = readonlyClassType(type, ctx);
  if (readonlyClass !== null) return readonlyClass;
  if (resolveTypeParam && type.flags & ts.TypeFlags.TypeParameter) {
    const bound = resolveTypeParam(type);
    if (bound) {
      contextResolutions++;
      return bound;
    }
  }
  // Narrowed type parameters: `!== undefined` / `!== null` / truthiness on
  // a `T | undefined`-flavored value inside a generic body leaves the
  // SYMBOLIC forms `T & {}`, `T & ({} | null)`, `(T & {}) | (T & null)`
  // (concrete types compute the intersection away; only generic bodies see
  // them). Each companion is an ALLOWANCE over the binding's arms — `{}`
  // admits every non-unit arm, a null/undefined companion its unit — and
  // the mapping is the binding filtered to what the narrowing kept.
  if (resolveTypeParam) {
    const viaNarrowedParam = mapNarrowedTypeParam(type, ctx);
    if (viaNarrowedParam !== undefined) {
      contextResolutions++;
      return viaNarrowedParam;
    }
    // `Awaited<T>` over a bound type parameter (an async generic body's
    // `await fn()` result): a CONDITIONAL type the checker keeps symbolic
    // inside the body — the object-gated utility-alias hook below never
    // sees it, so it resolves here, before the flag dispatch.
    const viaAwaited = mapGenericAwaitedAlias(type, ctx);
    if (viaAwaited !== null) {
      contextResolutions++;
      return viaAwaited;
    }
    // `T[K]` over a bound parameter: like Awaited, a form the checker
    // keeps symbolic inside the body. Two resolvers, tried in order: the
    // structural read against the record binding, then the bound-checker
    // route for a K naming one concrete key (mapBoundIndexedAccess).
    const viaIndexed = mapGenericIndexedAccess(type, ctx) ?? mapBoundIndexedAccess(type, ctx);
    if (viaIndexed !== null) {
      contextResolutions++;
      return viaIndexed;
    }
    // `Parameters<F>` / `ReturnType<F>` over a bound function-typed
    // parameter (variadic higher-order wrappers): the checker keeps both
    // conditionals symbolic inside the body, and their `infer` positions
    // match a call signature, which matchInferReference cannot decide.
    const viaSignature =
      mapBoundSignatureAlias(type, ctx) ?? mapBoundKeyofNeverConditional(type, ctx);
    if (viaSignature !== null) {
      contextResolutions++;
      return viaSignature;
    }
    // A conditional type over a bound parameter (`Infer<S["left"]>`, a
    // mapped type's member): evaluate it against the bindings.
    if (type.isConditionalType()) {
      const evaluated = evalMappedTemplate(type, new Map(), new Map(), ctx);
      if (evaluated && evaluated !== type) {
        const viaConditional = mapType(evaluated, ctx);
        if (viaConditional !== null) {
          contextResolutions++;
          return viaConditional;
        }
      }
    }
  }
  const widened = checker.getBaseTypeOfLiteralType(type);
  const flags = widened.flags;

  if (flags & ts.TypeFlags.Number) return F64;
  if (flags & ts.TypeFlags.String) return STRING;
  if (flags & ts.TypeFlags.Boolean || flags & ts.TypeFlags.BooleanLiteral) return BOOL;
  // ErrorOptions carries a presence-sensitive unknown value. A fixed
  // optional field cannot distinguish {} from { cause: undefined }; the
  // checked-dynamic object retains that distinction through forwarding
  // constructors. Only the standard library's interface gets this ABI.
  const errorOptionsSymbol = widened.getSymbol();
  if (
    errorOptionsSymbol !== undefined &&
    ts.symbolName(errorOptionsSymbol) === "ErrorOptions" &&
    errorOptionsSymbol.declarations.some((d) => ctx.isStdlibFile(ts.getSourceFileOfNode(d)))
  ) {
    return DYN;
  }
  // node:util.parseArgs config/results are declaration-heavy conditional
  // and discriminated-union types over a value that is naturally a checked-
  // dynamic tree. Keep the named public surface (plus @types/node's private
  // helper aliases that survive instantiation) in that representation:
  // typed member reads still exit through ordinary dyn checks, while the
  // runtime can preserve the three token variants and null-prototype values
  // object without inventing one false static record shape. Provenance keeps
  // user aliases with the same names on the normal structural path.
  {
    const parseArgsSym = widened.getAliasSymbol() ?? widened.getSymbol();
    const belongs = (declaration: ts.Node): boolean => {
      if (!ctx.isStdlibFile(ts.getSourceFileOfNode(declaration))) return false;
      let family = false;
      for (let node: ts.Node | undefined = declaration; node; node = node.parent) {
        if (
          (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
          PARSE_ARGS_DYN_TYPES.has(node.name.text)
        )
          family = true;
        if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
          return family && (node.name.text === "util" || node.name.text === "node:util");
        }
      }
      return false;
    };
    if (
      parseArgsSym &&
      PARSE_ARGS_DYN_TYPES.has(ts.symbolName(parseArgsSym)) &&
      parseArgsSym.declarations.some(belongs)
    )
      return DYN;
    // ReturnType and instantiated conditional types can erase the alias.
    // Require every member to retain the util declaration provenance so
    // unrelated records with similar property names keep their own layout.
    const members = checker.getPropertiesOfType(widened);
    if (members.length > 0 && members.every((member) => member.declarations.some(belongs)))
      return DYN;
  }
  // The lib's BOXED wrapper interfaces used as TYPES (`const n: Number =
  // 5`): every value such a slot can hold IS the primitive — `new
  // Number(...)` construction is fenced, so no box object ever exists —
  // and the interface members are exactly the primitive's lowered surface.
  // Provenance-gated: a user's own `interface Number` maps as a record.
  {
    const boxSym = widened.getSymbol();
    if (
      boxSym &&
      (ts.symbolName(boxSym) === "Number" ||
        ts.symbolName(boxSym) === "String" ||
        ts.symbolName(boxSym) === "Boolean") &&
      boxSym.declarations.some((d) => ctx.isStdlibFile(ts.getSourceFileOfNode(d)))
    ) {
      return ts.symbolName(boxSym) === "Number"
        ? F64
        : ts.symbolName(boxSym) === "String"
          ? STRING
          : BOOL;
    }
  }
  // The lib's PRIMITIVE-CONSTRUCTOR interfaces as TYPES (`typeof String`,
  // a `type: StringConstructor` record field — the CLI option-table
  // idiom): the VALUE is the interned coercion closure (lower-exprs mints
  // one per program), so the type maps to that closure's one concrete
  // signature — the string-coercion form `(value: string) => primitive`.
  // String(s) is identity on strings, Number(s) the ECMA StringToNumber,
  // Boolean(s) emptiness — the parsed-token shape every stored-constructor
  // call feeds. Calls passing other argument types fence at their site
  // (the func param coercion), exactly like any other typed closure slot.
  // Provenance-gated like the boxed wrappers above: a user's own
  // `interface StringConstructor` maps as a record.
  {
    const ctorSym = widened.getSymbol();
    if (
      ctorSym &&
      (ts.symbolName(ctorSym) === "StringConstructor" ||
        ts.symbolName(ctorSym) === "NumberConstructor" ||
        ts.symbolName(ctorSym) === "BooleanConstructor") &&
      ctorSym.declarations.some((d) => ctx.isStdlibFile(ts.getSourceFileOfNode(d)))
    ) {
      return funcOf(
        [STRING],
        ts.symbolName(ctorSym) === "StringConstructor"
          ? STRING
          : ts.symbolName(ctorSym) === "NumberConstructor"
            ? F64
            : BOOL,
      );
    }
  }
  // `symbol` and `unique symbol` (the type of `const k = Symbol(...)` —
  // getBaseTypeOfLiteralType widens unique symbols, but check both flags)
  // map to the symbol identity kind.
  if (flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) return SYMBOL_T;
  if (flags & (ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral)) return BIGINT_T;
  // STANDALONE undefined (and void) map to VOID: return-type mapping flows
  // through here, and `(): void | undefined` functions must stay void.
  // Inside a union, undefined becomes the undefinedT unit ARM instead (see
  // the union branch below). VALUE positions that today receive VOID
  // (record fields, tuple/array elements, variable slots) substitute the
  // unit-only union themselves (isUnitOnlyTsType + unitOnlyUnion) — the
  // position knows it wants a value; this mapping cannot.
  if (flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return VOID;
  // Generic visitors can instantiate `T | undefined` as `void | undefined`.
  // It has the same return convention as standalone void; value positions
  // still substitute the unit-only slot through isUnitOnlyTsType below.
  if (
    widened.isUnionType() &&
    ts.constituentTypes(widened).every((part) => {
      if ((part.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !== 0) return true;
      // A forwarding generic call keeps its caller's symbolic T in the
      // resolved signature. Its current instantiation can still be void.
      if (
        (part.flags & ts.TypeFlags.TypeParameter) !== 0 &&
        resolveTypeParam?.(part)?.kind === "void"
      ) {
        contextResolutions++;
        return true;
      }
      return false;
    })
  )
    return VOID;
  // Standalone `null` (a `const x = null` binding, a `{ value: null }`
  // field, a `(): null` return): the unit-only union — the value is always
  // THE interned null instance, comparisons are tag tests, JSON serializes
  // null. Inside a union, null keeps becoming the nullT ARM (the union
  // branch below never recurses here for null parts).
  if (flags & ts.TypeFlags.Null) return unitOnlyUnion(unions);
  // `never` VALUES are uninhabited — the checker only types dead reads
  // this way (`for (const v of [])`'s loop var, the empty literal's
  // `never[]` element) — so any representation is unobservable; f64 is the
  // cheapest slot. Return positions never reach here (declaredReturnType
  // and the signature branches map never returns to VOID first), and
  // construction sites cannot exist (nothing has type never to feed them).
  if (flags & ts.TypeFlags.Never) return F64;
  // `unknown` is a VALUE with a runtime representation (the dyn JSON dyn —
  // JSON.parse results and unknown-typed locals/params/returns).
  if (flags & ts.TypeFlags.Unknown) return DYN;
  // `object` (the NonPrimitive intrinsic) is a TOP type over non-primitive
  // values — tsc admits every record, array, function, or class instance
  // into an `object` slot, so no exact record shape can hold it. It lowers
  // like `unknown` (the dyn): assignments convert at the site (sources
  // outside the checked-dynamic tree fence there, same as unknown), reads narrow back out
  // through the same checked casts. Member accesses tsc allows on `object`
  // (the Object.prototype surface) fence at their use sites.
  if (flags & ts.TypeFlags.NonPrimitive) return DYN;

  // Context-free `any` has no concrete storage shape. The lowering site
  // chooses checked-value storage when its operations support that boundary.
  if (flags & ts.TypeFlags.Any) return null;
  // Enum types and enum member literal types: an enum VALUE at runtime IS
  // its underlying primitive (tsc's own emit stores plain numbers/strings
  // on the enum object; const enums inline them), so the enum type maps to
  // number/string — comparisons, switch dispatch, arithmetic, and template
  // formatting all take their ordinary primitive lowerings. A member
  // literal type (`E.A` in type position) widens to the whole enum first
  // (getBaseTypeOfLiteralType), so both spellings land here. Heterogeneous
  // enums map to the number|string union (each member READ produces one
  // exact arm; the slot re-tags like any literal-into-union assignment).
  // A union MIXING enum literals with non-enum arms (`E | undefined`)
  // falls through to the general union branch below, whose per-part
  // recursion re-enters here with the pure enum parts.
  if (flags & ts.TypeFlags.EnumLike) {
    const parts = widened.isUnionType() ? ts.constituentTypes(widened) : [widened];
    if (parts.every((p) => p.flags & ts.TypeFlags.EnumLike)) {
      let hasNum = false;
      let hasStr = false;
      for (const p of parts) {
        if (p.flags & ts.TypeFlags.StringLiteral) hasStr = true;
        // NumberLiteral members, and the non-literal `Enum` flavor (an
        // enum with computed members is a NUMERIC enum type — string
        // members would make it a literal enum by definition).
        else hasNum = true;
      }
      if (hasNum && hasStr) {
        const arms = [F64, STRING];
        arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
        return { kind: "union", unionId: unions.intern(arms) };
      }
      return hasStr ? STRING : F64;
    }
  }
  // @scriptc/experimental's LifetimeRegion, InternTable and ThreadSlots:
  // synthetic program classes, provenance-checked by the package's
  // declaration file.
  {
    const classSym = widened.getSymbol();
    const name = ts.symbolNameOf(classSym);
    if (name === "LifetimeRegion" || name === "InternTable" || name === "ThreadSlots") {
      for (const d of classSym!.declarations) {
        if (!ts.isClassDeclaration(d)) continue;
        const synthetic =
          name === "LifetimeRegion"
            ? ctx.lifetimeRegionClass?.(d)
            : name === "InternTable"
              ? ctx.internTableClass?.(d)
              : ctx.threadSlotsClass?.(d);
        if (synthetic) return synthetic;
      }
    }
  }
  // Declaration-only package types have no compiled implementation.
  // Primitive and container types retain their structural mappings; types
  // owned by the standard library or explicit host mappings are handled
  // by their dedicated native rules. Pure type shapes — interfaces, type
  // aliases, and object or mapped type literals with no value declaration
  // merged in — describe data, not an implementation: a program value of
  // such a type is one the program built itself (`import type` from a
  // types-only package), so it maps structurally like a local declaration.
  // Values the package itself would produce stay refused at their import.
  const packageOnly = (sym: ts.Symbol | undefined): readonly ts.Node[] | null => {
    const decls = sym ? sym.declarations : undefined;
    return decls &&
      decls.length > 0 &&
      decls.every((d) => {
        const sf = ts.getSourceFileOfNode(d);
        return sf.isDeclarationFile && !ctx.isStdlibFile(sf) && !ctx.isExternalTypeFile(sf);
      })
      ? decls
      : null;
  };
  const pureTypeShape = (decls: readonly ts.Node[] | null): boolean =>
    decls === null ||
    decls.every(
      (d) =>
        packageTypeFile(ts.getSourceFileOfNode(d), ctx) &&
        (ts.isInterfaceDeclaration(d) ||
          ts.isTypeAliasDeclaration(d) ||
          ts.isTypeLiteralNode(d) ||
          ts.isMappedTypeNode(d) ||
          isDeclaredDataClass(d) ||
          (decls.some(isDeclaredDataClass) && isTypeOnlyNamespace(d))),
    );
  const aliasDecls = packageOnly(widened.getAliasSymbol());
  const ownDecls = packageOnly(widened.getSymbol());
  if (
    (aliasDecls !== null || (widened.getAliasSymbol() === undefined && ownDecls !== null)) &&
    !(pureTypeShape(aliasDecls) && pureTypeShape(ownDecls))
  ) {
    return null;
  }
  // Module namespaces were claimed above when they name compiled source
  // modules or supported builtins. Declaration-only namespaces remain refused.

  // T[]: monomorphic arrays, recursively (number[][] works). An element type
  // that doesn't map (never from a context-free `[]`) makes the whole array
  // unsupported — null propagates. Record/object/union elements ride the
  // runtime's REF element kind (per-array RC entry points, the map-value
  // technique), and PROMISE elements ride it too (Promise<T>[] is
  // Promise.all's food: promises are refcounted, cycle-headered values
  // with `_v` adapters like any other ref element). FUNCTION elements ride REF too (closure
  // `_v` adapters + scr_closure_trace_v — closures are cycle-headered):
  // `f === f` identity through indexOf/includes is sound because a
  // function VALUE is one ScrClosure for its whole life — top-level
  // declarations intern one immortal closure, and inner closures are
  // allocated once at their definition's evaluation and flow by
  // reference, exactly JS's function identity. Maps and Sets use their
  // typed RC/trace adapters; RegExp values use immutable REF storage. URL and
  // Date (scalar-backed but identity-bearing in JS) and the other opaque
  // handles stay unsupported as array elements; ordinary Date locals,
  // params, fixed record/tuple fields, and promise payloads are supported.
  if (checker.isArrayType(widened)) {
    const elemTs = checker.getTypeArguments(widened as ts.TypeReference)[0];
    if (!elemTs) return null;
    let elem = mapType(elemTs, ctx);
    // `undefined[]` (sparse literals — `[,]` — and explicit annotations):
    // the element rides the unit-only union like a record field would; the
    // VOID mapping is a return-position artifact, not a value.
    if (elem?.kind === "void" && isUnitOnlyTsType(elemTs, ctx.resolveTypeParam))
      elem = unitOnlyUnion(unions);

    if (!elem) return null;
    // `(T | undefined)[]` of a number, string or boolean T stores T
    // elements: an array slot holds a present undefined by its own state,
    // so a T[] seen as `(T | undefined)[]` stays the same array.
    let optionalElements = false;
    if (elem.kind === "union") {
      const arms = unions.get(elem.unionId)?.arms;
      const present =
        arms?.length === 2 ? arms.find((arm) => arm.kind !== "undefinedT") : undefined;
      if (
        present !== undefined &&
        arms!.some((arm) => arm.kind === "undefinedT") &&
        (present.kind === "f64" || present.kind === "string" || present.kind === "bool")
      ) {
        elem = present;
        optionalElements = true;
      }
    }
    // A dyn ELEMENT makes the WHOLE array the checked-dynamic value:
    // `unknown[]`, `object[]`, and the collapsed `(string | object)[]`
    // (the plugins-slot shape) — the checked-dynamic tree has real arrays, so length/
    // index/push/iteration ride the keyed-dyn paths. Native dyn-element
    // vectors are reserved for collection seeds and drains, rather than
    // changing this public representation. This is dynFallbackType's JS stance promoted into
    // the mapping itself; construction sites build dynArrLit (the checked-dynamic tree
    // array literal) and typed sources convert per element at the slot.
    // Arrays of class-backed protocol values are the exception: each
    // element is one checked-dynamic value (a class capsule or an object),
    // so a native array of them keeps every element's identity and passes
    // method calls a receiver they can dispatch.
    if (elem.kind === "dyn") return ctx.classImplementedProtocol?.(elemTs) ? arrayOf(DYN) : DYN;
    // The shared predicate is the runtime/backend storage contract. In
    // particular, valid standalone values such as Date and opaque
    // handles do not automatically have an array element representation.
    if (!isSupportedArrayElem(elem)) return null;
    // ChildProcess[] (the running-apps list) and Server[] (the [...set]
    // drain of the auxiliary-server registries): handles are ordinary
    // refcounted REF elements (their `_v` adapters, no trace — both drop
    // their closures at their terminal event).
    return optionalElements ? { kind: "array", elem, optionalElements: true } : arrayOf(elem);
  }
  // Tuples: `[string, string]` maps to an interned RECORD shape flagged
  // `tuple`, with one field per position named by its index ("0", "1", ...)
  // — fixed shape, literal-index access, length = the arity constant
  // (SEMANTICS.md). The flag keeps tuple shapes distinct from numeric-keyed
  // object records (JSON must serialize a tuple as an ARRAY) and is why
  // interning happens through the tuple-aware path. Optional/rest elements
  // have no fixed shape and stay unmapped; element types follow record-field
  // rules (no void/dyn).
  if (checker.isTupleType(widened)) {
    const ref = widened as ts.TupleTypeReference;
    // elementFlags live on the tuple SHAPE: a direct tuple type carries
    // them itself; a REFERENCE to one (isTupleType still answers true —
    // the facade's 5.9.3 contract) reads them off its target.
    const tupleShape =
      (ref.elementFlags as ts.ElementFlags[] | undefined) !== undefined
        ? ref
        : (ref.getTarget() as ts.TupleType | undefined);
    // The empty tuple `[]` — a declared annotation, or the facade edge
    // where isTupleType answers true with NO element flags on the shape or
    // its target (the empty-array arm of `''.match(/x/) || []`; the
    // declared `[]` reads the same way, 0 type arguments and no flags). A
    // zero-field tuple SHAPE would violate the IR's tuple invariant
    // (positional fields "0".."n-1", n >= 1), but the type needs no shape
    // at all — its only inhabitant is the empty array. It rides the ARRAY
    // representation over the unit-only element (the `undefined[]` rule):
    // length reads the runtime 0 and no element is ever written (push
    // takes `never`; indexed reads are out of range for tsc). Element-
    // FACING surfaces (JSON.stringify, spread, for-of) keep their
    // unit-element fences: no element exists, but the type-directed checks
    // see the unit arm.
    const args = checker.getTypeArguments(ref);
    if (args.length === 0) return arrayOf(unitOnlyUnion(unions));
    if (tupleShape?.elementFlags === undefined) return null;
    // A leading-required tuple ending in a rest element whose positions
    // all share one type (`[string, ...string[]]`, the non-empty list)
    // is an array of that type: every read, write and method behaves as
    // the array's, and tsc already proves the required positions exist.
    const flags = tupleShape.elementFlags;
    if (
      flags.length >= 2 &&
      (flags[flags.length - 1]! & ts.ElementFlags.Rest) !== 0 &&
      flags.slice(0, -1).every((f) => (f & ts.ElementFlags.Required) !== 0)
    ) {
      const elems = args.map((a) => mapType(a, ctx));
      const first = elems[0];
      if (
        first &&
        first.kind !== "void" &&
        isSupportedArrayElem(first) &&
        elems.every((e) => e !== null && typeEquals(e, first))
      )
        return arrayOf(first);
      return null;
    }
    // Optional/rest elements have no fixed native tuple layout.
    if (tupleShape.elementFlags.some((f) => !(f & ts.ElementFlags.Required))) {
      return null;
    }
    const fields: { name: string; type: IrType }[] = [];
    for (let i = 0; i < args.length; i++) {
      let et = (args[i]!.flags & ts.TypeFlags.Any) !== 0 ? DYN : mapType(args[i]!, ctx);
      // A unit-only element (`[number, undefined]`) rides the unit-only
      // union, the record-field rule.
      if (et?.kind === "void" && isUnitOnlyTsType(args[i]!, ctx.resolveTypeParam))
        et = unitOnlyUnion(unions);
      // dyn ELEMENTS map now — `[string, unknown]`, the Object.entries
      // tuple over an `unknown`-valued index signature (the pricing-table
      // normalizer shape): the slot has the overflow map's RC/JSON/dyn
      // plumbing, values arrive dyn or convert via dynFrom.
      if (!et || et.kind === "void") return null;

      // Object records may instead keep ambient abort handles in slots.

      fields.push({ name: String(i), type: et });
    }
    fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { kind: "record", shapeId: ctx.shapes.intern(fields, true) };
  }
  // BRANDED PRIMITIVES (`string & { readonly __brand: "UserId" }`,
  // `number & { readonly [tag]: "Meters" }`): the marker object is purely
  // type-level, so the value rides the primitive's runtime representation.
  // The recognizer is deliberately narrower than primitive-and-any-object:
  // runtime-bearing class, callable, indexed, and non-literal data shapes
  // remain intersections with no representation.
  if (widened.isIntersectionType()) {
    const errorMetadata = mapErrorMetadataIntersection(widened, ctx);
    if (errorMetadata) return errorMetadata;
    const brandedPrimitive = mapBrandedPrimitiveIntersection(widened, ctx);
    if (brandedPrimitive) return brandedPrimitive;
  }
  // REFINED handle intersections — @types/node's idioms: `ServerResponse<
  // IncomingMessage> & { req: IncomingMessage }` (RequestListener's
  // inferred res param — every unannotated http.createServer handler) and
  // the cast shape `Socket & { encrypted?: boolean }`. The VALUE is the
  // handle; the refinement's extra members are type-level decoration whose
  // uses fence per site (they are not stdlib members). Exactly one
  // constituent must map to an opaque builtin-handle kind; every other
  // part must be a plain object refinement — no call/construct signatures,
  // no class identity of its own.
  if (widened.isIntersectionType()) {
    const HANDLE_KINDS = new Set([
      "netServer",
      "netSocket",
      "httpReq",
      "httpRes",
      "httpClientReq",
      "dgramSocket",
      "childWriter",
      // process.stdout's own type IS the refined intersection
      // `WriteStream & { fd: 1 }` — the scalar stream kind rides the same
      // refinement rule.
      "procStream",
    ]);
    let handle: IrType | null = null;
    let refined = true;
    for (const part of ts.constituentTypes(widened)) {
      const mapped = mapType(part, ctx);
      if (mapped && HANDLE_KINDS.has(mapped.kind)) {
        if (handle !== null && handle.kind !== mapped.kind) {
          refined = false;
          break;
        }
        handle = mapped;
        continue;
      }
      const partSym = part.getSymbol();
      if (
        (part.flags & ts.TypeFlags.Object) === 0 ||
        checker.getCallSignatures(part).length > 0 ||
        checker.getConstructSignatures(part).length > 0 ||
        (partSym !== undefined && (partSym.flags & ts.SymbolFlags.Class) !== 0)
      ) {
        refined = false;
        break;
      }
    }
    if (refined && handle !== null) return handle;
    // MIXIN instance intersections (`Tagged.C & Derived` — values built
    // through a mixin result): the chain structure names the unique
    // pinned instantiation; ambiguity stays unmapped (the hook's rules).
    {
      const viaMixin = ctx.mixinIntersectionInstance?.(widened);
      if (viaMixin) {
        contextResolutions++;
        return viaMixin;
      }
    }
  }
  const classView = mapClassView(widened, ctx);
  if (classView !== undefined) return classView;
  // Class instances name a program class. The same symbol with construct
  // signatures names its static side, mapped to classval below.
  const widenedSym = widened.getSymbol();
  const classDecl = widenedSym ? widenedSym.valueDeclaration : undefined;
  if (
    classDecl &&
    (ts.isClassDeclaration(classDecl) || ts.isClassExpression(classDecl)) &&
    // Nameless class DECLARATIONS are legal only as `export default class
    // {}` — classNamer spells them "%anon" (unique per file), the same
    // name their collection registered.
    !ts.getSourceFileOfNode(classDecl).isDeclarationFile &&
    checker.getConstructSignatures(widened).length === 0 &&
    // A TypeScript class declared OUTSIDE the lowered program (reached
    // through `import type` alone) never registers, and the program can
    // hold no instance of it: its instance type maps below as the
    // structural type it describes, like an interface.
    (ctx.isProgramFile(ts.getSourceFileOfNode(classDecl)) ||
      isJsSourceFile(ts.getSourceFileOfNode(classDecl)))
  ) {
    // A JavaScript class outside the lowered program (jsdoc `typeof
    // import()` over a never-required module) stays unmappable: JSDoc
    // types are not checked, so its slots fall back to the dynamic value.
    if (!ctx.isProgramFile(ts.getSourceFileOfNode(classDecl))) return null;
    // The class inside a MIXIN function: per-call-site instantiations
    // share this one node — the CURRENT instantiation (collecting or
    // lowering) is the answer; outside any mixin context the node's type
    // stays unmapped (nothing names a call site).
    {
      const viaMixin = ctx.mixinClassInstance?.(classDecl);
      if (viaMixin) {
        contextResolutions++;
        return viaMixin;
      }
    }
    if (classExprNeedsContext(classDecl)) {
      const local = ctx.localClassInstance?.(classDecl, widened);
      if (local) contextResolutions++;
      return local ?? null;
    }
    // A GENERIC class's instance type (`Box<number>`) maps to the concrete
    // INSTANTIATION's class (`Box%0`), registered on demand — the Lowerer
    // hook owns the instance table (monomorphization by flow).
    if (classDecl.typeParameters?.nodes) {
      const instance =
        ctx.genericClassInstance?.(classDecl, widened, (argument) => mapType(argument, ctx)) ??
        null;
      // Before the generic declaration's collection turn, the hook can only
      // return its family shell; after collection the same checker type names
      // a concrete registered instance. Never memoize either phase's answer.
      if (instance !== null) contextResolutions++;
      return instance;
    }
    return { kind: "object", className: classNamer(classDecl) };
  }
  // A runtime-provided class's static side (`typeof EventEmitter`,
  // `typeof Readable`, `ErrorConstructor`): that class's value.
  {
    const runtimeClass = ctx.runtimeClassValue?.(widened);
    if (runtimeClass) return { kind: "classval", className: runtimeClass };
  }
  // The class STATIC side (`typeof C` — the class name as a value): the
  // same symbol WITH its construct signatures. Program classes only; lib
  // and package statics keep their fences.
  if (
    classDecl &&
    (ts.isClassDeclaration(classDecl) || ts.isClassExpression(classDecl)) &&
    !ts.getSourceFileOfNode(classDecl).isDeclarationFile &&
    checker.getConstructSignatures(widened).length > 0
  ) {
    if (!ctx.isProgramFile(ts.getSourceFileOfNode(classDecl))) return null;
    // The MIXIN class node's static side (`typeof C` inside the mixin):
    // the current instantiation's classval, like the instance type above.
    {
      const viaMixin = ctx.mixinClassInstance?.(classDecl);
      if (viaMixin?.kind === "object") {
        contextResolutions++;
        return { kind: "classval", className: viaMixin.className };
      }
    }
    if (classExprNeedsContext(classDecl)) {
      const ctorSigs = checker.getConstructSignatures(widened);
      const local = ctx.localClassInstance?.(
        classDecl,
        ctorSigs.length === 1 ? checker.getReturnTypeOfSignature(ctorSigs[0]!) : undefined,
      );
      if (local?.kind === "object") {
        contextResolutions++;
        return { kind: "classval", className: local.className };
      }
      return null;
    }
    // A GENERIC class's static side: only an INSTANTIATED one maps — an
    // instantiation expression's type (`Box<number>` as a value) carries a
    // construct signature returning the concrete instance, which maps to
    // the instantiation's classval. Uninstantiated `typeof Box` keeps the
    // type parameter in the construct signature's return — unmapped (the
    // family has no thunk and no single constructor ABI).
    if (classDecl.typeParameters?.nodes) {
      const ctorSigs = checker.getConstructSignatures(widened);
      if (ctorSigs.length !== 1) return null;
      const inst = mapType(checker.getReturnTypeOfSignature(ctorSigs[0]!), ctx);
      return inst?.kind === "object" ? { kind: "classval", className: inst.className } : null;
    }
    return { kind: "classval", className: classNamer(classDecl) };
  }
  // Constructor-signature TYPES (`new (…) => T`, an interface with one
  // construct signature): slots typed as constructables hold class
  // values whose instance type is T — classval of T's class. The spelled
  // signature is not part of the IR type: every value legally in the slot
  // shares the class's own completed constructor ABI (the upcast rule),
  // which is what newValue completes against. Only single-signature
  // constructables over PROGRAM class instances map; overload sets and
  // lib/package constructables stay unmapped (their fences name them).
  {
    const ctorSigs = checker.getConstructSignatures(widened);
    if (ctorSigs.length === 1 && checker.getCallSignatures(widened).length === 0) {
      const inst = mapType(checker.getReturnTypeOfSignature(ctorSigs[0]!), ctx);
      if (
        inst?.kind === "object" &&
        !RUNTIME_ERROR_CLASSES.has(inst.className) &&
        inst.className !== RUNTIME_EMITTER_CLASS &&
        !RUNTIME_STREAM_CLASSES.has(inst.className)
      ) {
        return { kind: "classval", className: inst.className };
      }
    }
    // A constructable declared in the program whose instances are not one
    // program class's (`new () => unknown`, `abstract new () => S` over a
    // record, a type that also names static members such as `{ readonly
    // schema: unknown; new (): unknown }`, construct overloads): the class
    // value rides the checked-dynamic tree, as an `unknown` slot already
    // holds one. `new` through it and static reads dispatch at run time,
    // and the constructed value checks into the signature's instance type.
    // Lib and package constructables keep their fences, and so do those of
    // fetched provenance sources (third-party code under its own policies:
    // an unused `@__PURE__` const typed `{ new (): any }` elides there).
    if (
      ctorSigs.length > 0 &&
      checker.getCallSignatures(widened).length === 0 &&
      (widened.getSymbol()?.declarations.length ?? 0) > 0 &&
      widened.getSymbol()!.declarations.every((d) => {
        const sf = ts.getSourceFileOfNode(d);
        return ctx.isProgramFile(sf) && !isProvenanceSourceFile(sf.fileName);
      })
    ) {
      return DYN;
    }
  }
  // Map<K, V>: a reference to the standard library's Map interface —
  // provenance, not the name (a user's own `interface Map` maps as a record
  // like any other). Keys are fenced to f64/string (SameValueZero hashing),
  // values to the supported kinds (see isSupportedMapValue); anything
  // outside stays unmapped — callers report the component fence (SC2009)
  // naming the offending half, as does the `new Map` lowering per site.
  const psym = widened.getSymbol();
  const isStdlibInterface = (name: string): boolean =>
    psym !== undefined &&
    ts.symbolName(psym) === name &&
    psym.declarations.some(
      (d) => ts.isInterfaceDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    );
  // The timer handles: an interface in the fallback and in @types/node 22+,
  // a class (`class Timeout implements Timer`) in @types/node 20 and older.
  const isStdlibTimerHandle = (name: string): boolean =>
    psym !== undefined &&
    ts.symbolName(psym) === name &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    );
  // The builtin Error classes: references to the lib's Error interfaces map to the runtime-provided class
  // hierarchy (provenance, not the name — a user's own `class Error`
  // resolved through the class-instance branch above, and a user
  // `interface Error` maps as a record). The '%'-prefixed IR names are the
  // RUNTIME_ERROR_CLASSES table's; the Lowerer registers the matching
  // ClassInfos eagerly, so every consumer of the class name finds them.
  for (const [irName, rec] of RUNTIME_ERROR_CLASSES) {
    if (isStdlibInterface(rec.lib)) return { kind: "object", className: irName };
  }
  // node:assert's AssertionError is declared as a class (in the shipped
  // fallback and in @types/node), not as a lib interface.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "AssertionError" &&
    psym.declarations.some(
      (d) => ts.isClassDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  )
    return { kind: "object", className: "%AssertionError" };
  // The lib's `Object` interface is a TOP type: tsc admits every
  // non-nullish value into an `Object` slot (`const x: Object = "s"`), so
  // it lowers like `unknown` (the dyn) — the same rule as `object` and
  // the empty object type, provenance-checked so a user's own `interface
  // Object` still maps as a record. Its Object.prototype member surface
  // (`x.toString()`) fences at each use site with an explicit error.
  if (isStdlibInterface("Object")) return DYN;
  // NodeJS.Module / the shipped fallback's ScriptcModule: a process-lifetime
  // scalar handle into the compiled CommonJS module registry. Module
  // identity is numeric identity; its fields are served by the dedicated
  // module lowering before generic number operations can observe the
  // representation. The node:module class's merged instance interface is
  // included, while unrelated user interfaces named Module stay structural.
  if (
    ((psym !== undefined && ts.symbolName(psym) === "ScriptcModule") ||
      (psym !== undefined && ts.symbolName(psym) === "Module")) &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        (ts.symbolName(psym) === "ScriptcModule" ||
          isDeclaredInAmbientNamespace(d, "NodeJS") ||
          isDeclaredInAmbientModule(d, "module")),
    )
  ) {
    return F64;
  }
  // events.EventEmitter: the runtime-provided emitter base class (the
  // Error-hierarchy precedent — user subclasses resolved through the
  // class-instance branch above). Both type layers declare it in the
  // "events" ambient module — the fallback as a class, @types/node as a
  // (generic) class plus a same-named interface — and @types/node's
  // NodeJS.EventEmitter interface (the structural surface net.Socket
  // et al. extend) is the same runtime value. Provenance-checked.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "EventEmitter" &&
    psym.declarations.some(
      (d) =>
        (ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        (isDeclaredInAmbientModule(d, "events") || isDeclaredInAmbientNamespace(d, "NodeJS")),
    )
  ) {
    return { kind: "object", className: RUNTIME_EMITTER_CLASS };
  }
  // readline.Interface and readline/promises.Interface: the interface
  // value is an f64 handle into the runtime's registry (the Timeout-id
  // precedent). The NAME is generic, so the provenance check adds the
  // enclosing ambient module, like net.Server.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "Interface" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        (isDeclaredInAmbientModule(d, "readline") ||
          isDeclaredInAmbientModule(d, "readline/promises")),
    )
  ) {
    return F64;
  }
  // readline.Key: emitKeys' key object stays a checked-dynamic value, so
  // it keeps Node's own shape (an undefined name, the escape sequences'
  // code member).
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "Key" &&
    psym.declarations.some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        (isDeclaredInAmbientModule(d, "readline") ||
          isDeclaredInAmbientModule(d, "readline/promises")),
    )
  ) {
    return DYN;
  }
  // readline/promises.Readline: an f64 handle the same way.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "Readline" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "readline/promises"),
    )
  ) {
    return F64;
  }
  // diagnostics_channel.Channel: the channel value is an f64 handle into
  // the runtime's channel registry (the readline.Interface precedent —
  // Node's channels are process-lived too, its WeakRef machinery aside).
  // Provenance: the name is specific enough that stdlib-file provenance
  // plus the ambient module suffices for both the fallback declarations
  // and @types/node's class Channel<StoreType, ContextType>.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "Channel" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "diagnostics_channel"),
    )
  ) {
    return F64;
  }
  // async_hooks.AsyncLocalStorage: the store value is an f64 handle into
  // the runtime's store id space (the Channel story — stores are
  // process-lived; contexts ride the fiber machinery).
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "AsyncLocalStorage" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "async_hooks"),
    )
  ) {
    return F64;
  }
  // diagnostics_channel.TracingChannel: the same f64-handle story over the
  // runtime's tracing registry (five event channels per entry).
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "TracingChannel" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "diagnostics_channel"),
    )
  ) {
    return F64;
  }
  // Node names this result; the ambient WHATWG declaration uses a type literal.
  const encodeResult =
    psym &&
    psym.declarations.some((decl) => {
      if (!ctx.isStdlibFile(ts.getSourceFileOfNode(decl))) return false;
      if (ts.isInterfaceDeclaration(decl) && decl.name.text === "EncodeIntoResult") return true;
      const parent = decl.parent;
      return (
        ts.isTypeLiteralNode(decl) &&
        parent?.kind === ts.SyntaxKind.MethodSignature &&
        parent.name &&
        ts.isIdentifier(parent.name) &&
        parent.name.text === "encodeInto" &&
        parent.parent &&
        ts.isInterfaceDeclaration(parent.parent) &&
        parent.parent.name.text === "TextEncoder"
      );
    });
  if (encodeResult)
    return {
      kind: "record",
      shapeId: ctx.shapes.intern([
        { name: "read", type: F64 },
        { name: "written", type: F64 },
      ]),
    };
  // WHATWG codec instances have ordinary reference identity and ownership.
  // Their private encoding slot is omitted from enumeration and JSON.
  if (
    ((psym !== undefined && ts.symbolName(psym) === "TextEncoder") ||
      (psym !== undefined && ts.symbolName(psym) === "TextDecoder")) &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [
          { name: `%${ts.symbolName(psym)}`, type: F64 },
          ...(ts.symbolName(psym) === "TextDecoder"
            ? [
                { name: "%fatal", type: BOOL },
                { name: "%ignoreBOM", type: BOOL },
                { name: "%state", type: DYN },
              ]
            : []),
        ],
        false,
        undefined,
        [],
      ),
    };
  }
  // string_decoder.StringDecoder: the decoder value is a two-field record
  // — the CANONICAL encoding name (construction normalizes aliases; the
  // `.encoding` property reads it) and the f64 packing the pending
  // partial sequence (the %strdec helpers' state cell). Provenance-
  // checked like Stats; construction and the write/end methods are
  // special-cased in lowerNew / lowerStringDecoderMethodCall, so the
  // record shape never surfaces.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "StringDecoder" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return {
      kind: "record",
      shapeId: ctx.shapes.intern([
        { name: "%enc", type: STRING },
        { name: "%pending", type: F64 },
      ]),
    };
  }
  // Promise.withResolvers's return type — `{ promise, resolve, reject }`
  // from the overrides declaration (or es2024's PromiseWithResolvers,
  // the same shape): a real data record, but its anonymous literal lives
  // in a declaration file, which recordProvenanceOk rightly refuses for
  // lib type worlds. Map it manually with the executor's own scriptc
  // field shapes (plain-value resolve — () => void for Promise<void> —
  // and the Error-pinned reject), so both the destructured and the
  // record-holding binding forms compile. User-declared literals with
  // these member names keep the ordinary record path (their declarations
  // are not in declaration files).
  const promiseDeclarations = psym ? psym.declarations : [];
  if (
    flags & ts.TypeFlags.Object &&
    promiseDeclarations.length > 0 &&
    promiseDeclarations.every((d) => ts.getSourceFileOfNode(d).isDeclarationFile)
  ) {
    const props = checker.getPropertiesOfType(widened);
    if (
      props.length === 3 &&
      ["promise", "resolve", "reject"].every((n) => props.some((p) => ts.symbolName(p) === n))
    ) {
      const promProp = props.find((p) => ts.symbolName(p) === "promise")!;
      const promT = mapType(checker.getTypeOfSymbol(promProp), ctx);
      if (promT?.kind === "promise") {
        const inner = promT.inner;
        return {
          kind: "record",
          shapeId: ctx.shapes.intern(
            [
              { name: "promise", type: promT },
              {
                name: "reject",
                type: {
                  kind: "func",
                  params: [{ kind: "object", className: "%Error" }],
                  ret: VOID,
                },
              },
              {
                name: "resolve",
                type: { kind: "func", params: inner.kind === "void" ? [] : [inner], ret: VOID },
              },
            ],
            false,
            undefined,
            ["promise", "resolve", "reject"],
          ),
        };
      }
    }
  }
  // NodeJS.ErrnoException (@types/node): an Error with optional
  // code/errno/syscall/path members. The VALUE is a plain runtime error
  // (fs/exec throw sites stamp `code`), so the type maps to the %Error
  // root — `err as NodeJS.ErrnoException` from an Error-typed value is a
  // no-op cast, error-typed listener params accept it, and the `.code`
  // reads have dedicated lowerings that preserve absent metadata.
  if (isStdlibInterface("ErrnoException")) return { kind: "object", className: "%Error" };
  // spawn consumes a presence-sensitive option bag, including optional
  // stdio and env values. Keep it checked-dynamic for native normalization.
  if (isStdlibInterface("SpawnOptions")) return DYN;
  // dns.LookupAllOptions (`all: true`, the overload whose callback takes
  // an address list): a lookup option bag dns.lookup reads at run time.
  // It rides checked-dynamic storage, so the lookup function type that
  // takes `LookupOneOptions | LookupAllOptions | number` compiles.
  if (isStdlibInterface("LookupAllOptions")) return DYN;
  // http.RequestOptions / https.RequestOptions as a declared type: an
  // option record whose members include functions, agents and signals.
  // Values ride checked-dynamic storage, like SpawnOptions.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "RequestOptions" &&
    psym.declarations.some((d) => {
      if (!ts.isInterfaceDeclaration(d) || !ctx.isStdlibFile(ts.getSourceFileOfNode(d)))
        return false;
      for (let p: ts.Node | undefined = d.parent; p !== undefined; p = p.parent) {
        if (ts.isModuleDeclaration(p) && ts.isStringLiteral(p.name))
          return HTTP_REQUEST_OPTION_MODULES.has(p.name.text);
      }
      return false;
    })
  )
    return DYN;

  // exactly like npm-declared types. Static fetch has one deliberately
  // narrower native representation: Response is an opaque checked-
  // dynamic capsule consumed only by the Response method lowerings, and
  // RequestInit is a checked-dynamic options object consumed by native
  // fetch. AbortSignal, response Headers, and the readable Web Streams
  // slice are native handles carried by that same checked-dynamic
  // representation. Provenance, not names: a user's own `interface
  // Response` maps as a record like any other.
  // Interface OR class declarations (the shipped fallback declares
  // interfaces; @types/node's undici-types declares Response as a class).
  {
    const alias = widened.getAliasSymbol();
    if (
      alias !== undefined &&
      ts.symbolName(alias) === "ReadableStreamReadResult" &&
      alias.declarations.some(
        (d) => ts.isTypeAliasDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
      )
    ) {
      const elemTs = widened.getAliasTypeArguments()?.[0];
      const elem =
        elemTs && elemTs.flags & ts.TypeFlags.Any ? DYN : elemTs ? mapType(elemTs, ctx) : null;
      if (!elem) return null;
      return genResultRecord(elem, VOID, ctx.shapes, ctx.unions);
    }
  }
  if (
    psym &&
    (ts.symbolName(psym) === "ReadableStreamReadValueResult" ||
      ts.symbolName(psym) === "ReadableStreamReadDoneResult") &&
    psym.declarations.some(
      (d) => ts.isInterfaceDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    const elemTs = checker.getTypeArguments(widened as ts.TypeReference)[0];
    const elem =
      elemTs && elemTs.flags & ts.TypeFlags.Any ? DYN : elemTs ? mapType(elemTs, ctx) : null;
    if (!elem) return null;
    return genResultRecord(elem, VOID, ctx.shapes, ctx.unions);
  }
  // node:net's SocketAddress and BlockList: native handles (scr_net.c)
  // whose getters and methods dispatch through the handle.
  if (
    ((psym !== undefined && ts.symbolName(psym) === "SocketAddress") ||
      (psym !== undefined && ts.symbolName(psym) === "BlockList")) &&
    psym.declarations.some(
      (d) =>
        (ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return DYN;
  }
  // WebCrypto: the crypto global and its subtle object are dynamic
  // objects, CryptoKey values are native handles (scr_webcrypto.c), and
  // the algorithm dictionaries the methods take and keys report are plain
  // checked-dynamic objects.
  if (
    psym &&
    WEBCRYPTO_DYN_TYPES.has(ts.symbolName(psym)) &&
    psym.declarations.some(
      (d) =>
        (ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return DYN;
  }
  // node:crypto's KeyObject: secret keys (scr_lib.c) and private and
  // public keys (scr_pki.c) are native handles whose getters and methods
  // dispatch through the handle. The JsonWebKey that export() returns is a
  // plain checked-dynamic object.
  if (
    ((psym !== undefined && ts.symbolName(psym) === "KeyObject") ||
      (psym !== undefined && ts.symbolName(psym) === "JsonWebKey")) &&
    psym.declarations.some(
      (d) =>
        (ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return DYN;
  }
  // node:crypto's key and signature options are plain checked-dynamic
  // objects, so a value asserted to one (`opts as
  // crypto.AsymmetricKeyExportOptions<"pem">`) reaches the call unchanged.
  if (
    psym !== undefined &&
    CRYPTO_KEY_OPTION_DYN_TYPES.has(ts.symbolName(psym)) &&
    psym.declarations.some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "crypto"),
    )
  ) {
    return DYN;
  }
  // node:crypto's Sign and Verify (createSign/createVerify): native
  // handles over the digest state (scr_pki.c).
  if (
    psym !== undefined &&
    (ts.symbolName(psym) === "Sign" || ts.symbolName(psym) === "Verify") &&
    psym.declarations.some(
      (d) =>
        ts.isClassDeclaration(d) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "crypto"),
    )
  ) {
    return DYN;
  }
  if (
    psym &&
    (FETCH_AMBIENT_TYPES as readonly string[]).includes(ts.symbolName(psym)) &&
    !(
      (ts.symbolName(psym) === "ReadableStream" || ts.symbolName(psym) === "WritableStream") &&
      psym.declarations.some(
        (d) => ts.isInterfaceDeclaration(d) && isDeclaredInAmbientNamespace(d, "NodeJS"),
      )
    ) &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return DYN;
  }
  // The stdlib Console interface (the global console and node:console
  // Console instances) is a native handle carried by the checked-dynamic
  // representation and consumed by the console method lowerings. The
  // stdlib Disposable (events.addAbortListener's result) and
  // AsyncDisposable are checked objects carrying their Symbol.dispose or
  // Symbol.asyncDispose method. A DisposableStack is a native handle whose
  // methods are function values of its checked-dynamic view.
  if (
    ((psym !== undefined && ts.symbolName(psym) === "Console") ||
      (psym !== undefined && ts.symbolName(psym) === "Disposable") ||
      (psym !== undefined && ts.symbolName(psym) === "AsyncDisposable") ||
      (psym !== undefined && ts.symbolName(psym) === "DisposableStack")) &&
    psym.declarations.some(
      (d) => ts.isInterfaceDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return DYN;
  }
  // node:crypto Cipheriv/Decipheriv values (and @types/node's per-mode
  // interfaces over them) are native handles carried by the checked-dynamic
  // representation; lowerCipherMethodCall dispatches their methods.
  if (
    psym !== undefined &&
    CIPHER_TYPE_NAMES.has(ts.symbolName(psym)) &&
    psym.declarations.some((d) => ctx.isStdlibFile(ts.getSourceFileOfNode(d)))
  ) {
    return DYN;
  }
  // node:crypto ECDH values are native handles carried by the
  // checked-dynamic representation; lowerEcdhCall dispatches their methods.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "ECDH" &&
    psym.declarations.some(
      (d) => ts.isClassDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return DYN;
  }
  // node:crypto DiffieHellman values, and @types/node's DiffieHellmanGroup
  // alias over them, are native handles carried by the checked-dynamic
  // representation; lowerDiffieHellmanCall dispatches their methods.
  {
    const dhSym = widened.getAliasSymbol() ?? psym;
    if (
      dhSym !== undefined &&
      (ts.symbolName(dhSym) === "DiffieHellman" || ts.symbolName(dhSym) === "DiffieHellmanGroup") &&
      dhSym.declarations.some(
        (d) =>
          (ts.isClassDeclaration(d) || ts.isTypeAliasDeclaration(d)) &&
          ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
      )
    ) {
      return DYN;
    }
  }
  // ReadonlyMap/ReadonlySet are the SAME runtime values as Map/Set — the
  // readonly-ness is a checker-only view (no mutating members on the
  // interface), so both map to the identical IR kinds and the read-side
  // method lowerings (.has/.get/.size/iteration) dispatch unchanged.
  if (isStdlibInterface("Map") || isStdlibInterface("ReadonlyMap")) {
    const args = checker.getTypeArguments(widened as ts.TypeReference);
    if (args.length !== 2) return null;
    const key = (args[0]!.flags & ts.TypeFlags.Any) !== 0 ? DYN : mapType(args[0]!, ctx);
    if (
      !key ||
      !isSupportedMapKey(key, key.kind === "union" ? ctx.unions.get(key.unionId)?.arms : undefined)
    )
      return null;
    const value = (args[1]!.flags & ts.TypeFlags.Any) !== 0 ? DYN : mapType(args[1]!, ctx);
    if (!value || !isSupportedMapValue(value)) return null;
    return mapOf(key, value);
  }
  // Native WeakMap keeps reference identities in checked-dynamic storage.
  // The runtime rejects reference kinds without a weak lifetime contract.
  if (isStdlibInterface("WeakMap") || isStdlibInterface("WeakSet")) return DYN;
  // FinalizationRegistry is a native handle with register and unregister.
  if (isStdlibInterface("FinalizationRegistry")) return DYN;
  // Set<T>: Map's sibling — same provenance rule and key domain.
  // Anything else stays unmapped;
  // the `new Set` lowering names the offending element type specifically.
  if (isStdlibInterface("Set") || isStdlibInterface("ReadonlySet")) {
    const args = checker.getTypeArguments(widened as ts.TypeReference);
    if (args.length !== 1) return null;
    const elem = (args[0]!.flags & ts.TypeFlags.Any) !== 0 ? DYN : mapType(args[0]!, ctx);
    if (
      !elem ||
      !isSupportedSetElem(
        elem,
        elem.kind === "union" ? ctx.unions.get(elem.unionId)?.arms : undefined,
      )
    )
      return null;
    return setOf(elem);
  }
  const collectionView = mapCollectionView(widened, ctx);
  if (collectionView) return collectionView;
  // Date: a refcounted object holding its TimeClip'd time value (ScrDate),
  // shared with the checked-dynamic Date handle, so it keeps its identity
  // through every slot and through `unknown`. Setters stay fenced.
  if (isStdlibInterface("Date")) return DATE_T;
  // RegExp: a reference to the lib RegExp interface — provenance, not the
  // name (a user's own `interface RegExp` maps as a record). Regex values
  // are literals interned as immortal statics; the kind is fenced out of
  // array elements, union arms, and Map keys/values above/below.
  if (isStdlibInterface("RegExp")) {
    return { kind: "regex" };
  }
  if (
    isStdlibInterface("Segmenter") ||
    isStdlibInterface("Segments") ||
    isStdlibInterface("SegmentData")
  )
    return DYN;
  // Typed arrays: references to the lib's Uint8Array/Uint32Array/
  // Float32Array/Float64Array interfaces (provenance, not names). The es2022+ lib
  // declares them generic over the backing buffer (`Uint8Array<ArrayBuffer>`
  // in error text) — the type argument is irrelevant here: no free-standing
  // ArrayBuffer value exists. The other TypedArray flavors stay
  // unmapped (the record path's index-signature check rejects them).
  // RegExpMatchArray (s.match's result) IS a string[] here — the honest
  // slice: [whole match, ...captures]. Nonparticipating captures use the
  // array's undefined element state; numeric access preserves that state.
  if (isStdlibInterface("RegExpMatchArray")) return arrayOf(STRING);
  // TemplateStringsArray (a tag function's first parameter): a string[] —
  // the cooked spans the templateStrings site value carries. The `.raw`
  // extra fences per member like RegExpMatchArray's `.index`/`.input`.
  if (isStdlibInterface("TemplateStringsArray")) return arrayOf(STRING);
  // RegExpExecArray (matchAll's row type): the same honest slice.
  if (isStdlibInterface("RegExpExecArray")) return arrayOf(STRING);
  // RegExpStringIterator<RegExpExecArray> (matchAll's checker result): the
  // VALUE-position spelling of the eager drain — the intrinsic already
  // materializes string[][] (lazy vs eager is unobservable: strings are
  // immutable and the spec clones the regex at the call), so a stored
  // `const urlMatches = output.matchAll(re)` types as exactly that array.
  if (isStdlibInterface("RegExpStringIterator")) return arrayOf(arrayOf(STRING));
  // NodeJS.Timeout / the fallback `Timeout` interface (setTimeout's return)
  // maps to F64 — the numeric timer handle. The `.ref`/`.unref`/`.hasRef`
  // methods lower over that handle (loop-liveness bookkeeping); `Timeout |
  // null` becomes `number | null`, and clearTimeout/clearInterval take the
  // handle. Provenance-checked like the other named interfaces.
  if (isStdlibTimerHandle("Timeout")) return F64;
  // NodeJS.Immediate / the fallback `Immediate` (setImmediate's return):
  // the same numeric-handle story over the check-phase queue — its own id
  // space, so clearTimeout of an Immediate no-ops like Node.
  if (isStdlibTimerHandle("Immediate")) return F64;
  if (
    isStdlibInterface("ArrayBuffer") ||
    isStdlibInterface("SharedArrayBuffer") ||
    isStdlibInterface("PropertyDescriptor") ||
    isStdlibInterface("ProcessVersions") ||
    isStdlibInterface("ProcessRelease")
  )
    return DYN;
  if (Object.values(BYTES_ELEMENT_NAME).some((name) => isStdlibInterface(`${name}Constructor`)))
    return DYN;
  if (isStdlibInterface("Uint8Array")) return bytesOf("u8");
  if (isStdlibInterface("Uint32Array")) return bytesOf("u32");
  if (isStdlibInterface("Uint8ClampedArray")) return bytesOf("u8c");
  if (isStdlibInterface("Int8Array")) return bytesOf("i8");
  if (isStdlibInterface("Uint16Array")) return bytesOf("u16");
  if (isStdlibInterface("Int16Array")) return bytesOf("i16");
  // Int32Array: the signed 32-bit kind (element reads sign-extend, writes
  // ToInt32-wrap) — the Atomics.wait sleep idiom constructs one over a
  // SharedArrayBuffer, and the i32 semantics hold for every other use.
  if (isStdlibInterface("Int32Array")) return bytesOf("i32");
  if (isStdlibInterface("Float16Array")) return bytesOf("f16");
  if (isStdlibInterface("Float32Array")) return bytesOf("f32");
  if (isStdlibInterface("Float64Array")) return bytesOf("f64");
  // DataView: the ONE view kind — a u8 bytes value whose runtime
  // representation borrows (aliases) its owner's storage, so reads through
  // it see writes to the source exactly like JS. The checker keeps the
  // DataView and typed-array member surfaces apart; at the IR level both
  // are bytes<u8>.
  if (isStdlibInterface("DataView")) return bytesOf("u8");
  // Node's Buffer IS a Uint8Array subclass — ONE runtime representation
  // (the u8 bytes kind). Declared `interface Buffer` by the shipped
  // fallback and by @types/node (whose NonSharedBuffer alias resolves to
  // the same symbol); provenance-checked like URL.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "Buffer" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return bytesOf("u8");
  }
  // URL: the WHATWG URL instance type — declared as a global `interface
  // URL` (the shipped fallback, and @types/node's globals) AND as `class
  // URL` in @types/node's "url" module (`new URL(x)` types as the class's
  // instance type). Provenance, not the name: a user's own URL maps as a
  // record/class like any other.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "URL" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return { kind: "url" };
  }
  // URLSearchParams: the WHATWG live query view — declared as a global
  // interface by the shipped fallback and by @types/node (plus `class
  // URLSearchParams` in the "url" module). Provenance-checked like URL.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "URLSearchParams" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return { kind: "searchParams" };
  }
  // fs.Stats: @types/node's `class Stats` (module "fs") or the fallback
  // declarations' interface. Provenance-checked like URL.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "Stats" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return { kind: "stats" };
  }
  // Capacity snapshots and options keep their live object representation
  // across numeric/BigInt overloads, runtime options, and callbacks.
  if (
    ((psym !== undefined && ts.symbolName(psym) === "StatsFs") ||
      (psym !== undefined && ts.symbolName(psym) === "BigIntStatsFs") ||
      (psym !== undefined && ts.symbolName(psym) === "StatFsOptions")) &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "fs"),
    )
  )
    return DYN;
  if (isWorkerHandleSymbol(psym, ctx)) return DYN;
  // fs/promises.FileHandle: an owned descriptor object. Module provenance
  // distinguishes it from user interfaces with the same name; both the
  // fallback and @types/node declare it in "fs/promises".
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "FileHandle" &&
    psym.declarations.some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "fs/promises"),
    )
  ) {
    return { kind: "fileHandle" };
  }
  // fs.Dir: an open directory stream, declared in "fs" by both the
  // fallback and @types/node.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "Dir" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "fs"),
    )
  ) {
    return { kind: "dir" };
  }
  // child_process.SpawnSyncReturns: @types/node's generic interface (the
  // Buffer/string split is re-checked at the stdout/stderr READ — status
  // reads work either way) or the fallback declarations' plain interface.
  // Provenance-checked like Stats.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "SpawnSyncReturns" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return { kind: "spawnRes" };
  }
  // child_process.ChildProcess and @types/node's stdio-refined return
  // interfaces: all carry the same runtime child handle; the generic
  // refinements only tell the checker which stdio properties are null.
  if (
    psym !== undefined &&
    (ts.symbolName(psym) === "ChildProcess" ||
      ts.symbolName(psym) === "ChildProcessWithoutNullStreams" ||
      ts.symbolName(psym) === "ChildProcessByStdio") &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "child_process"),
    )
  ) {
    return { kind: "child" };
  }
  // net.Server / net.Socket: @types/node's classes or the fallback
  // declarations' interfaces. The NAME is ambiguous across builtin
  // modules (http.Server, tls.Socket share it), so the provenance check
  // adds the ENCLOSING AMBIENT MODULE: both @types/node and the fallback
  // declare these inside `declare module "net"` — a declaration outside
  // that module (http's Server) stays unmapped and fences at its use
  // site.
  if (
    ((psym !== undefined && ts.symbolName(psym) === "Server") ||
      (psym !== undefined && ts.symbolName(psym) === "Socket") ||
      (psym !== undefined && ts.symbolName(psym) === "TLSSocket")) &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        (isDeclaredInAmbientModule(d, "net") ||
          // http.Server extends net.Server in @types/node — and tls.Server
          // / https.Server extend it transitively: same lowered surface
          // (listen/close/address/'error'), same handle kind. tls.TLSSocket
          // extends net.Socket the same way: post-handshake it IS a net
          // socket to every lowered member.
          (ts.symbolName(psym) === "Server" &&
            (isDeclaredInAmbientModule(d, "http") ||
              isDeclaredInAmbientModule(d, "tls") ||
              isDeclaredInAmbientModule(d, "https"))) ||
          (ts.symbolName(psym) === "TLSSocket" && isDeclaredInAmbientModule(d, "tls"))),
    )
  ) {
    return ts.symbolName(psym) === "Server" ? { kind: "netServer" } : { kind: "netSocket" };
  }
  // tls.SecureContext: the opaque parsed-cert/key handle SNI callbacks
  // answer with (tls.createSecureContext({ cert, key }) mints it; the TLS
  // server's handshake consumes it). Module-checked like net.Server —
  // @types/node declares `interface SecureContext` inside `declare module
  // "tls"`, and the shipped fallback mirrors it.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "SecureContext" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "tls"),
    )
  ) {
    return { kind: "secureCtx" };
  }
  // Scrypt's runtime options retain property accessors and aliases. Use
  // checked values so presence probes and repeated getter reads match Node.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "ScryptOptions" &&
    psym.declarations.some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "crypto"),
    )
  )
    return DYN;
  // crypto.Hash / crypto.Hmac: native incremental digest handles. Keep
  // provenance module-qualified so user classes with these common names
  // retain their ordinary structural/class representation.
  if (
    ((psym !== undefined && ts.symbolName(psym) === "Hash") ||
      (psym !== undefined && ts.symbolName(psym) === "Hmac")) &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "crypto"),
    )
  ) {
    return ts.symbolName(psym) === "Hash" ? CRYPTOHASH_T : CRYPTOHMAC_T;
  }
  // fs.FSWatcher: the fs.watch handle (scr_watch.c). Module-checked like
  // net.Server — @types/node declares `interface FSWatcher extends
  // EventEmitter` inside `declare module "fs"`, and the shipped fallback
  // mirrors it.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "FSWatcher" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "fs"),
    )
  ) {
    return { kind: "fsWatcher" };
  }
  // The piped child-output stream, under BOTH spellings @types/node uses
  // for it: stream.Readable (ChildProcess.stdout's declared type — the
  // class inside `declare module "stream"`) and NodeJS.ReadableStream
  // (the global-namespace interface real code writes in its own
  // signatures — the portless prefixStream/NgrokChildProcess idiom). In
  // a static program every value of either type ARISES from
  // child.stdout/stderr — anything else producing one fences at its
  // producing site. The NodeJS namespace check keeps the web
  // ReadableStream (undici-types' whatwg stream, generic, no ambient
  // namespace) unmapped.
  // The process output streams as first-class VALUES, under the two
  // spellings @types/node uses: tty.WriteStream (process.stdout's own
  // intersection base — `WriteStream & { fd: 1 }` resolves through the
  // handle-refinement path below) and NodeJS.WritableStream (the
  // global-namespace interface real code writes in its own signatures —
  // prefixStream's `output` param). The representation is the raw fd
  // scalar; the lowered surface is write(string).
  // Under the program's general stream representation (generalNodeStreams)
  // NodeJS.WritableStream is the runtime Writable instead: the process
  // streams convert into it where they flow (process.stdioWritable).
  // Checked-dynamic stream slots: an intersection over a NodeJS stream
  // interface (`NodeJS.ReadableStream & { destroy?(): void }`) holds the
  // same values as the interface.
  if (
    ctx.dynNodeStreams === true &&
    (type.flags & ts.TypeFlags.Intersection) !== 0 &&
    ts.constituentTypes(type).some((part) => {
      const sym = part.getSymbol();
      return (
        ((sym !== undefined && ts.symbolName(sym) === "ReadableStream") ||
          (sym !== undefined && ts.symbolName(sym) === "WritableStream")) &&
        sym.declarations.some(
          (d) =>
            ts.isInterfaceDeclaration(d) &&
            ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
            isDeclaredInAmbientNamespace(d, "NodeJS"),
        )
      );
    })
  ) {
    return DYN;
  }
  const nodeWritableInterface =
    psym !== undefined &&
    ts.symbolName(psym) === "WritableStream" &&
    psym.declarations.some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientNamespace(d, "NodeJS"),
    );
  if (nodeWritableInterface && ctx.generalNodeStreams === true) {
    return ctx.dynNodeStreams === true ? DYN : { kind: "object", className: "%Writable" };
  }
  if (
    (psym !== undefined &&
      ts.symbolName(psym) === "WriteStream" &&
      psym.declarations.some(
        (d) =>
          (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
          ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
          (isDeclaredInAmbientModule(d, "tty") ||
            (isDeclaredInAmbientModule(d, "process") && isDeclaredInAmbientNamespace(d, "NodeJS"))),
      )) ||
    nodeWritableInterface
  ) {
    return PROCSTREAM_T;
  }
  // A piped child stdin writer. The fallback declarations give it the
  // dedicated ChildStdin name; @types/node spells the same value as
  // stream.Writable. As with stream.Readable below, unsupported producers
  // of the broad @types class fence where they are constructed.
  if (
    (psym !== undefined &&
      ts.symbolName(psym) === "ChildStdin" &&
      ctx.generalNodeStreams !== true &&
      psym.declarations.some(
        (d) =>
          ts.isInterfaceDeclaration(d) &&
          ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
          isDeclaredInAmbientModule(d, "child_process"),
      )) ||
    (psym !== undefined &&
      ts.symbolName(psym) === "Writable" &&
      ctx.generalNodeStreams !== true &&
      psym.declarations.some(
        (d) =>
          (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
          ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
          isNodeTypesPath(ts.getSourceFileOfNode(d).fileName) &&
          isDeclaredInAmbientModule(d, "stream"),
      ))
  ) {
    return { kind: "childWriter" };
  }
  // Under the general stream representation the fallback declarations'
  // ChildStdin is the runtime Writable too (child.stdioStream bridges it).
  if (
    ctx.generalNodeStreams === true &&
    psym !== undefined &&
    ts.symbolName(psym) === "ChildStdin" &&
    psym.declarations.some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "child_process"),
    )
  ) {
    return { kind: "object", className: "%Writable" };
  }
  // The static node:stream classes (the shipped fallback declarations —
  // NOT @types/node, whose stream.Readable also types child stdio; under
  // @types/node the childStream mapping below keeps priority and the
  // static stream classes stand down). Checked BEFORE the childStream
  // branch: the fallback's Readable must map to the runtime class, and
  // under the fallback child.stdout is NodeJS.ReadableStream (its own
  // branch below), so the two never collide.
  // @types/node's Duplex/Transform/PassThrough classes have no child-stdio
  // reading, so they map to the runtime classes too; its Readable and
  // Writable join them under the general representation.
  for (const [irName, rec] of RUNTIME_STREAM_CLASSES) {
    if (
      psym !== undefined &&
      ts.symbolName(psym) === rec.lib &&
      psym.declarations.some(
        (d) =>
          ts.isClassDeclaration(d) &&
          ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
          (!isNodeTypesPath(ts.getSourceFileOfNode(d).fileName) ||
            ctx.generalNodeStreams === true ||
            (rec.lib !== "Readable" && rec.lib !== "Writable")) &&
          isDeclaredInAmbientModule(d, "stream"),
      )
    ) {
      return { kind: "object", className: irName };
    }
  }
  // node:zlib's stream classes (the shipped fallback declarations and
  // @types/node's): their instances are runtime Transform streams.
  if (
    psym !== undefined &&
    ZLIB_STREAM_MODES.has(ts.symbolName(psym)) &&
    psym.declarations.some(
      (d) =>
        (ts.isClassDeclaration(d) ||
          (ts.isInterfaceDeclaration(d) && isNodeTypesPath(ts.getSourceFileOfNode(d).fileName))) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "zlib"),
    )
  ) {
    return { kind: "object", className: "%Transform" };
  }
  // fs.ReadStream / fs.WriteStream (the shipped fallback declarations and
  // @types/node's): their instances are runtime Readable / Writable
  // streams (scr_fs_stream.c).
  if (
    ((psym !== undefined && ts.symbolName(psym) === "ReadStream") ||
      (psym !== undefined && ts.symbolName(psym) === "WriteStream")) &&
    psym.declarations.some(
      (d) =>
        ts.isClassDeclaration(d) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "fs"),
    )
  ) {
    return {
      kind: "object",
      className: ts.symbolName(psym) === "ReadStream" ? "%Readable" : "%Writable",
    };
  }
  if (
    (psym !== undefined &&
      ts.symbolName(psym) === "Readable" &&
      psym.declarations.some(
        (d) =>
          (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
          ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
          isDeclaredInAmbientModule(d, "stream"),
      )) ||
    (psym !== undefined &&
      ts.symbolName(psym) === "ReadableStream" &&
      psym.declarations.some(
        (d) =>
          ts.isInterfaceDeclaration(d) &&
          ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
          isDeclaredInAmbientNamespace(d, "NodeJS"),
      ))
  ) {
    // The general representation: the runtime Readable, which child
    // stdio reads produce through the child stream bridge. With
    // checked-dynamic stream slots, NodeJS.ReadableStream holds any
    // stream value (dyn-streams.ts); stream.Readable keeps the class.
    if (ctx.generalNodeStreams === true) {
      if (ctx.dynNodeStreams === true && ts.symbolName(psym) === "ReadableStream") return DYN;
      return { kind: "object", className: "%Readable" };
    }
    return { kind: "childStream" };
  }
  // dgram.Socket: the same ambiguous "Socket" name disambiguated by its
  // enclosing ambient module — @types/node's `class Socket extends
  // EventEmitter` and the fallback declarations' interface both live
  // inside `declare module "dgram"`.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "Socket" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "dgram"),
    )
  ) {
    return { kind: "dgramSocket" };
  }
  // node:test's TestContext — the test-body parameter (`test('x', (t) =>
  // ...)`) — and SuiteContext, the describe-body and suite-hook parameter:
  // both are the runner's node for the test or suite. @types/node's
  // classes and the fallback declarations' interfaces all live inside
  // `declare module "node:test"` (isDeclaredInAmbientModule answers for
  // both spellings).
  if (
    ((psym !== undefined && ts.symbolName(psym) === "TestContext") ||
      (psym !== undefined && ts.symbolName(psym) === "SuiteContext")) &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "test"),
    )
  ) {
    return { kind: "testCtx" };
  }
  // node:test's MockFunctionContext<F> and MockFunctionCall<F>: compiler
  // records built from F (mock-shapes.ts). Mock<F> then maps as the hybrid
  // { %call: F, mock } record through mapHybridCallableIntersection.
  if (
    ((psym !== undefined && ts.symbolName(psym) === "MockFunctionContext") ||
      (psym !== undefined && ts.symbolName(psym) === "MockFunctionCall")) &&
    psym.declarations.some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "test"),
    )
  ) {
    const fnTs = checker.getTypeArguments(widened as ts.TypeReference)[0];
    const fn = fnTs ? mapType(fnTs, ctx) : null;
    if (!fn || fn.kind !== "func") return null;
    return ts.symbolName(psym) === "MockFunctionContext"
      ? mockContextType(fn, ctx)
      : mockCallRecordType(fn, ctx);
  }
  // NodeJS.ErrnoException: @types/node's `interface ErrnoException extends
  // Error` (dns/fs callback error types). It IS an Error at runtime — map
  // it to the runtime %Error hierarchy like the lib Error interfaces
  // above; optional metadata uses the same checked property view.
  // Provenance-checked like the rest.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "ErrnoException" &&
    psym.declarations.some(
      (d) => ts.isInterfaceDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return { kind: "object", className: "%Error" };
  }
  // http.Agent / https.Agent — the Agent VALUE is a checked-dynamic
  // handle (new http.Agent lowers to the dyn handle whose members
  // dispatch through the handle ops), so the TYPE maps to dyn: a typed
  // binding, parameter, or field carrying an Agent stays usable instead
  // of fencing at the declaration. Module-checked like the rest (https'
  // Agent extends http's; both live in their ambient modules).
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "Agent" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        (isDeclaredInAmbientModule(d, "http") || isDeclaredInAmbientModule(d, "https")),
    )
  ) {
    return { kind: "dyn" };
  }
  // http.IncomingMessage / http.ServerResponse — module-checked like
  // net.Server (the names repeat nowhere today, but provenance stays the
  // rule).
  if (
    ((psym !== undefined && ts.symbolName(psym) === "IncomingMessage") ||
      (psym !== undefined && ts.symbolName(psym) === "ServerResponse")) &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "http"),
    )
  ) {
    return ts.symbolName(psym) === "IncomingMessage" ? { kind: "httpReq" } : { kind: "httpRes" };
  }
  // http2's compatibility surface (the allowHTTP1 lowering): the secure
  // server IS a net server (listen/close/address/emit ride the same
  // handle), and Http2ServerRequest/Response ARE the http req/res kinds —
  // every connection the lowering accepts is HTTP/1.1, exactly the case
  // where Node hands the compatibility objects the http.IncomingMessage /
  // ServerResponse surface. h2-only members (stream, session) fence per
  // member at their use sites (lower-server.ts). Module-checked like the
  // rest.
  if (
    ((psym !== undefined && ts.symbolName(psym) === "Http2SecureServer") ||
      (psym !== undefined && ts.symbolName(psym) === "Http2ServerRequest") ||
      (psym !== undefined && ts.symbolName(psym) === "Http2ServerResponse")) &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "http2"),
    )
  ) {
    return ts.symbolName(psym) === "Http2SecureServer"
      ? { kind: "netServer" }
      : ts.symbolName(psym) === "Http2ServerRequest"
        ? { kind: "httpReq" }
        : { kind: "httpRes" };
  }
  // The REAL h2 surface (scr_http2.c): the h2c server is a net server
  // like the secure one; sessions and streams are first-class handle
  // kinds (client and server flavors share a kind — the runtime handle
  // carries the role). Module-checked like the rest.
  if (
    ((psym !== undefined && ts.symbolName(psym) === "Http2Server") ||
      (psym !== undefined && ts.symbolName(psym) === "Http2Session") ||
      (psym !== undefined && ts.symbolName(psym) === "ClientHttp2Session") ||
      (psym !== undefined && ts.symbolName(psym) === "ServerHttp2Session") ||
      (psym !== undefined && ts.symbolName(psym) === "ClientHttp2Stream") ||
      (psym !== undefined && ts.symbolName(psym) === "ServerHttp2Stream")) &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "http2"),
    )
  ) {
    return ts.symbolName(psym) === "Http2Server"
      ? { kind: "netServer" }
      : ts.symbolName(psym) === "ClientHttp2Stream" || ts.symbolName(psym) === "ServerHttp2Stream"
        ? { kind: "http2Stream" }
        : { kind: "http2Session" };
  }
  // http.ClientRequest (http.request/http.get results) — module-checked
  // like IncomingMessage.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "ClientRequest" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "http"),
    )
  ) {
    return { kind: "httpClientReq" };
  }
  // NodeJS.ProcessEnv: @types/node's interface (Dict<string> plus a TZ?
  // member) maps to the PURE index-signature shape it structurally is —
  // `{ [k: string]: string | undefined }` (TZ is just another
  // string-or-undefined key and reads through the overflow like the rest).
  // What makes `process.env` as a VALUE representable (the snapshot
  // record) and ProcessEnv-typed parameters mappable. The fallback
  // declarations' anonymous env type takes the pureIndexShape path below
  // and interns the SAME shape.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "ProcessEnv" &&
    psym.declarations.some(
      (d) => ts.isInterfaceDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    const value = withUndefinedArm(STRING, ctx.unions);
    if (!value) return null;
    return { kind: "record", shapeId: ctx.shapes.intern([], false, value, []) };
  }
  // Promise<T>: a reference to the lib Promise interface. The inner type
  // maps recursively; promise-of-unmappable stays unmappable.
  if (isStdlibInterface("Promise")) {
    const arg = checker.getTypeArguments(widened as ts.TypeReference)[0];
    if (!arg) return null;
    // Promise<never> — a throw-only async function's inference. Like sync
    // `never` in return position (declaredReturnType), the honest reading
    // is "void with a stronger guarantee": the promise only ever rejects,
    // so no await can observe a fulfillment value. `never` VALUES outside
    // a promise stay unmapped.
    if (arg.flags & ts.TypeFlags.Never) return { kind: "promise", inner: VOID };
    // Promise<any> in a STATIC build (untyped JS entries: `new
    // Promise((resolve) => ...)` infers any): the settled value rides the
    // dyn arm exactly like Promise<unknown> — every use of the awaited
    // value is checked-dynamic, the same checks `unknown` gets.
    if (arg.flags & ts.TypeFlags.Any) return { kind: "promise", inner: DYN };
    const inner = mapType(arg, ctx);
    if (!inner) return null;
    return { kind: "promise", inner };
  }
  // Native collection iterators use checked runtime iterator objects.
  if (isStdlibInterface("MapIterator") || isStdlibInterface("SetIterator")) return DYN;
  // Array iterators (`list.values()` and friends) are generators over the
  // live array: each step reads the current length and element. String
  // iterators (`s[Symbol.iterator]()`) are generators over the code points.
  if (isStdlibInterface("ArrayIterator") || isStdlibInterface("StringIterator")) {
    const arg = checker.getTypeArguments(widened as ts.TypeReference)[0];
    const yieldT = arg ? mapType(arg, ctx) : null;
    if (!yieldT || yieldT.kind === "void" || isUnitType(yieldT)) return null;
    if (!genResultRecord(yieldT, VOID, ctx.shapes, unions)) return null;
    return { kind: "generator", yieldT, retT: VOID, nextT: UNDEFINED_T };
  }
  // Generator<T, TReturn, TNext>, AsyncGenerator<T, TReturn, TNext> (and
  // the lib's IterableIterator<T, ...>, the older sync annotation spelling):
  // the generator kind. Channel normalization keeps the runtime honest:
  //   yield channel  — T must be a real value type (a generator that could
  //                    only yield undefined has no C value form); `never`
  //                    (a generator that never yields) rides the VOID
  //                    sentinel — the suspended branch is unreachable.
  //   return channel — void/undefined/never carry no value (VOID: the
  //                    done-value is the undefined arm); any/unknown ride
  //                    dyn; else the mapped type.
  //   next channel   — void/undefined/never mean valueless resumes (the
  //                    undefined UNIT: `.next()` sends nothing, yields are
  //                    statement-position); any/unknown ride dyn (`.next(v)`
  //                    boxes; the yield expression reads checked-dynamic);
  //                    else the mapped type (`.next(v)` requires its
  //                    argument — fenced at the call).
  // Mixed dyn/concrete value channels share checked storage, so either
  // branch of the result record has the same representation. A number,
  // boolean or string channel keeps its own type beside a dyn one (the
  // `Generator<number>` default), and so does a record yield channel beside
  // a dyn return (`IterableIterator<Row>`): its values ride OUT typed and box
  // only when the result record is built, so for-of and spread read them
  // back unchecked.
  if (
    isStdlibInterface("Generator") ||
    isStdlibInterface("AsyncGenerator") ||
    isStdlibInterface("IterableIterator") ||
    // An Iterator<T> annotation holds a single-pass iterator object: a
    // generator, or a native iterator adapted into one.
    isStdlibInterface("Iterator") ||
    // IteratorObject<T> is what the iterator helpers return: a helper
    // generator over its source (containers/iterator-helpers.ts).
    isStdlibInterface("IteratorObject")
  ) {
    const args = checker.getTypeArguments(widened as ts.TypeReference);
    const channels = genChannels(args[0], args[1], args[2], ctx);
    if (!channels) return null;
    // The result record must exist too (its union must be legal), or
    // `.next()` could never answer — mapped generators always resume.
    if (!genResultRecord(channels.yieldT, channels.retT, ctx.shapes, unions)) return null;
    return {
      kind: "generator",
      ...(isStdlibInterface("AsyncGenerator") ? { async: true as const } : {}),
      ...channels,
    };
  }
  // Iterable<T>: the iterable union (iterableUnionType) — the source value
  // itself in its own arm, so an array stays the same multi-pass object and
  // a generator stays single-pass.
  if (isStdlibInterface("Iterable")) {
    const arg = checker.getTypeArguments(widened as ts.TypeReference)[0];
    const elem = arg ? mapType(arg, ctx) : null;
    return elem ? iterableUnionType(elem, ctx.shapes, unions) : null;
  }
  // IteratorResult<T, TReturn> — the checker's type of `g.next()` (an
  // alias for IteratorYieldResult<T> | IteratorReturnResult<TReturn>):
  // maps to the SAME interned record genResume answers, so `const r =
  // g.next()` binds without an annotation and reads flow.
  {
    const alias = widened.getAliasSymbol();
    if (
      alias !== undefined &&
      ts.symbolName(alias) === "IteratorResult" &&
      alias.declarations.some(
        (d) => ts.isTypeAliasDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
      )
    ) {
      const targs = widened.getAliasTypeArguments() ?? [];
      const channels = genChannels(targs[0], targs[1], undefined, ctx);
      if (!channels) return null;
      return genResultRecord(channels.yieldT, channels.retT, ctx.shapes, unions);
    }
  }
  // PromiseSettledResult<T>'s parts: the lib's PromiseFulfilledResult<T> /
  // PromiseRejectedResult interfaces map to the records { status, value }
  // and { status, reason } (the reason is `any`, a dyn slot), interned
  // explicitly. The settled union is a two-record union discriminated by
  // the `status` literals, so `r.status === "fulfilled"` narrows to the
  // arm that reads `value`.
  // net/dgram AddressInfo and dgram RemoteInfo: stdlib interfaces over
  // data properties, interned EXPLICITLY (the record path's provenance
  // fence keeps .d.ts shapes out of the structural walk — the
  // PromiseFulfilledResult precedent). RemoteInfo's 'IPv4' | 'IPv6'
  // family widens to string here; the runtime only ever answers "IPv4"
  // (udp4 is the one lowered socket type).
  // dns.lookup's all: true entries: { address, family }.
  if (isStdlibInterface("LookupAddress")) {
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [
          { name: "address", type: STRING },
          { name: "family", type: F64 },
        ],
        false,
        undefined,
        ["address", "family"],
      ),
    };
  }
  // tlsSocket.getCipher()'s { name, standardName, version }.
  if (isStdlibInterface("CipherNameAndProtocol")) {
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [
          { name: "name", type: STRING },
          { name: "standardName", type: STRING },
          { name: "version", type: STRING },
        ],
        false,
        undefined,
        ["name", "standardName", "version"],
      ),
    };
  }
  // child_process.ExecFileSyncOptionsWithStringEncoding: the exec-options
  // interface interned explicitly on the AddressInfo pattern, so a TYPED
  // options value (`const commandOptions: ExecFileSyncOptions... = {...}`,
  // a runner function's options parameter) flows to execFileSync/execSync
  // as a runtime record — the windows-ca command-runner idiom. The fields
  // are the members the exec lowering honestly implements: encoding
  // (required — the "WithStringEncoding" refinement), cwd/input/timeout,
  // stdio (the "pipe"/"ignore" string or 3-tuple forms — a runtime array
  // is string[]; unsupported runtime modes throw at the call), and the
  // accepted-but-inert maxBuffer/windowsHide. Members outside this set
  // (env, killSignal, shell, uid, ...) keep the shape unmatched — their
  // literals fence at the shape check instead of being dropped without a
  // diagnostic.
  if (isStdlibInterface("ExecFileSyncOptionsWithStringEncoding")) {
    const optStr = withUndefinedArm(STRING, ctx.unions);
    const optNum = withUndefinedArm(F64, ctx.unions);
    const optBool = withUndefinedArm(BOOL, ctx.unions);
    const stdioArms = [arrayOf(STRING), STRING, UNDEFINED_T].sort((a, b) =>
      typeKey(a) < typeKey(b) ? -1 : 1,
    );
    const stdio: IrType = { kind: "union", unionId: ctx.unions.intern(stdioArms) };
    if (!optStr || !optNum || !optBool) return null;
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [
          { name: "cwd", type: optStr },
          { name: "encoding", type: STRING },
          { name: "input", type: optStr },
          { name: "maxBuffer", type: optNum },
          { name: "stdio", type: stdio },
          { name: "timeout", type: optNum },
          { name: "windowsHide", type: optBool },
        ],
        false,
        undefined,
        ["encoding", "cwd", "input", "timeout", "stdio", "maxBuffer", "windowsHide"],
      ),
    };
  }
  if (isStdlibInterface("AddressInfo")) {
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [
          { name: "address", type: STRING },
          { name: "family", type: STRING },
          { name: "port", type: F64 },
        ],
        false,
        undefined,
        ["address", "family", "port"],
      ),
    };
  }
  // net's 'drop' payload: the record the runtime's address object checks
  // into, each optional field with its declared type.
  if (isStdlibInterface("DropArgument")) {
    const known = [
      "localAddress",
      "localPort",
      "localFamily",
      "remoteAddress",
      "remotePort",
      "remoteFamily",
    ];
    const fields: { name: string; type: IrType }[] = [];
    for (const property of checker.getPropertiesOfType(widened)) {
      if (!known.includes(ts.symbolName(property))) return null;
      const type = mapType(checker.getTypeOfSymbol(property), ctx);
      if (!type) return null;
      fields.push({ name: ts.symbolName(property), type });
    }
    const order = fields.map((field) => field.name);
    fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { kind: "record", shapeId: ctx.shapes.intern(fields, false, undefined, order) };
  }
  // crypto.getCipherInfo's result is Node's info object itself, read as a
  // checked-dynamic value: Node leaves out the fields a cipher lacks,
  // including the nid the declaration requires, so a record cannot hold
  // every result.
  if (
    isStdlibInterface("CipherInfo") &&
    psym!.declarations.some(
      (d) => ts.isInterfaceDeclaration(d) && isDeclaredInAmbientModule(d, "crypto"),
    )
  )
    return DYN;
  // Filesystem options are data records. Keep their declared optional fields
  // instead of allowing arbitrary standard-library interfaces into records.
  if (
    ((psym !== undefined && ts.symbolName(psym) === "FileReadOptions") ||
      (psym !== undefined && ts.symbolName(psym) === "ReadOptions") ||
      (psym !== undefined && ts.symbolName(psym) === "ReadOptionsWithBuffer") ||
      (psym !== undefined && ts.symbolName(psym) === "WriteOptions")) &&
    psym.declarations.some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        (isDeclaredInAmbientModule(d, "fs/promises") || isDeclaredInAmbientModule(d, "fs")),
    )
  ) {
    const fields: { name: string; type: IrType }[] = [];
    for (const property of checker.getPropertiesOfType(widened)) {
      if (!["buffer", "offset", "length", "position"].includes(ts.symbolName(property)))
        return null;
      const type = mapType(checker.getTypeOfSymbol(property), ctx);
      if (!type) return null;
      fields.push({ name: ts.symbolName(property), type });
    }
    const order = fields.map((field) => field.name);
    fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { kind: "record", shapeId: ctx.shapes.intern(fields, false, undefined, order) };
  }
  // fs/promises FileReadResult<T> / FileWriteResult<T>: the two-field
  // null-prototype objects returned by FileHandle.read/write. The native
  // record does not model the prototype (unobservable through the lowered
  // surface); it preserves the caller buffer/string by reference.
  if (
    ((psym !== undefined && ts.symbolName(psym) === "FileReadResult") ||
      (psym !== undefined && ts.symbolName(psym) === "FileWriteResult") ||
      (psym !== undefined && ts.symbolName(psym) === "FileReadvResult") ||
      (psym !== undefined && ts.symbolName(psym) === "FileWritevResult") ||
      (psym !== undefined && ts.symbolName(psym) === "ReadVResult") ||
      (psym !== undefined && ts.symbolName(psym) === "WriteVResult")) &&
    psym.declarations.some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        (isDeclaredInAmbientModule(d, "fs/promises") ||
          ((ts.symbolName(psym) === "ReadVResult" || ts.symbolName(psym) === "WriteVResult") &&
            isDeclaredInAmbientModule(d, "fs"))),
    )
  ) {
    const args = checker.getTypeArguments(widened as ts.TypeReference);
    if (args.length !== 1) return null;
    const vector =
      ts.symbolName(psym) === "FileReadvResult" ||
      ts.symbolName(psym) === "FileWritevResult" ||
      ts.symbolName(psym) === "ReadVResult" ||
      ts.symbolName(psym) === "WriteVResult";
    const emptyVector =
      vector &&
      checker.isArrayType(args[0]!) &&
      (checker.getTypeArguments(args[0]! as ts.TypeReference)[0]!.flags & ts.TypeFlags.Never) !== 0;
    const payload = emptyVector ? arrayOf(bytesOf("u8")) : mapType(args[0]!, ctx);
    if (
      !payload ||
      (vector
        ? !(payload.kind === "array" && payload.elem.kind === "bytes" && payload.elem.elem === "u8")
        : !(payload.kind === "string" || (payload.kind === "bytes" && payload.elem === "u8")))
    ) {
      return null;
    }
    const count =
      ts.symbolName(psym) === "FileReadResult" ||
      ts.symbolName(psym) === "FileReadvResult" ||
      ts.symbolName(psym) === "ReadVResult"
        ? "bytesRead"
        : "bytesWritten";
    const payloadName = vector ? "buffers" : "buffer";
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [
          { name: payloadName, type: payload },
          { name: count, type: F64 },
        ],
        false,
        undefined,
        [count, payloadName],
      ),
    };
  }
  // fs.Dirent (readdirSync's withFileTypes rows): interned explicitly on
  // the AddressInfo pattern. The VISIBLE fields are Node's own keys (name,
  // parentPath — Object.keys order matches Node via declaredOrder); the
  // hidden %dtype field carries the entry kind (libuv's UV_DIRENT
  // encoding) that the isFile/isDirectory/isSymbolicLink call lowerings
  // read (lowerDirentMethodCall — the StringDecoder pattern, so the
  // %-field never surfaces through the lowered Dirent surface itself).
  // A row converted to dyn takes Node's Dirent prototype and Symbol(type)
  // key, with %dtype non-enumerable (scr_dyn_dirent_finish), and inspect
  // renders rows through that view. @types/node declares Dirent<Name>
  // generic over the name's encoding — only the string instantiation maps (the
  // encoding:'buffer' readdir form has no lowering); the shipped fallback
  // declares it concrete (an interface; @types/node uses a class — both
  // provenance-checked, the Buffer/URL pattern).
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "Dirent" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    const args = checker.getTypeArguments(widened as ts.TypeReference);
    if (args.length > 1) return null;
    if (args.length === 1) {
      const t = args[0] && mapType(args[0], ctx);
      if (!t || t.kind !== "string") return null;
    }
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [
          { name: "%dtype", type: F64 },
          { name: "name", type: STRING },
          { name: "parentPath", type: STRING },
        ],
        false,
        undefined,
        ["name", "parentPath"],
      ),
    };
  }
  // os.UserInfo (os.userInfo()'s result): a stdlib data interface interned
  // explicitly, the AddressInfo pattern. The shipped fallback declares it
  // concrete; @types/node declares UserInfo<T>, where only the string
  // instantiation maps (UserInfo<Buffer> — the encoding:'buffer' option —
  // stays unmapped; the call-site lowering fences the option form anyway).
  // shell is the declared `string | null` union; POSIX always answers the
  // string arm. Key order is Node's runtime insertion order (node_os.cc
  // builds uid, gid, username, homedir, shell), so Object.keys over the
  // record answers exactly Node.
  // os.CpuInfo (os.cpus()'s element), path.ParsedPath (path.parse()'s
  // result) and path.FormatInputPathObject (path.format()'s argument):
  // stdlib data interfaces interned explicitly, the AddressInfo pattern.
  // Key order is Node's own (lib/os.js builds { model, speed, times:
  // { user, nice, sys, idle, irq } }; path.parse builds { root, dir, base,
  // ext, name }).
  const cpuTimes = (): IrType => ({
    kind: "record",
    shapeId: ctx.shapes.intern(
      ["idle", "irq", "nice", "sys", "user"].map((name) => ({ name, type: F64 })),
      false,
      undefined,
      ["user", "nice", "sys", "idle", "irq"],
    ),
  });
  if (
    psym &&
    psym.declarations.some(
      (d) =>
        ts.isTypeLiteralNode(d) &&
        ts.isPropertySignature(d.parent) &&
        ts.isIdentifier(d.parent.name) &&
        d.parent.name.text === "times" &&
        ts.isInterfaceDeclaration(d.parent.parent) &&
        d.parent.parent.name.text === "CpuInfo" &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  )
    return cpuTimes();
  if (isStdlibInterface("CpuInfo")) {
    const times = cpuTimes();
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [
          { name: "model", type: STRING },
          { name: "speed", type: F64 },
          { name: "times", type: times },
        ],
        false,
        undefined,
        ["model", "speed", "times"],
      ),
    };
  }
  if (isStdlibInterface("ParsedPath") || isStdlibInterface("FormatInputPathObject")) {
    const field =
      ts.symbolName(psym!) === "ParsedPath" ? STRING : withUndefinedArm(STRING, ctx.unions);
    if (!field) return null;
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        ["base", "dir", "ext", "name", "root"].map((name) => ({ name, type: field })),
        false,
        undefined,
        ["root", "dir", "base", "ext", "name"],
      ),
    };
  }
  if (isStdlibInterface("UserInfo")) {
    const args = checker.getTypeArguments(widened as ts.TypeReference);
    if (args.length > 1) return null;
    if (args.length === 1) {
      const t = args[0] && mapType(args[0], ctx);
      if (!t || t.kind !== "string") return null;
    }
    const shellArms = [NULL_T, STRING].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
    const shell: IrType = { kind: "union", unionId: ctx.unions.intern(shellArms) };
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [
          { name: "gid", type: F64 },
          { name: "homedir", type: STRING },
          { name: "shell", type: shell },
          { name: "uid", type: F64 },
          { name: "username", type: STRING },
        ],
        false,
        undefined,
        ["uid", "gid", "username", "homedir", "shell"],
      ),
    };
  }
  // The promisified exec/execFile result `{ stdout: string; stderr: string }`
  // and the promisified dns.lookupService result `{ hostname: string;
  // service: string }`: anonymous type literals (@types/node's
  // __promisify__ overloads in child_process and dns, the shipped
  // fallback's promisify overloads in util), so they map by provenance and
  // exact shape. The exec result is interned as the %execFileAsync/
  // %execAsync helpers build it; Node builds { stdout, stderr } and
  // { hostname, service }. The Buffer-typed literals do not match and stay
  // unmapped.
  if (
    psym &&
    psym.declarations.some(
      (d) =>
        ts.isTypeLiteralNode(d) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        (isDeclaredInAmbientModule(d, "child_process") ||
          isDeclaredInAmbientModule(d, "util") ||
          isDeclaredInAmbientModule(d, "dns")),
    )
  ) {
    const props = checker.getPropertiesOfType(widened);
    const names =
      props.length === 2 &&
      props.every(
        (p) =>
          (p.flags & ts.SymbolFlags.Optional) === 0 &&
          (checker.getTypeOfSymbol(p).flags & ts.TypeFlags.String) !== 0,
      )
        ? props
            .map((p) => ts.symbolName(p))
            .sort()
            .join(",")
        : "";
    if (names === "stderr,stdout") return { kind: "record", shapeId: execResultShape(ctx.shapes) };
    if (names === "hostname,service") {
      return {
        kind: "record",
        shapeId: ctx.shapes.intern(
          [
            { name: "hostname", type: STRING },
            { name: "service", type: STRING },
          ],
          false,
          undefined,
          ["hostname", "service"],
        ),
      };
    }
  }
  // crypto.generateKeyPairSync's results: KeyPairKeyObjectResult and
  // KeyPairSyncResult<T1, T2> as { publicKey, privateKey } records over the
  // mapped property types (KeyObjects, PEM strings or DER Buffers), in
  // Node's key order.
  if (
    psym !== undefined &&
    (ts.symbolName(psym) === "KeyPairKeyObjectResult" ||
      ts.symbolName(psym) === "KeyPairSyncResult") &&
    psym.declarations.some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "crypto"),
    )
  ) {
    const field = (name: string): IrType | null => {
      const prop = ctx.checker.getPropertyOfType(type, name);
      return prop ? mapType(ctx.checker.getTypeOfSymbol(prop), ctx) : null;
    };
    const publicKey = field("publicKey");
    const privateKey = field("privateKey");
    if (!publicKey || !privateKey) return null;
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [
          { name: "privateKey", type: privateKey },
          { name: "publicKey", type: publicKey },
        ],
        false,
        undefined,
        ["publicKey", "privateKey"],
      ),
    };
  }
  // crypto.X509Certificate — the Dirent-style data record: THREE visible
  // fields (fingerprint and the validFrom/validTo validity window, all
  // computed at construction by the new-expression lowering). Module-
  // checked like SecureContext; @types/node declares the class inside
  // `declare module "crypto"`, the shipped fallback mirrors it.
  // JSON.stringify of one shows the three fields where Node's
  // internal-slot object shows {} — the Dirent %dtype edge's cousin.
  if (
    psym !== undefined &&
    ts.symbolName(psym) === "X509Certificate" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "crypto"),
    )
  ) {
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [
          { name: "fingerprint", type: STRING },
          { name: "validFrom", type: STRING },
          { name: "validTo", type: STRING },
        ],
        false,
        undefined,
        ["fingerprint", "validFrom", "validTo"],
      ),
    };
  }
  // perf_hooks' PerformanceEntry, PerformanceMark and PerformanceMeasure
  // (performance.mark/measure and the getEntries family): ONE record shape
  // for the three classes, so marks and measures share PerformanceEntry[]
  // arrays. The visible fields are toJSON's, in its order; the hidden
  // marker field keeps the shape distinct from a structurally equal user
  // record (util.inspect names the class from entryType, like Node).
  // @types/node declares the classes in perf_hooks and global interfaces
  // over them; the shipped fallback declares the classes.
  if (
    ((psym !== undefined && ts.symbolName(psym) === "PerformanceEntry") ||
      (psym !== undefined && ts.symbolName(psym) === "PerformanceMark") ||
      (psym !== undefined && ts.symbolName(psym) === "PerformanceMeasure")) &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return { kind: "record", shapeId: perfEntryShape(ctx.shapes, ctx.unions) };
  }
  // readline's getCursorPos() record, in Node's key order ({ cols, rows }).
  // perf_hooks' EventLoopUtilization (performance.eventLoopUtilization's
  // result): a plain data record in Node's key order.
  if (isStdlibInterface("EventLoopUtilization")) {
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [
          { name: "active", type: F64 },
          { name: "idle", type: F64 },
          { name: "utilization", type: F64 },
        ],
        false,
        undefined,
        ["idle", "active", "utilization"],
      ),
    };
  }
  // monitorEventLoopDelay's IntervalHistogram: a numeric handle into the
  // runtime's histogram table, like a timer handle. Its members lower over
  // the handle (builtins/performance.ts).
  if (isStdlibInterface("IntervalHistogram")) return F64;
  if (isStdlibInterface("CursorPos")) {
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [
          { name: "cols", type: F64 },
          { name: "rows", type: F64 },
        ],
        false,
        undefined,
        ["cols", "rows"],
      ),
    };
  }
  // process.memoryUsage()'s record, in Node's key order.
  if (isStdlibInterface("MemoryUsage")) {
    const names = ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"];
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [...names].sort().map((name) => ({ name, type: F64 })),
        false,
        undefined,
        names,
      ),
    };
  }
  // v8.getHeapStatistics()'s record, in Node's key order (builtins/v8.ts).
  if (isStdlibInterface("HeapInfo")) {
    const names = [
      "total_heap_size",
      "total_heap_size_executable",
      "total_physical_size",
      "total_available_size",
      "used_heap_size",
      "heap_size_limit",
      "malloced_memory",
      "peak_malloced_memory",
      "does_zap_garbage",
      "number_of_native_contexts",
      "number_of_detached_contexts",
      "total_global_handles_size",
      "used_global_handles_size",
      "external_memory",
    ];
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [...names].sort().map((name) => ({ name, type: F64 })),
        false,
        undefined,
        names,
      ),
    };
  }
  // process.cpuUsage()/threadCpuUsage()'s {user, system} microsecond
  // record and resourceUsage()'s getrusage record — stdlib data
  // interfaces interned explicitly (the RemoteInfo pattern; declared
  // order is Node's own construction order, so Object.keys agrees).
  if (isStdlibInterface("CpuUsage")) {
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [
          { name: "system", type: F64 },
          { name: "user", type: F64 },
        ],
        false,
        undefined,
        ["user", "system"],
      ),
    };
  }
  if (isStdlibInterface("ResourceUsage")) {
    const names = [
      "userCPUTime",
      "systemCPUTime",
      "maxRSS",
      "sharedMemorySize",
      "unsharedDataSize",
      "unsharedStackSize",
      "minorPageFault",
      "majorPageFault",
      "swappedOut",
      "fsRead",
      "fsWrite",
      "ipcSent",
      "ipcReceived",
      "signalsCount",
      "voluntaryContextSwitches",
      "involuntaryContextSwitches",
    ];
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [...names].sort().map((name) => ({ name, type: F64 })),
        false,
        undefined,
        names,
      ),
    };
  }
  if (isStdlibInterface("RemoteInfo")) {
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [
          { name: "address", type: STRING },
          { name: "family", type: STRING },
          { name: "port", type: F64 },
          { name: "size", type: F64 },
        ],
        false,
        undefined,
        ["address", "family", "port", "size"],
      ),
    };
  }
  // os.NetworkInterfaceInfoIPv4/IPv6 (the arms of networkInterfaces()'s
  // NetworkInterfaceInfo union): stdlib data interfaces interned explicitly,
  // the AddressInfo pattern. The family literal types widen to string
  // (RemoteInfo's rule); IPv4's optional scopeid is the undefined-armed
  // union (holding undefined at runtime — Node omits the key), IPv6's is a
  // plain number. Declared order is Node's runtime insertion order
  // (lib/os.js builds address..cidr then appends scopeid), so Object.keys
  // over a row answers exactly Node.
  if (
    isStdlibInterface("NetworkInterfaceInfoIPv4") ||
    isStdlibInterface("NetworkInterfaceInfoIPv6")
  ) {
    const v6 = ts.symbolName(psym!) === "NetworkInterfaceInfoIPv6";
    const cidrArms = [NULL_T, STRING].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
    const cidr: IrType = { kind: "union", unionId: ctx.unions.intern(cidrArms) };
    const scopeid = v6 ? F64 : withUndefinedArm(F64, ctx.unions);
    if (!scopeid) return null;
    const fields = [
      { name: "address", type: STRING },
      { name: "cidr", type: cidr },
      { name: "family", type: STRING },
      { name: "internal", type: BOOL },
      { name: "mac", type: STRING },
      { name: "netmask", type: STRING },
      { name: "scopeid", type: scopeid },
    ];
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(fields, false, undefined, [
        "address",
        "netmask",
        "family",
        "mac",
        "internal",
        "cidr",
        "scopeid",
      ]),
    };
  }
  if (isStdlibInterface("PromiseFulfilledResult")) {
    const arg = checker.getTypeArguments(widened as ts.TypeReference)[0];
    if (!arg) return null;
    // A valueless fulfillment (Promise<void>) still has its `value`
    // property, always undefined: a dyn slot holds it, as it holds any.
    const mapped =
      arg.flags &
      (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never | ts.TypeFlags.Any)
        ? DYN
        : mapType(arg, ctx);
    if (!mapped) return null;
    const valueT = mapped.kind === "void" || isUnitType(mapped) ? DYN : mapped;
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [
          { name: "status", type: STRING },
          { name: "value", type: valueT },
        ],
        false,
        undefined,
        ["status", "value"],
      ),
    };
  }
  if (isStdlibInterface("PromiseRejectedResult")) {
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [
          { name: "reason", type: DYN },
          { name: "status", type: STRING },
        ],
        false,
        undefined,
        ["status", "reason"],
      ),
    };
  }
  // Function types: exactly one call signature, no generics, and every
  // parameter positional — the supported closure surface. OPTIONAL
  // parameters (`ctx?: T` — no initializer, no rest) map as their
  // checker-given `T | undefined` union: optionality lives entirely in the
  // parameter TYPE, exactly the optional-record-field rule, and a call
  // that omits the argument completes it with the undefined arm (the
  // lowerer's trailing completion). DEFAULTED parameters (`x: T = e`) map
  // the same way — the completed-signature contract: the TYPE spells
  // `T | undefined`, the default's VALUE lives in the closure body's own
  // prologue (declareParams), and the undefined arm is what triggers it.
  // Rest parameters keep one typed-array ABI slot and mark the function
  // type as typed-rest. Indirect call sites pack source arguments into that
  // slot, so the native closure ABI remains fixed-width.
  // The chalk-style FUNCTION-WITH-PROPERTIES hybrid: an intersection of
  // exactly one callable part with plain data-property parts (`F & { bold:
  // F }` — Object.assign(fn, {...})'s type) maps to a RECORD carrying the
  // callable in a reserved `%call` field ('%' cannot appear in a TS
  // property name, so no user field collides). Calls through the value
  // read the slot (lowerRecordFieldCall / the call-value path), extraction
  // into a plain F slot reads it too (coerceToExpected), and Object.assign
  // constructs the record. Intersections that don't fit fall through to
  // the plain-func mapping below (historic behavior: the properties drop
  // from the type).
  if (widened.isIntersectionType() && checker.getConstructSignatures(widened).length === 0) {
    const hybrid = mapHybridCallableIntersection(widened, ctx);
    if (hybrid) return hybrid;
    // Recursive and Symbol-keyed callable objects need their complete live
    // property table; dropping those members into a plain closure loses data.
    if (
      checker.getCallSignatures(widened).length > 0 &&
      checker.getPropertiesOfType(widened).length > 0
    )
      return DYN;
  }
  // A union of such hybrids that all map to ONE record is that record:
  // node:test's Mock<F | Implementation> distributes to (F & { mock }) |
  // (Implementation & { mock }), and the two function types can map alike.
  if (widened.isUnionType()) {
    const hybrid = mapUniformHybridUnion(widened, ctx);
    if (hybrid) return hybrid;
  }
  const callSigs = checker.getCallSignatures(widened);
  // AsyncLocalStorage.snapshot()'s generic runner is a dyn function value
  // (als.snapshot), called through the dyn call path.
  if (callSigs.length === 1 && isAsyncLocalStorageSnapshot(callSigs[0]!, ctx)) return DYN;
  if (callSigs.length === 1) return mapCallSignature(callSigs[0]!, ctx);
  // Records: object types whose members are all data properties (shorthand
  // methods in type position count — they're func-typed fields) with
  // mappable types; no call/construct signatures, no index signatures, not
  // a tuple, and declared in USER code (lib interfaces like
  // Function/Object/Iterable stay unmapped — the standard-library types are
  // a type world, not data shapes). Optional properties (`a?: T`) need no special handling: under
  // strictNullChecks the checker types them `T | undefined`, so the field
  // maps to an undefined-armed union — optionality lives entirely in the
  // field TYPE, which is also what keeps `{a: string}` and `{a?: string}`
  // distinct interned shapes (and makes `{a?: string}` and
  // `{a: string | undefined}` deliberately the SAME shape, matching tsc's
  // mutual assignability without exactOptionalPropertyTypes). Two
  // structurally identical types intern to one shapeId.
  //
  // Mapped-type results (`Partial<Config>`, `Record<"a" | "b", number>`,
  // Pick/Omit spellings) and intersections of object types resolve through
  // the SAME path: the member walk below asks the checker for the resolved
  // property list, so a utility type interns the identical shape its
  // longhand spelling would. Intersections are a distinct TypeFlag, hence
  // the widened condition.
  // A USER-declared child-process-shaped interface (the ngrok
  // NgrokChildProcess idiom — `spawn(...) as NgrokChildProcess`, declared
  // so tests can hand in mocks): every member is named on the lowered
  // ChildProcess surface AND at least two are the handle-defining ones
  // (kill/on/stdin/stdout/stderr/unref/exitCode — a data record like
  // `{ pid: number }` never qualifies). The TYPE maps to the child
  // handle: in a compiled program the only VALUE producer is spawn
  // itself (a mock object literal in this slot fences at its
  // construction site), and every member the interface may declare is
  // exactly a lowered child member WITH the corresponding handle type, so
  // uses typecheck against the interface and lower against the handle.
  // Names alone are insufficient: a record of stdout/stderr callbacks is
  // an ordinary data shape, not a child process.
  if (
    flags & ts.TypeFlags.Object &&
    callSigs.length === 0 &&
    psym !== undefined &&
    psym.declarations.length > 0 &&
    psym.declarations.every(
      (d) => ts.isInterfaceDeclaration(d) && !ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    const CHILD_SURFACE = new Set([
      "pid",
      "exitCode",
      "killed",
      "kill",
      "on",
      "once",
      "off",
      "removeListener",
      "unref",
      "ref",
      "stdin",
      "stdout",
      "stderr",
      "send",
      "connected",
      "disconnect",
    ]);
    const CHILD_CORE = new Set([
      "kill",
      "on",
      "stdin",
      "stdout",
      "stderr",
      "unref",
      "exitCode",
      "send",
      "connected",
    ]);
    const props = checker.getPropertiesOfType(widened);
    let core = 0;
    const childMemberType = (p: ts.Symbol): boolean => {
      if (
        ["kill", "on", "once", "off", "removeListener", "unref", "ref"].includes(ts.symbolName(p))
      ) {
        return checker.getCallSignatures(checker.getTypeOfSymbol(p)).length > 0;
      }
      const expected =
        ts.symbolName(p) === "stdout" || ts.symbolName(p) === "stderr"
          ? "childStream"
          : ts.symbolName(p) === "stdin"
            ? "childWriter"
            : ts.symbolName(p) === "killed"
              ? "bool"
              : "f64";
      const unit =
        ts.symbolName(p) === "pid"
          ? "undefinedT"
          : ts.symbolName(p) === "exitCode" ||
              ts.symbolName(p) === "stdin" ||
              ts.symbolName(p) === "stdout" ||
              ts.symbolName(p) === "stderr"
            ? "nullT"
            : null;
      const mapped = mapType(checker.getTypeOfSymbol(p), ctx);
      if (!mapped) return false;
      const arms = mapped.kind === "union" ? ctx.unions.get(mapped.unionId)?.arms : [mapped];
      // Under the general stream representation the stdio members are the
      // runtime stream classes.
      const isExpected = (arm: IrType): boolean =>
        arm.kind === expected ||
        (ctx.generalNodeStreams === true &&
          arm.kind === "object" &&
          ((expected === "childStream" && arm.className === "%Readable") ||
            (expected === "childWriter" && arm.className === "%Writable"))) ||
        // Checked-dynamic stream slots: `NodeJS.ReadableStream | null`
        // collapses to dyn (the reads still produce the bridged stream).
        (ctx.dynNodeStreams === true &&
          arm.kind === "dyn" &&
          (expected === "childStream" || expected === "childWriter"));
      return (
        arms !== undefined &&
        arms.some(isExpected) &&
        arms.every((arm) => isExpected(arm) || arm.kind === unit)
      );
    };
    const childShaped =
      props.length > 0 &&
      props.every((p) => {
        if (!CHILD_SURFACE.has(ts.symbolName(p)) || !childMemberType(p)) return false;
        if (CHILD_CORE.has(ts.symbolName(p))) core++;
        return true;
      });
    if (childShaped && core >= 2) return CHILD_T;
  }
  if (flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection) && callSigs.length === 0) {
    const viaMapped = mapBoundMappedType(widened, ctx);
    if (viaMapped) return viaMapped;
    const viaAlias = mapGenericUtilityAlias(widened, ctx);
    if (viaAlias) return viaAlias;
    const record = mapRecordType(widened, ctx);
    if (record) return record;
  }
  // Unions. `boolean` is internally `true | false`, and narrowing produces
  // literal unions like `"a" | "b"` — parts that map to the SAME IR type
  // collapse (deduplicated by typeKey), so a single surviving arm is just
  // that type. Two or more distinct arms become a TAGGED union: the
  // typeKey-sorted arm list and discriminator are interned, and an arm's index
  // in that list is its runtime tag. `undefined` and `null` PARTS become
  // the unit arms undefinedT/nullT — strictNullChecks spells optionality
  // as exactly these unions (`string | undefined`, `number | null`), and
  // union membership is the only position where the units are
  // representable. Deliberately unmapped: any other unmappable part
  // (poisons the union), void parts, func arms (closure identity vs tag
  // interplay, later). RECURSIVE unions (`type Tree = Leaf | { children:
  // Tree[] }`, the optional-field spelling `a?: A` of a mutually recursive
  // pair) map as NAMED RECURSIVE UNIONS: a back-reference to an in-progress
  // union answers a placeholder id whose arms fill in when this frame
  // completes — the ShapeRegistry knot, mirrored (identity per checker
  // type; context-sensitive frames stay fenced).
  if (widened.isUnionType()) {
    const knownRecursive = unions.recursiveUnionFor(widened);
    if (knownRecursive !== undefined) return { kind: "union", unionId: knownRecursive };
    if (unions.inProgress.has(widened)) {
      return {
        kind: "union",
        unionId: unions.recursiveRef(widened, () => checkerTypeDescription(widened, ctx)),
      };
    }
    unions.inProgress.add(widened);
    const sensitivityAtEntry = contextResolutions;
    try {
      const byKey = new Map<string, IrType>();
      const recordParts: { source: ts.Type; mapped: IrType & { kind: "record" } }[] = [];
      const substitutedUnions: IrUnionDef[] = [];
      // The lib's `T extends readonly unknown[] | []` idiom (Promise.all,
      // allSettled) maps an array input to `X[] | []`: the empty tuple is
      // one of the array's own values.
      const parts = ts.constituentTypes(widened);
      const emptyTuple = (part: ts.Type): boolean =>
        checker.isTupleType(part) &&
        checker.getTypeArguments(part as ts.TypeReference).length === 0;
      // The match-result fallback `s.match(re) || []` (and `?? []`) widens
      // to `RegExpMatchArray | []`: the empty tuple is one of the match
      // array's own values too.
      const matchArray = (part: ts.Type): boolean => {
        // The names have no leading `__`, so the escaped name is the name.
        const name = part.getSymbol()?.escapedName;
        return (
          (name === "RegExpMatchArray" || name === "RegExpExecArray") &&
          (part.getSymbol()?.declarations.some((d) => ctx.isStdlibFile(d.getSourceFile())) ?? false)
        );
      };
      const hasArrayPart = parts.some((part) => checker.isArrayType(part) || matchArray(part));
      // Subtype reduction removes every arm assignable to `{}`, so a union
      // that keeps another non-nullish arm beside an empty literal's `{}`
      // was not reduced: that `{}` arm holds only the literal's objects.
      const nullish = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;
      const literalEmptyArms =
        parts.some((part) => isEmptyObjectLiteralType(part, ctx)) &&
        parts.some(
          (part) =>
            (part.flags & nullish) === 0 &&
            !checker.isNeverType(part) &&
            !isEmptyObjectLiteralType(part, ctx),
        );
      for (const part of parts) {
        if (hasArrayPart && emptyTuple(part)) continue;
        // TypeScript's client can retain impossible intersections in a
        // distributed union. They have no inhabitants and no runtime tag.
        if (checker.isNeverType(part)) continue;
        // A `void` PART is inhabited only by undefined (`Promise<void> |
        // void` return types, `string | void`): it becomes the undefinedT
        // unit arm, exactly like an undefined part — the value either
        // exists or is undefined, and the union tag is the test. Standalone
        // void stays VOID (the return-position mapping above).
        if (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
          byKey.set(typeKey(UNDEFINED_T), UNDEFINED_T);
          continue;
        }
        if (part.flags & ts.TypeFlags.Null) {
          byKey.set(typeKey(NULL_T), NULL_T);
          continue;
        }
        let mapped: IrType | null;
        if (literalEmptyArms && isEmptyObjectLiteralType(part, ctx)) {
          ctx.emptyLiteralArm = true;
          try {
            mapped = mapType(part, ctx);
          } finally {
            ctx.emptyLiteralArm = false;
          }
        } else {
          mapped = mapType(part, ctx);
        }

        if (!mapped) {
          return null;
        }
        if (mapped.kind === "void") {
          byKey.set(typeKey(UNDEFINED_T), UNDEFINED_T);
          continue;
        }
        // A generic parameter can substitute a complete union into one
        // checker constituent: `(T | undefined)` with nullable T still
        // has one flat storage contract. An unfinished recursive union
        // cannot supply its arms yet, so retain that existing boundary.
        if (mapped.kind === "union") {
          const substituted = unions.get(mapped.unionId);
          if (!substituted?.arms.length || substituted.arms.some((arm) => arm.kind === "union"))
            return null;
          substitutedUnions.push(substituted);
          for (const arm of substituted.arms) byKey.set(typeKey(arm), arm);
          continue;
        }
        byKey.set(typeKey(mapped), mapped);
        if (mapped.kind === "record") recordParts.push({ source: part, mapped });
      }
      const arms = [...byKey.values()];
      if (arms.length === 0) return F64; // same unreachable placeholder as standalone never
      // A single surviving UNIT arm cannot stand alone (degenerate — the
      // checker collapsed everything else away); anything else single is
      // just that type. A single arm UNDER A MINTED PLACEHOLDER cannot
      // stand either: back-references already handed out the union id, and
      // a one-armed union has no representation — fence the degenerate
      // recursive spelling honestly.
      if (arms.length === 1 && isUnitType(arms[0]!)) return null;
      if (arms.length === 1) {
        if (unions.recursivePending(widened)) return null;
        return arms[0]!;
      }
      // The `string | object`-family COLLAPSE (world unification lane 3):
      // a union with an 'object'/'unknown'/`{}`-flavored arm (dyn) beside
      // arms the checked-dynamic representation FAITHFULLY holds maps to
      // DYN WHOLESALE — the checked-dynamic tree's scalar kinds ARE the scalar arms (===,
      // typeof, switch dispatch all exact), typeof/Array.isArray/unit
      // narrowing on dyn already dispatches natively (dynTest +
      // maybeNarrow's validated scalar extraction), so no union tag is
      // needed. The domain is dynSubsumableUnionArm's: scalars, units, dyn
      // itself, and records/arrays inside the dynFrom conversion domain
      // (those enter as dyn data — the deep-copy stance, so identity and
      // mutation coupling with the source value end at the slot;
      // SEMANTICS.md). Arms with real typed representations whose
      // semantics would DEGRADE under the collapse — class instances,
      // Maps/Sets, functions (closure identity, `x === String`
      // narrowing), promises, regexes, generators, handles — keep their
      // existing union homes and fences below. URL is the
      // exception: its handle boxes by reference and keeps every member,
      // so it collapses too (dynSubsumableUnionArm). A pending recursive
      // placeholder cannot collapse (back-references already hold the
      // union id); the degenerate recursive spelling keeps its fence.
      if (
        arms.some((a) => a.kind === "dyn") &&
        arms.every((a) => dynSubsumableUnionArm(a, ctx)) &&
        !unions.recursivePending(widened)
      ) {
        return DYN;
      }
      if (
        arms.some(
          (a) =>
            a.kind === "void" ||
            a.kind === "union" ||
            a.kind === "dyn" ||
            // A generator arm only comes from an Iterable<T> (an optional
            // one keeps its unit arms beside the iterable union's).
            (a.kind === "generator" && iterableArmsElem(arms) === null),
        ) ||
        !maybePromiseUnionOk(parts, arms, ctx)
      ) {
        return null;
      }
      arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
      const discriminant =
        unionDiscriminant(recordParts, arms, ctx) ??
        (substitutedUnions.length === 1
          ? remapUnionDiscriminant(substitutedUnions[0]!, arms)
          : undefined);
      if (unions.recursivePending(widened)) {
        // The knot closed through this union. A frame that resolved
        // through context-sensitive hooks (generic type parameters, mixin
        // instantiations) cannot intern by checker-type identity — the
        // same ts.Type answers differently per instantiation — so
        // recursive generic-open unions stay fenced.
        if (contextResolutions !== sensitivityAtEntry) return null;
        return { kind: "union", unionId: unions.finalizeRecursive(widened, arms, discriminant) };
      }
      return { kind: "union", unionId: unions.intern(arms, discriminant) };
    } finally {
      unions.inProgress.delete(widened);
    }
  }
  return null;
}

/** One non-overloaded call signature's func type (mapTypeInner's
 * single-signature rule; erasedOverloadMemberType maps each overload of a
 * member through it). */
/** Whether `sig` is the function type AsyncLocalStorage.snapshot() returns:
 * declared as that static method's return type in the async_hooks module
 * of the standard library declarations. */
function isAsyncLocalStorageSnapshot(sig: ts.Signature, ctx: TypeMapperCtx): boolean {
  const decl = sig.declaration;
  if (decl === undefined || !ts.isFunctionTypeNode(decl)) return false;
  const method = decl.parent;
  return (
    method !== undefined &&
    ts.isMethodDeclaration(method) &&
    ts.isIdentifier(method.name) &&
    method.name.text === "snapshot" &&
    method.parent !== undefined &&
    ts.isClassDeclaration(method.parent) &&
    method.parent.name?.text === "AsyncLocalStorage" &&
    ctx.isStdlibFile(ts.getSourceFileOfNode(decl)) &&
    isDeclaredInAmbientModule(decl, "async_hooks")
  );
}

function mapCallSignature(sig: ts.Signature, ctx: TypeMapperCtx): IrType | null {
  const { checker } = ctx;
  if (sig.getTypeParameters().length && ctx.erasingSignature !== sig) return null;
  // A SYNTHESIZED rest param (tsc's JS inference for a function body
  // reading `arguments` — `(...args: any[]) => any` whose args symbol
  // has no declaration): the dotDotDot check below can't see it, and a
  // fixed-arity func mapping would LIE about the value's calling
  // convention. Detected by the param-count mismatch against the
  // signature's own declaration, excluding an erased `this` parameter.
  {
    const sigDecl = sig.declaration;
    const declParams =
      sigDecl !== undefined && ts.isFunctionLike(sigDecl) ? sigDecl.parameters.nodes : undefined;
    if (
      declParams !== undefined &&
      runtimeParameterCount(declParams) !== sig.getParameters().length
    ) {
      return null;
    }
    // tsgo never SYNTHESIZES that rest param into the inferred signature
    // (5.9.3 did — the count mismatch above was the whole detector
    // there), so the declaration's own body answers directly.
    if (sigDecl !== undefined && ts.isFunctionLike(sigDecl) && bodyReadsArguments(sigDecl)) {
      return null;
    }
  }
  const params: IrType[] = [];
  let typedRest = false;
  let dynRest = false;
  for (const p of sig.getParameters()) {
    const decl = p.valueDeclaration;
    const rest = decl !== undefined && ts.isParameter(decl) && decl.dotDotDotToken !== undefined;

    // arity ABI selected by lambdaSignature. Treating an inferred any[]
    // declaration as a typed packed-array closure would bypass its boxed
    // spread/error semantics and change coverage classification.
    if (rest && decl !== undefined && isJsSourceFile(ts.getSourceFileOfNode(decl))) return null;
    // A fixed-tuple rest (`...args: [A, B]`, `...args: Parameters<F>` over
    // a bound F) flattens to its positional parameters. Pattern rests keep
    // their packed-record ABI and stay unmapped as values.
    if (rest && decl !== undefined && ts.isParameter(decl) && ts.isIdentifier(decl.name)) {
      const elems = restTupleParamTypes(checker.getTypeOfSymbol(p), ctx);
      if (elems) {
        params.push(...elems);
        continue;
      }
    }
    const optional =
      decl !== undefined &&
      ts.isParameter(decl) &&
      (decl.questionToken !== undefined || decl.initializer !== undefined);
    let pt = mapType(checker.getTypeOfSymbol(p), ctx);
    // A parameter a TypeScript program types `any` takes whatever the
    // caller passes: the checked-dynamic slot, as an `any`-typed binding
    // already is (dynFallbackType). Declaration files keep their paths.
    // Only function declarations, spelled function types and lambda
    // parameters whose default is the only source of their type (`(n =
    // lookup() ?? 5) => ...` with an `any` lookup): other lambdas and
    // methods in object literals keep their existing checked-dynamic story.
    if (
      !pt &&
      !rest &&
      decl !== undefined &&
      ts.isParameter(decl) &&
      decl.parent !== undefined &&
      (ts.isFunctionDeclaration(decl.parent) ||
        ts.isFunctionTypeNode(decl.parent) ||
        ((ts.isArrowFunction(decl.parent) || ts.isFunctionExpression(decl.parent)) &&
          decl.initializer !== undefined &&
          decl.type === undefined &&
          !isJsSourceFile(ts.getSourceFileOfNode(decl)))) &&
      !ts.getSourceFileOfNode(decl).isDeclarationFile &&
      (checker.getTypeOfSymbol(p).flags & ts.TypeFlags.Any) !== 0
    )
      pt = DYN;
    if (
      decl &&
      ts.isParameter(decl) &&
      ts.isSetAccessorDeclaration(decl.parent) &&
      isJsSourceFile(ts.getSourceFileOfNode(decl))
    )
      pt = DYN;
    // An inferred JavaScript binding pattern consumes an iterable; it
    // does not require the caller's array to have exactly this length.
    const executor = decl && ts.isParameter(decl) ? decl.parent : null;
    const construction = executor?.parent;
    const constructorSymbol =
      construction && ts.isNewExpression(construction)
        ? checker.getSymbolAtLocation(construction.expression)
        : undefined;
    const nativeExecutor =
      executor &&
      (ts.isArrowFunction(executor) || ts.isFunctionExpression(executor)) &&
      construction &&
      ts.isNewExpression(construction) &&
      construction.arguments?.nodes[0] === executor &&
      ts.isIdentifier(construction.expression) &&
      construction.expression.text === "Promise" &&
      constructorSymbol &&
      constructorSymbol.declarations.some((site) => ctx.isStdlibFile(ts.getSourceFileOfNode(site)));
    if (
      !nativeExecutor &&
      decl &&
      ts.isParameter(decl) &&
      !decl.dotDotDotToken &&
      !ts.isSetAccessorDeclaration(decl.parent) &&
      isJsSourceFile(ts.getSourceFileOfNode(decl)) &&
      !decl.type &&
      !/@(?:param|type)\b/.test(
        ts
          .getSourceFileOfNode(decl)
          .text.slice(decl.parent?.pos ?? decl.pos, ts.tokenStartOfNode(decl)),
      )
    )
      pt = DYN;
    // A DEFAULTED program-source parameter of a function, arrow or function
    // expression that the checker types `any` — a default under an
    // `(...args: any[]) => any` wrapper slot (`wrap((limit = 5) => ...)`),
    // where the contextual `any` wins over the default's type: its binding
    // is already the checked-dynamic kind inside the body
    // (dynFallbackType), so the callable's ABI slot is the same dyn value.
    // Other `any` parameters keep their existing paths (an object literal
    // holding such a callback stays a checked-dynamic object).
    if (
      pt === null &&
      !rest &&
      decl !== undefined &&
      ts.isParameter(decl) &&
      decl.initializer !== undefined &&
      (ts.isArrowFunction(decl.parent) ||
        ts.isFunctionExpression(decl.parent) ||
        ts.isFunctionDeclaration(decl.parent)) &&
      !ts.getSourceFileOfNode(decl).isDeclarationFile &&
      (checker.getTypeOfSymbol(p).flags & ts.TypeFlags.Any) !== 0
    )
      pt = DYN;
    if (pt) pt = jsOpenObjectType(decl, pt, ctx.shapes, ctx.unions);
    // Belt and braces for non-strict type worlds: an optional param's
    // ABI slot is always the undefined-armed union (strictNullChecks
    // already spells it that way; arm it here if the world didn't).
    if (optional && pt && pt.kind !== "void" && pt.kind !== "dyn") {
      const armed = withUndefinedArm(pt, ctx.unions);
      if (!armed) return null;
      pt = armed;
    }
    // `...args: unknown[]` / `...args: any[]` declared in program source:
    // the checked-dynamic variadic ABI (no typed slot; the callee's hidden
    // trailing dyn array receives every surplus argument, as for JS rest
    // params). Declaration files keep their existing paths: library
    // callback slots such as String#replace's `(substring, ...args: any[])`
    // have intrinsic lowerings that inspect the unmapped type.
    // node:test's default mock function type, `(...args: any[]) =>
    // undefined` (the type parameter default of mock.fn), takes the same
    // ABI: mock.fn() without an original records whatever its callers pass.
    if (
      rest &&
      decl !== undefined &&
      (!ts.getSourceFileOfNode(decl).isDeclarationFile ||
        isNodeTestDefaultFunctionParam(decl, ctx)) &&
      (pt?.kind === "dyn" || (!pt && isAnyArrayType(checker.getTypeOfSymbol(p), checker)))
    ) {
      dynRest = true;
      continue;
    }
    if (!pt) return null;
    if (rest) {
      if (pt.kind !== "array") return null;
      typedRest = true;
    }
    // `(value: void) => void` (Promise<void>'s resolve) is callable with
    // no arguments — a void param is dropped, not a mapping failure.
    if (pt.kind === "void") continue;
    params.push(pt);
  }
  const retT = checker.getReturnTypeOfSignature(sig);
  // `() => never` (a throw-only lambda's inferred type) is assignable to
  // `() => void` and its calls never produce a value — map the return
  // like declaredReturnType does for declarations. JS null/undefined
  // returns can read mutable fields, so callable values use the same
  // checked-native return ABI as their implementations.
  const sigDecl = sig.declaration;
  const jsUnitReturn =
    sigDecl !== undefined &&
    isJsSourceFile(ts.getSourceFileOfNode(sigDecl)) &&
    (retT.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0;
  let ret =
    jsUnitReturn || (retT.flags & ts.TypeFlags.Any) !== 0
      ? DYN
      : retT.flags & ts.TypeFlags.Never
        ? VOID
        : mapType(retT, ctx);
  if (
    sigDecl &&
    ts.isGetAccessorDeclaration(sigDecl) &&
    isJsSourceFile(ts.getSourceFileOfNode(sigDecl))
  )
    ret = DYN;
  if (sigDecl && isJsSourceFile(ts.getSourceFileOfNode(sigDecl)) && ret?.kind === "array")
    ret = DYN;
  if (
    sigDecl &&
    ts.isFunctionLike(sigDecl) &&
    isJsSourceFile(ts.getSourceFileOfNode(sigDecl)) &&
    !sigDecl.type &&
    !/@returns?\b/.test(
      ts.getSourceFileOfNode(sigDecl).text.slice(sigDecl.pos, ts.tokenStartOfNode(sigDecl)),
    ) &&
    ret?.kind === "record"
  )
    ret = DYN;
  if (
    sigDecl &&
    ts.isFunctionLike(sigDecl) &&
    isJsSourceFile(ts.getSourceFileOfNode(sigDecl)) &&
    !sigDecl.type &&
    !/@returns?\b/.test(
      ts.getSourceFileOfNode(sigDecl).text.slice(sigDecl.pos, ts.tokenStartOfNode(sigDecl)),
    ) &&
    (ret?.kind === "date" ||
      (ret?.kind === "union" &&
        ctx.unions.get(ret.unionId)?.arms.some((arm) => arm.kind === "func")))
  )
    ret = DYN;
  if (
    ret &&
    sigDecl &&
    isJsSourceFile(ts.getSourceFileOfNode(sigDecl)) &&
    functionCanReturnUndefined(sigDecl)
  )
    ret = withUndefinedArm(ret, ctx.unions) ?? ret;
  if (!ret) return null;
  return typedRest
    ? { kind: "func", params, ret, rest: true, restAbi: "typed" }
    : dynRest
      ? { kind: "func", params, ret, rest: true }
      : funcOf(params, ret);
}

/** Retain a literal discriminator before widening erases its values. A
 * structural match alone is insufficient: `{ kind: "loop", body: ... }`
 * also fits a smaller `{ kind: "empty" }` record. Choosing that layout
 * makes a later switch on kind read fields outside the allocated object.
 *
 * Require one common, required data property with finite literal values.
 * Values may repeat within a single storage arm (several variants share a
 * shape), but never select different arms. Non-record arms keep their
 * ordinary kind checks. Types without an unambiguous discriminator retain
 * their structural boundary behavior. */
function unionDiscriminant(
  parts: { source: ts.Type; mapped: IrType & { kind: "record" } }[],
  arms: IrType[],
  ctx: TypeMapperCtx,
): IrUnionDiscriminant | undefined {
  if (arms.filter((arm) => arm.kind === "record").length < 2 || parts.length < 2) return undefined;
  const { checker } = ctx;
  // Tuple shapes keep positions only: their checker `length` literal has
  // no slot to compare (discriminantField refuses tuple shapes too).
  if (parts.some((part) => ctx.shapes.get(part.mapped.shapeId)?.tuple)) return undefined;
  for (const candidate of checker.getPropertiesOfType(parts[0]!.source)) {
    if (ts.symbolName(candidate).startsWith("__@")) continue;
    const byTag = new Map<number, (string | number | boolean)[]>();
    const owner = new Map<string, number>();
    let complete = true;
    for (const part of parts) {
      const prop = checker.getPropertyOfType(part.source, ts.symbolName(candidate));
      if (
        !prop ||
        prop.flags &
          (ts.SymbolFlags.Optional | ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)
      ) {
        complete = false;
        break;
      }
      const values = literalValues(checker.getTypeOfSymbol(prop));
      if (!values) {
        complete = false;
        break;
      }
      const tag = arms.findIndex((arm) => typeEquals(arm, part.mapped));
      const grouped = byTag.get(tag) ?? [];
      for (const value of values) {
        const key = JSON.stringify(value);
        const previous = owner.get(key);
        if (previous !== undefined && previous !== tag) {
          complete = false;
          break;
        }
        owner.set(key, tag);
        if (!grouped.includes(value)) grouped.push(value);
      }
      if (!complete) break;
      byTag.set(tag, grouped);
    }
    if (complete) {
      return {
        field: ts.symbolName(candidate),
        cases: [...byTag]
          .sort(([a], [b]) => a - b)
          .map(([tag, values]) => ({
            tag,
            values: values.sort((a, b) =>
              JSON.stringify(a) < JSON.stringify(b)
                ? -1
                : JSON.stringify(a) > JSON.stringify(b)
                  ? 1
                  : 0,
            ),
          })),
      };
    }
  }
  return undefined;
}

/** A class-derived interface or intersection can refine existing members
 * without changing the object's layout. Keep the unique program class as
 * its representation; structural lookalikes without a class base do not
 * qualify. Construction and coercion must still supply that actual class.
 * Undefined means no class view, while null is a recognized but unsupported
 * view: do not fall through and copy an identity-bearing object to a record. */
function mapClassView(
  type: ts.Type,
  ctx: TypeMapperCtx,
  seen = new Set<ts.Type>(),
): IrType | null | undefined {
  const { checker } = ctx;
  if (seen.has(type) || seen.size >= MAP_TYPE_MAX_DEPTH) return null;
  let bases: readonly ts.Type[];
  let viewCtx = ctx;
  if (type.isIntersectionType()) {
    bases = ts.constituentTypes(type);
  } else {
    const symbol = type.getSymbol();
    const declarations = symbol ? symbol.declarations : [];
    if (
      declarations.length === 0 ||
      !declarations.every(
        (decl) =>
          ts.isInterfaceDeclaration(decl) && !ctx.isStdlibFile(ts.getSourceFileOfNode(decl)),
      )
    )
      return undefined;
    const target = type.isTypeReference() ? type.getTarget() : type;
    if (target === undefined || !target.isClassOrInterface()) return undefined;
    bases = checker.getBaseTypes(target);
    if (type.isTypeReference() && target.isTypeReference()) {
      const params = checker.getTypeArguments(target);
      const args = checker.getTypeArguments(type);
      viewCtx = {
        ...ctx,
        canMemoizeType: () => false,
        resolveTypeParam: (param) => {
          const index = params.indexOf(param);
          const arg = index >= 0 ? args[index] : undefined;
          return arg && arg !== param ? mapType(arg, ctx) : (ctx.resolveTypeParam?.(param) ?? null);
        },
        resolveTypeParamTs: (param) => {
          const index = params.indexOf(param);
          const arg = index >= 0 ? args[index] : undefined;
          return arg && arg !== param
            ? (ctx.resolveTypeParamTs?.(arg) ?? arg)
            : (ctx.resolveTypeParamTs?.(param) ?? null);
        },
      };
    }
  }
  seen.add(type);
  try {
    let baseType: ts.Type | undefined;
    let representation: IrType | undefined;
    for (const base of bases) {
      const symbol = base.getSymbol();
      const declaration = symbol ? symbol.valueDeclaration : undefined;
      const classBase =
        declaration &&
        (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) &&
        !ts.getSourceFileOfNode(declaration).isDeclarationFile;
      const mapped = classBase ? mapType(base, viewCtx) : mapClassView(base, viewCtx, seen);
      if (mapped === null) return null;
      if (mapped === undefined) continue;
      if (mapped.kind !== "object" || (representation && !typeEquals(representation, mapped)))
        return null;
      baseType = base;
      representation = mapped;
    }
    if (!representation || !baseType) return undefined;
    if (
      checker.getCallSignatures(type).length ||
      checker.getConstructSignatures(type).length ||
      checker.getIndexInfosOfType(type).length
    )
      return null;
    for (const property of checker.getPropertiesOfType(type)) {
      const original = checker.getPropertyOfType(baseType, ts.symbolName(property));
      if (!original) return null;
      if (original === property) continue;
      const originalDeclarations = original.declarations;
      const declarations = property.declarations;
      // Instantiating an inherited member can create a new symbol without
      // changing its declaration or ABI. Only refinements need validation.
      if (
        declarations.length > 0 &&
        declarations.length === originalDeclarations.length &&
        declarations.every((declaration, index) => declaration === originalDeclarations[index])
      )
        continue;
      const before = checker.getTypeOfSymbol(original);
      const after = checker.getTypeOfSymbol(property);
      if (checker.getCallSignatures(before).length || checker.getCallSignatures(after).length) {
        const from = mapType(before, viewCtx);
        const to = mapType(after, viewCtx);
        if (!from || !to || !typeEquals(from, to)) return null;
      } else if (!checker.isTypeAssignableTo(after, before)) {
        return null;
      }
    }
    return representation;
  } finally {
    seen.delete(type);
  }
}

/** Interface views of native collections may inherit their runtime surface
 * and refine `has` into a type predicate. Keep declaration provenance and
 * require the same call ABI; extra fields or replacement methods need a
 * different representation. Value construction/coercion still has to prove
 * a native Map/Set, so structural mocks cannot acquire a native handle. */
function mapCollectionView(
  type: ts.Type,
  ctx: TypeMapperCtx,
  seen = new Set<ts.Type>(),
): IrType | null {
  if (!type.isTypeReference()) return null;
  const { checker } = ctx;
  const symbol = type.getSymbol();
  const declarations = symbol ? symbol.declarations : [];
  if (
    declarations.length === 0 ||
    !declarations.every(
      (decl) => ts.isInterfaceDeclaration(decl) && !ctx.isStdlibFile(ts.getSourceFileOfNode(decl)),
    )
  )
    return null;
  const target = type.getTarget();
  if (
    target === undefined ||
    !target.isClassOrInterface() ||
    seen.has(target) ||
    seen.size >= MAP_TYPE_MAX_DEPTH
  )
    return null;
  const bases = checker.getBaseTypes(target);
  if (bases.length !== 1) return null;
  if (
    checker.getCallSignatures(type).length ||
    checker.getConstructSignatures(type).length ||
    checker.getIndexInfosOfType(type).length
  )
    return null;

  // Base declarations contain the interface's parameters, even when this
  // reference is instantiated. Resolve those through this reference before
  // mapping the base; never cache a template under one instantiation's ABI.
  const params = checker.getTypeArguments(target);
  const args = checker.getTypeArguments(type);
  const baseCtx: TypeMapperCtx = {
    ...ctx,
    canMemoizeType: () => false,
    resolveTypeParam: (param) => {
      const index = params.indexOf(param);
      const arg = index >= 0 ? args[index] : undefined;
      return arg && arg !== param ? mapType(arg, ctx) : (ctx.resolveTypeParam?.(param) ?? null);
    },
    resolveTypeParamTs: (param) => {
      const index = params.indexOf(param);
      const arg = index >= 0 ? args[index] : undefined;
      return arg && arg !== param
        ? (ctx.resolveTypeParamTs?.(arg) ?? arg)
        : (ctx.resolveTypeParamTs?.(param) ?? null);
    },
  };
  seen.add(target);
  try {
    const base = bases[0]!;
    const baseSymbol = base.getSymbol();
    const native =
      baseSymbol &&
      ["Map", "ReadonlyMap", "Set", "ReadonlySet"].includes(ts.symbolName(baseSymbol)) &&
      baseSymbol.declarations.some(
        (decl) => ts.isInterfaceDeclaration(decl) && ctx.isStdlibFile(ts.getSourceFileOfNode(decl)),
      );
    const mapped = native ? mapType(base, baseCtx) : mapCollectionView(base, baseCtx, seen);
    if (mapped?.kind !== "map" && mapped?.kind !== "set") return null;
    const hasType = funcOf([mapped.kind === "map" ? mapped.key : mapped.elem], BOOL);
    for (const property of checker.getPropertiesOfType(type)) {
      const own = property.declarations.filter(
        (decl) => !ctx.isStdlibFile(ts.getSourceFileOfNode(decl)),
      );
      if (own.length === 0) continue;
      if (
        ts.symbolName(property) !== "has" ||
        property.flags & ts.SymbolFlags.Optional ||
        !own.every((decl) => decl.kind === ts.SyntaxKind.MethodSignature)
      )
        return null;
      const method = mapType(checker.getTypeOfSymbol(property), ctx);
      if (!method || !typeEquals(method, hasType)) return null;
    }
    return mapped;
  } finally {
    seen.delete(target);
  }
}

/** The narrowed-type-parameter recognizer behind mapType's early return:
 * a union/intersection over exactly ONE type parameter whose companions
 * are all `{}`-empty shapes or the null/undefined units. Returns the
 * bound type filtered to the arms the companions allow, null when the
 * pattern matches but cannot map (unbound parameter, nothing left), and
 * undefined when the type is not this pattern at all (the caller falls
 * through to the ordinary mapping). */
function mapNarrowedTypeParam(type: ts.Type, ctx: TypeMapperCtx): IrType | null | undefined {
  const { checker, unions, resolveTypeParam } = ctx;
  if (!resolveTypeParam) return undefined;
  const isEmptyShape = (t: ts.Type): boolean =>
    (t.flags & ts.TypeFlags.Object) !== 0 &&
    checker.getPropertiesOfType(t).length === 0 &&
    checker.getCallSignatures(t).length === 0 &&
    checker.getConstructSignatures(t).length === 0 &&
    checker.getIndexInfosOfType(t).length === 0;
  let tp: ts.Type | null = null;
  let allowNonUnit = false;
  let allowUndefined = false;
  let allowNull = false;
  const visitCompanion = (c: ts.Type): boolean => {
    if (isEmptyShape(c)) return (allowNonUnit = true);
    if (c.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return (allowUndefined = true);
    if (c.flags & ts.TypeFlags.Null) return (allowNull = true);
    // A companion UNION (`T & ({} | null)`): each part is an allowance.
    if (c.isUnionType()) return ts.constituentTypes(c).every(visitCompanion);
    return false;
  };
  const visitPart = (part: ts.Type): boolean => {
    if (!part.isIntersectionType()) return false;
    for (const p of ts.constituentTypes(part)) {
      if (p.flags & ts.TypeFlags.TypeParameter) {
        if (tp && tp !== p) return false; // two different parameters: not this pattern
        tp = p;
        continue;
      }
      if (!visitCompanion(p)) return false;
    }
    return true;
  };
  const parts: readonly ts.Type[] = type.isUnionType() ? ts.constituentTypes(type) : [type];
  if (!parts.every(visitPart) || !tp) return undefined;
  const bound = resolveTypeParam(tp);
  if (!bound) return null;
  if (bound.kind !== "union") return allowNonUnit ? bound : null;
  const def = unions.get(bound.unionId);
  if (!def) return null;
  const arms = def.arms.filter((a) =>
    a.kind === "undefinedT" ? allowUndefined : a.kind === "nullT" ? allowNull : allowNonUnit,
  );
  if (arms.length === 0) return null;
  if (arms.length === 1) return isUnitType(arms[0]!) ? null : arms[0]!;
  // Filtering preserves the canonical (typeKey-sorted) arm order.
  return { kind: "union", unionId: unions.intern(arms) };
}

/** `T[K]` inside a generic body, resolved through the instantiation's BOUND
 * checker types (the checker keeps indexed accesses over type parameters
 * symbolic). Object and index sides each resolve through resolveTypeParamTs
 * when they are type parameters; when the index lands on ONE literal key
 * (`K extends keyof T` bound to `"a"` — inference preserves the literal
 * there), the named property's type maps like a concrete member read. A
 * non-literal index (K bound to `string` or a key union) answers null: the
 * access has no one property type, and the per-site keyed-read machinery
 * (or its fences) owns the story. */
function mapBoundIndexedAccess(type: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const { checker, resolveTypeParamTs } = ctx;
  if (!resolveTypeParamTs || !type.isIndexedAccessType()) return null;
  const resolveSide = (t: ts.Type | undefined): ts.Type | null =>
    t === undefined ? null : t.flags & ts.TypeFlags.TypeParameter ? resolveTypeParamTs(t) : t;
  const objT = resolveSide(type.getObjectType());
  const idxT = resolveSide(type.getIndexType());
  if (!objT || !idxT) return null;
  const key = idxT.isStringLiteralType()
    ? idxT.value
    : idxT.isNumberLiteralType()
      ? String(idxT.value)
      : null;
  if (key === null) return null;
  const prop = checker.getPropertyOfType(objT, key);
  if (!prop) return null;
  return mapType(checker.getTypeOfSymbol(prop), ctx);
}

/** The standard library's `Parameters<F>` / `ReturnType<F>` over a type
 * parameter the current instantiation binds to a callable checker type:
 * that type's one call signature. Concrete arguments never reach here (the
 * checker evaluates those conditionals itself); generic bodies keep them
 * symbolic because their `infer` sits in a call signature. */
function boundSignatureAlias(
  type: ts.Type,
  ctx: TypeMapperCtx,
): { name: "Parameters" | "ReturnType"; sig: ts.Signature } | null {
  const { checker, resolveTypeParamTs } = ctx;
  if (!resolveTypeParamTs) return null;
  const alias = type.getAliasSymbol();
  const aliasName = alias === undefined ? undefined : ts.symbolName(alias);
  if (!alias || (aliasName !== "Parameters" && aliasName !== "ReturnType")) return null;
  const aliasArgs = type.getAliasTypeArguments();
  const arg = aliasArgs[0];
  if (aliasArgs.length !== 1 || !arg || !(arg.flags & ts.TypeFlags.TypeParameter)) return null;
  const isLibAlias = alias.declarations.some(
    (d) => ts.isTypeAliasDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
  );
  if (!isLibAlias) return null;
  const bound = resolveTypeParamTs(arg);
  if (!bound || bound.flags & ts.TypeFlags.TypeParameter) return null;
  const sigs = checker.getCallSignatures(bound);
  const sig = sigs[0];
  if (sigs.length !== 1 || !sig || sig.getTypeParameters().length > 0) return null;
  return { name: aliasName, sig };
}

/** One position of a fixed-arity parameter tuple. An optional position
 * still has a native slot (the function type's `T | undefined` slot). */
interface TupleElement {
  type: ts.Type;
  optional: boolean;
}

/** The positional parameters of a signature as a fixed tuple: a trailing
 * rest flattened when its own type is a fixed tuple. Null for a variadic
 * position, which has no fixed native arity. */
function signatureParameters(sig: ts.Signature, ctx: TypeMapperCtx): TupleElement[] | null {
  const { checker } = ctx;
  const out: TupleElement[] = [];
  for (const p of sig.getParameters()) {
    const decl = p.valueDeclaration;
    const type = checker.getTypeOfSymbol(p);
    if (decl !== undefined && ts.isParameter(decl)) {
      if (decl.dotDotDotToken !== undefined) {
        const inner = restTupleElements(type, ctx);
        if (!inner) return null;
        out.push(...inner);
        continue;
      }
      out.push({
        type,
        optional: decl.questionToken !== undefined || decl.initializer !== undefined,
      });
      continue;
    }
    out.push({ type, optional: (p.flags & ts.SymbolFlags.Optional) !== 0 });
  }
  return out;
}

/** The required-only positional parameter types of a signature (the
 * value-level `Parameters<F>` tuple), null when a position is optional
 * or variadic: such a tuple's length varies per call. */
function signatureParameterTypes(sig: ts.Signature, ctx: TypeMapperCtx): ts.Type[] | null {
  const elems = signatureParameters(sig, ctx);
  if (!elems || elems.some((e) => e.optional)) return null;
  return elems.map((e) => e.type);
}

/** The element types of a REST parameter's type when it is a fixed tuple:
 * a tuple of required elements (`[number, string]`, the empty `[]`), a type
 * parameter bound to one, or `Parameters<F>` over a bound function type.
 * Such a rest parameter has a compile-time arity, so its native ABI is the
 * flattened positional list (exactly the equivalent fixed signature —
 * TypeScript treats `(...a: [A, B]) => R` and `(a: A, b: B) => R` alike). */
export function restTupleElementTypes(type: ts.Type, ctx: TypeMapperCtx): ts.Type[] | null {
  return restTupleElements(type, ctx)?.map((e) => e.type) ?? null;
}

/** restTupleElementTypes with each position's optionality: a rest tuple
 * may end in optional positions (`[A, B?]`, `Parameters<(a: A, b?: B) =>
 * R>`), which flatten to `T | undefined` slots exactly as the function
 * type's optional parameters do. */
function restTupleElements(type: ts.Type, ctx: TypeMapperCtx): TupleElement[] | null {
  const { checker } = ctx;
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const bound = ctx.resolveTypeParamTs?.(type);
    return bound && bound !== type ? restTupleElements(bound, ctx) : null;
  }
  const viaAlias = boundSignatureAlias(type, ctx);
  if (viaAlias) {
    return viaAlias.name === "Parameters" ? signatureParameters(viaAlias.sig, ctx) : null;
  }
  if (!checker.isTupleType(type)) return null;
  const ref = type as ts.TupleTypeReference;
  const tupleShape =
    (ref.elementFlags as ts.ElementFlags[] | undefined) !== undefined
      ? ref
      : (ref.getTarget() as ts.TupleType | undefined);
  const args = checker.getTypeArguments(ref);
  if (args.length === 0) return [];
  const flags = tupleShape?.elementFlags;
  if (flags === undefined) return null;
  if (flags.some((f) => !(f & (ts.ElementFlags.Required | ts.ElementFlags.Optional)))) return null;
  return args.map((t, i) => ({
    type: t,
    optional: (flags[i]! & ts.ElementFlags.Optional) !== 0,
  }));
}

/** One tuple element's IR type under the tuple mapping's rules. */
function mapTupleElement(t: ts.Type, ctx: TypeMapperCtx): IrType | null {
  let et = (t.flags & ts.TypeFlags.Any) !== 0 ? DYN : mapType(t, ctx);
  if (et?.kind === "void" && isUnitOnlyTsType(t, ctx.resolveTypeParam))
    et = unitOnlyUnion(ctx.unions);
  return !et || et.kind === "void" ? null : et;
}

/** The mapped element types of a fixed-tuple rest parameter type
 * (restTupleElementTypes), null when it is not one or an element does not
 * map. */
export function restTupleParamTypes(type: ts.Type, ctx: TypeMapperCtx): IrType[] | null {
  const elems = restTupleElements(type, ctx);
  if (!elems) return null;
  const out: IrType[] = [];
  for (const e of elems) {
    let et = mapTupleElement(e.type, ctx);
    // An optional position's slot holds undefined when the caller omits
    // it, as an optional parameter's does (mapCallSignature).
    if (et && e.optional && et.kind !== "dyn") et = withUndefinedArm(et, ctx.unions);
    if (!et) return null;
    out.push(et);
  }
  return out;
}

/** `Parameters<F>` (the fixed tuple of F's parameters, interned exactly as
 * the spelled tuple maps) and `ReturnType<F>` (F's mapped result) over a
 * bound function-typed type parameter. */
function mapBoundSignatureAlias(type: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const target = boundSignatureAlias(type, ctx);
  if (!target) return null;
  if (target.name === "ReturnType") {
    const ret = ctx.checker.getReturnTypeOfSignature(target.sig);
    return ret.flags & ts.TypeFlags.Any ? DYN : mapType(ret, ctx);
  }
  const elems = signatureParameterTypes(target.sig, ctx);
  if (!elems) return null;
  if (elems.length === 0) return arrayOf(unitOnlyUnion(ctx.unions));
  const fields: { name: string; type: IrType }[] = [];
  for (let i = 0; i < elems.length; i++) {
    const et = mapTupleElement(elems[i]!, ctx);
    if (!et) return null;
    fields.push({ name: String(i), type: et });
  }
  fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { kind: "record", shapeId: ctx.shapes.intern(fields, true) };
}

/** `Partial<T>` / `Readonly<T>` where T is a STILL-GENERIC type parameter —
 * the one mapped-type spelling a monomorphized body can contain that the
 * checker cannot resolve for us (`keyof T` is unknown inside the body, so
 * getPropertiesOfType returns nothing). The lowerer's binding can: Readonly
 * maps exactly like T (writes are tsc errors, trusted), and Partial arms
 * every field of T's record with undefined — precisely what the longhand
 * optional spelling produces, so the result interns to the same shape as
 * the concrete `Partial<Config>` at the call boundary. Other utility
 * aliases (Pick, Omit, Record, Required) need literal KEYS or the
 * optional/required distinction, which IR types deliberately do not carry
 * (`{a?: string}` and `{a: string | undefined}` are ONE shape) — those stay
 * unmapped inside generic bodies; their concrete uses resolve structurally
 * through mapRecordType. */

/** True for a TypeNode spelling the `const` assertion (`e as const`). */
export function isConstAssertionTypeNode(t: ts.TypeNode): boolean {
  return (
    t.kind === ts.SyntaxKind.TypeReference &&
    ts.isIdentifier((t as ts.TypeReferenceNode).typeName) &&
    ((t as ts.TypeReferenceNode).typeName as ts.Identifier).text === "const"
  );
}

/** True when `n` sits inside a const assertion with only literal
 * structure between (object/array literals, property assignments,
 * parens) — the positions `as const` makes deeply readonly. */
export function underConstAssertion(n: ts.Node): boolean {
  for (
    let cur: ts.Node | undefined = n;
    cur !== undefined && !ts.isSourceFile(cur);
    cur = cur.parent
  ) {
    if (ts.isAsExpression(cur)) return isConstAssertionTypeNode(cur.type);
    if (
      !ts.isPropertyAssignment(cur) &&
      !ts.isObjectLiteralExpression(cur) &&
      !ts.isArrayLiteralExpression(cur) &&
      !ts.isParenthesizedExpression(cur)
    ) {
      return false;
    }
  }
  return false;
}

/** The `aliases: []`-under-`as const` shape (see the member walk's tsgo
 * panic repair): a property symbol declared by a property assignment whose
 * initializer is an EMPTY array literal inside a const assertion — its
 * type is provably `readonly []`, whatever the panicked query answered. */
function constAssertedEmptyArrayProp(p: ts.Symbol): boolean {
  const d = p.valueDeclaration;
  if (d === undefined || !ts.isPropertyAssignment(d)) return false;
  const init = d.initializer;
  // `a: [] as const` pins the field type by itself, wherever the literal sits.
  if (ts.isAsExpression(init) && isConstAssertionTypeNode(init.type)) {
    return (
      ts.isArrayLiteralExpression(init.expression) && init.expression.elements.nodes.length === 0
    );
  }
  if (!ts.isArrayLiteralExpression(init) || init.elements.nodes.length > 0) return false;
  return underConstAssertion(d);
}

/** A TypeScript property assignment `name: []` whose type is `never[]`. */
function emptyNeverArrayProp(p: ts.Symbol, fieldTs: ts.Type, checker: ts.TypeChecker): boolean {
  const d = p.valueDeclaration;
  if (d === undefined || !ts.isPropertyAssignment(d)) return false;
  if (isJsSourceFile(ts.getSourceFileOfNode(d))) return false;
  if (!ts.isArrayLiteralExpression(d.initializer) || d.initializer.elements.nodes.length > 0)
    return false;
  return (
    checker.isArrayType(fieldTs) &&
    (checker.getTypeArguments(fieldTs as ts.TypeReference)[0]!.flags & ts.TypeFlags.Never) !== 0
  );
}

/** A JavaScript object literal's property typed `never[]` (`{ issues: [] }`).
 * Nothing checks a JavaScript file's later writes, which can push any value
 * onto it (`ctx.common.issues.push(issue)`), so it holds the checked-dynamic
 * array rather than never's f64 element array. */
function jsNeverArrayProp(p: ts.Symbol, fieldTs: ts.Type, checker: ts.TypeChecker): boolean {
  return (
    jsObjectLiteralProperty(p) &&
    checker.isArrayType(fieldTs) &&
    (checker.getTypeArguments(fieldTs as ts.TypeReference)[0]!.flags & ts.TypeFlags.Never) !== 0
  );
}

/** A JavaScript object literal's property (`{ lastComponent: undefined }`,
 * `{ user: null }`). Nothing checks a JavaScript file's later writes, which
 * can store any value in it (`path.lastComponent = { ... }`), so a
 * property whose only initializer is a unit holds the checked-dynamic value
 * rather than the unit-only union. */
function isUnitOnlyIr(t: IrType, ctx: TypeMapperCtx): boolean {
  if (t.kind !== "union") return false;
  const def = ctx.unions.get(t.unionId);
  return def !== undefined && def.arms.every((arm) => isUnitType(arm));
}

/** A property a JavaScript object literal declares. The checker also adds
 * each missing property, optional and `undefined`, to every literal of a
 * union of literals (`{ _tag, value } | { _tag, error }` gains
 * `error?: undefined` and `value?: undefined`); those keep their unit-only
 * type, so a literal still converts to the one arm whose properties it
 * has. */
function jsObjectLiteralProperty(p: ts.Symbol): boolean {
  const d = p.valueDeclaration;
  // `__proto__: null` sets the literal's prototype; it declares no property.
  return (
    d !== undefined &&
    (ts.isPropertyAssignment(d) || ts.isShorthandPropertyAssignment(d)) &&
    ts.symbolName(p) !== "__proto__" &&
    (p.flags & ts.SymbolFlags.Optional) === 0 &&
    isJsSourceFile(ts.getSourceFileOfNode(d))
  );
}

function mapGenericAwaitedAlias(type: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const { resolveTypeParam } = ctx;
  if (!resolveTypeParam) return null;
  const alias = type.getAliasSymbol();
  if (!alias || ts.symbolName(alias) !== "Awaited") return null;
  const aliasArgs = type.getAliasTypeArguments();
  const arg = aliasArgs[0];
  if (aliasArgs.length !== 1 || !arg) return null;
  // `Awaited<ReturnType<F>>` (an async wrapper's settled result) resolves
  // through F's bound signature like a bare type parameter.
  const viaSignature =
    arg.flags & ts.TypeFlags.TypeParameter ? null : boundSignatureAlias(arg, ctx);
  if (!(arg.flags & ts.TypeFlags.TypeParameter) && viaSignature?.name !== "ReturnType") return null;
  // Provenance: the STANDARD LIBRARY's alias, not a user's shadowing one.
  const isLibAlias = alias.declarations.some(
    (d) => ts.isTypeAliasDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
  );
  if (!isLibAlias) return null;
  const bound = viaSignature ? mapBoundSignatureAlias(arg, ctx) : resolveTypeParam(arg);
  if (!bound) return null;
  let r = bound;
  while (r.kind === "promise") r = r.inner;
  return r;
}

/** `T[K]` where T is a STILL-GENERIC type parameter, resolved against the
 * lowerer's binding — the checker keeps the access symbolic inside a
 * generic body (the mockable-clock module shape: a JSDoc-generic factory
 * whose declared return carries `implementation: T[K]` members). The
 * binding decides which field types the access can name: a string-LITERAL
 * index picks its one declared field (the index signature's value type for
 * an undeclared name); an all-keys index — `keyof T` over the same
 * parameter, or an index parameter whose own binding widened to plain
 * string — covers every declared field. The mapping answers only when
 * every covered field agrees on ONE IR type (the call boundary resolved
 * the same access against the concrete T, so the shapes intern equal);
 * disagreeing fields would need a union whose arms this relation cannot
 * vouch for — those stay unmapped, keeping their fences. */
function mapGenericIndexedAccess(type: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const { resolveTypeParam, shapes } = ctx;
  if (!resolveTypeParam || !type.isIndexedAccessType()) return null;
  const obj = type.getObjectType();
  if (obj === undefined || !(obj.flags & ts.TypeFlags.TypeParameter)) return null;
  const bound = resolveTypeParam(obj);
  const idx = type.getIndexType();
  if (idx === undefined) return null;
  // `T[keyof T]` over a T bound to an unknown-valued record view
  // (`Record<string, unknown>` maps to the checked-dynamic value, see
  // mapRecordType): every member reads as unknown.
  if (bound?.kind === "dyn" && idx.isIndexType() && idx.getTarget() === obj) return DYN;
  if (!bound || bound.kind !== "record") return null;
  const shape = shapes.get(bound.shapeId);
  if (!shape || shape.tuple) return null;
  let covered: IrType[] | null = null;
  if (idx.isStringLiteralType()) {
    const f = shape.fields.find((x) => x.name === idx.value);
    covered = f ? [f.type] : shape.indexValue ? [shape.indexValue] : null;
  } else {
    const allKeys =
      ((idx.flags & ts.TypeFlags.TypeParameter) !== 0 &&
        resolveTypeParam(idx)?.kind === "string") ||
      (idx.isIndexType() && idx.getTarget() === obj);
    if (allKeys) {
      covered = shape.fields.map((f) => f.type);
      if (shape.indexValue) covered.push(shape.indexValue);
    }
  }
  if (!covered || covered.length === 0) return null;
  const first = covered[0]!;
  if (covered.every((t) => typeEquals(t, first))) return first;
  // Only the `keyof T` index itself covers every field at once; a key
  // parameter bound to string keeps its literal-key resolution below.
  if (!(idx.isIndexType() && idx.getTarget() === obj)) return null;
  // Fields of different scalar types (`Object.entries` over a bound record
  // reads `T[keyof T]`): any one of them, the union of their types.
  const arms: IrType[] = [];
  for (const t of covered) {
    const parts = t.kind === "union" ? (ctx.unions.get(t.unionId)?.arms ?? null) : [t];
    if (!parts) return null;
    for (const part of parts) {
      if (
        part.kind !== "f64" &&
        part.kind !== "string" &&
        part.kind !== "bool" &&
        part.kind !== "undefinedT" &&
        part.kind !== "nullT"
      )
        return null;
      if (!arms.some((a) => typeEquals(a, part))) arms.push(part);
    }
  }
  if (arms.length === 1) return arms[0]!;
  arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  return { kind: "union", unionId: ctx.unions.intern(arms) };
}

/** `keyof T extends never ? A : B` over a bound record T (the lib's
 * Object.entries element spelling): decided by whether the binding has any
 * key. */
function mapBoundKeyofNeverConditional(type: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const { resolveTypeParam, shapes } = ctx;
  if (!resolveTypeParam || !type.isConditionalType()) return null;
  const check = type.getCheckType();
  const ext = type.getExtendsType();
  if (!check || !ext || !(ext.flags & ts.TypeFlags.Never) || !check.isIndexType()) return null;
  const target = check.getTarget();
  if (!target || !(target.flags & ts.TypeFlags.TypeParameter)) return null;
  const bound = resolveTypeParam(target);
  // A T bound to the checked-dynamic value (`Record<string, unknown>`, an
  // unknown-valued record view) has no static key set to decide the
  // branch, but both branches of the lib's `keyof T extends never ?
  // unknown : T[keyof T]` read as unknown there: one answer either way.
  if (bound?.kind === "dyn") {
    const whenEmpty = type.getTrueType();
    const otherwise = type.getFalseType();
    const a = whenEmpty ? mapType(whenEmpty, ctx) : null;
    const b = otherwise ? mapType(otherwise, ctx) : null;
    return a && b && typeEquals(a, b) ? a : null;
  }
  if (bound?.kind !== "record") return null;
  const shape = shapes.get(bound.shapeId);
  if (!shape || shape.tuple) return null;
  const hasKeys = shape.fields.length > 0 || shape.indexValue !== undefined;
  const branch = hasKeys ? type.getFalseType() : type.getTrueType();
  return branch ? mapType(branch, ctx) : null;
}

/** A mapped type over a type parameter of the instance being lowered (`{
 * [K in keyof S]: S[K] }`, `{ [K in keyof S]: Infer<S[K]> }`): the checker
 * keeps it symbolic inside the generic body, but the instance binds `S`,
 * so each property of the bound type maps through the template evaluated
 * with `K` set to that property's key. Optionality follows the `?`
 * modifier, or the bound property's own for a homomorphic mapping. Null
 * when the shape is anything else or a template form does not evaluate. */
function mapBoundMappedType(widened: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const { checker, resolveTypeParamTs, shapes, unions } = ctx;
  if (!resolveTypeParamTs || !isMappedShape(widened)) return null;
  const symbol = widened.getSymbol();
  const node = symbol
    ? symbol.declarations.find((d): d is ts.MappedTypeNode => ts.isMappedTypeNode(d))
    : undefined;
  const constraint = node?.typeParameter.constraint;
  if (
    !node?.type ||
    !constraint ||
    !ts.isTypeOperatorNode(constraint) ||
    constraint.operator !== ts.SyntaxKind.KeyOfKeyword
  )
    return null;
  const source = checker.getTypeFromTypeNode(constraint.type);
  if (!(source.flags & ts.TypeFlags.TypeParameter)) return null;
  const bound = resolveTypeParamTs(source);
  const key = checker.getSymbolAtLocation(node.typeParameter.name);
  if (!bound || !key) return null;
  const template = checker.getTypeFromTypeNode(node.type);
  const modifier = node.questionToken?.kind;
  const fields: { name: string; type: IrType }[] = [];
  const order: string[] = [];
  for (const property of checker.getPropertiesOfType(bound)) {
    const name = ts.symbolName(property);
    const evaluated = evalMappedTemplate(template, new Map([[key, name]]), new Map(), ctx);
    let type = evaluated ? mapType(evaluated, ctx) : null;
    if (!type) return null;
    const optional =
      modifier === ts.SyntaxKind.MinusToken
        ? false
        : modifier !== undefined || (property.flags & ts.SymbolFlags.Optional) !== 0;
    if (optional) {
      const armed = withUndefinedArm(type, unions);
      if (!armed) return null;
      type = armed;
    }
    fields.push({ name, type });
    order.push(name);
  }
  fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { kind: "record", shapeId: shapes.intern(fields, false, undefined, order) };
}

/** The checker type a mapped type's template stands for at one key:
 * `keys` binds the mapped type parameter to a property name, `aliases`
 * binds type-alias and `infer` parameters met on the way. Handles type
 * parameters (through the instance's bindings), indexed accesses
 * (`S[K]`, `S[K]["_output"]`) and conditional types whose `extends` side
 * is a reference to the same generic type as the checked type
 * (`S extends Schema<infer T> ? T : never`); answers the type itself
 * when it mentions none of the bound parameters, null otherwise. */
function evalMappedTemplate(
  type: ts.Type,
  keys: Map<ts.Symbol, string>,
  aliases: Map<ts.Symbol, ts.Type>,
  ctx: TypeMapperCtx,
): ts.Type | null {
  const { checker, resolveTypeParamTs } = ctx;
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const symbol = type.getSymbol();
    if (symbol && keys.has(symbol)) return null;
    if (symbol && aliases.has(symbol)) return aliases.get(symbol)!;
    return resolveTypeParamTs?.(type) ?? null;
  }
  if (type.isIndexedAccessType()) {
    const object = type.getObjectType();
    const index = type.getIndexType();
    if (!object || !index) return null;
    const receiver = evalMappedTemplate(object, keys, aliases, ctx);
    const indexSymbol = index.flags & ts.TypeFlags.TypeParameter ? index.getSymbol() : undefined;
    const name =
      indexSymbol && keys.has(indexSymbol)
        ? keys.get(indexSymbol)!
        : index.isStringLiteralType()
          ? index.value
          : index.isNumberLiteralType()
            ? String(index.value)
            : null;
    if (!receiver || name === null) return null;
    const property = checker.getPropertyOfType(receiver, name);
    return property ? checker.getTypeOfSymbol(property) : null;
  }
  if (type.isConditionalType()) {
    // A conditional reached through an alias (`Infer<S[K]>`) checks the
    // alias's own parameters: bind them to the evaluated arguments.
    let scope = aliases;
    const alias = type.getAliasSymbol();
    const aliasArgs = type.getAliasTypeArguments();
    const aliasDecl = alias
      ? alias.declarations.find((d): d is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(d))
      : undefined;
    if (
      aliasDecl?.typeParameters?.nodes &&
      aliasArgs.length === aliasDecl.typeParameters.nodes.length
    ) {
      scope = new Map(aliases);
      for (let i = 0; i < aliasArgs.length; i++) {
        const param = checker.getSymbolAtLocation(aliasDecl.typeParameters.nodes[i]!.name);
        const arg = evalMappedTemplate(aliasArgs[i]!, keys, aliases, ctx);
        if (!param || !arg) return null;
        scope.set(param, arg);
      }
    }
    const checkType = type.getCheckType();
    const extendsType = type.getExtendsType();
    if (!checkType || !extendsType) return null;
    const checked = evalMappedTemplate(checkType, keys, scope, ctx);
    if (!checked) return null;
    const inferred =
      primitiveExtendsCheck(checked, extendsType, ctx) ??
      matchInferReference(checked, extendsType, ctx);
    if (inferred === undefined) return null;
    const branch = inferred ? type.getTrueType() : type.getFalseType();
    const branchScope = inferred ? new Map([...scope, ...inferred]) : scope;
    return evalMappedTemplate(branch, keys, branchScope, ctx);
  }
  return mentionsMappedParams(type, keys, aliases) ? null : type;
}

/** `checked extends X` where X is a primitive or literal type, or a union of
 * them (`K extends "required" ? ...`), and `checked` is one such type:
 * X has no infer positions, so assignability decides the branch (an empty
 * binding map for the true branch). A union `checked` distributes and stays
 * undecided here (undefined), as do other shapes. */
function primitiveExtendsCheck(
  checked: ts.Type,
  extendsType: ts.Type,
  ctx: TypeMapperCtx,
): Map<ts.Symbol, ts.Type> | false | undefined {
  const primitive =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined;
  const isPrimitive = (t: ts.Type): boolean =>
    !t.isUnionType() && (t.flags & primitive) !== 0 && (t.flags & ts.TypeFlags.TypeParameter) === 0;
  const extendsParts = extendsType.isUnionType() ? ts.constituentTypes(extendsType) : [extendsType];
  if (!isPrimitive(checked) || !extendsParts.every(isPrimitive)) return undefined;
  return ctx.checker.isTypeAssignableTo(checked, extendsType) ? new Map() : false;
}

/** `checked extends G<..., infer T, ...>`: the infer bindings when
 * `checked` is a reference to the same generic `G` (its arguments bind the
 * infer positions; other positions must be the same types), false when it
 * is a reference to another type or a primitive, undefined when the match
 * cannot be decided this way. */
function matchInferReference(
  checked: ts.Type,
  extendsType: ts.Type,
  ctx: TypeMapperCtx,
): Map<ts.Symbol, ts.Type> | false | undefined {
  const { checker } = ctx;
  const target = (t: ts.Type): ts.Type | undefined =>
    t.isTypeReference?.() ? (t as ts.TypeReference).getTarget?.() : undefined;
  const wantTarget = target(extendsType) ?? extendsType.getAliasSymbol();
  if (!wantTarget) return matchInferSignature(checked, extendsType, ctx);
  const gotTarget = target(checked) ?? checked.getAliasSymbol();
  if (!gotTarget)
    return checked.flags & ts.TypeFlags.Object
      ? matchInferThenable(checked, extendsType, ctx)
      : false;
  if (gotTarget !== wantTarget) return matchInferThenable(checked, extendsType, ctx);
  const wantArgs = target(extendsType)
    ? checker.getTypeArguments(extendsType as ts.TypeReference)
    : extendsType.getAliasTypeArguments();
  const gotArgs = target(checked)
    ? checker.getTypeArguments(checked as ts.TypeReference)
    : checked.getAliasTypeArguments();
  if (wantArgs.length !== gotArgs.length) return undefined;
  const inferred = new Map<ts.Symbol, ts.Type>();
  for (let i = 0; i < wantArgs.length; i++) {
    const want = wantArgs[i]!;
    const symbol = want.flags & ts.TypeFlags.TypeParameter ? want.getSymbol() : undefined;
    const isInfer = symbol
      ? symbol.declarations.some((d) => d.parent !== undefined && ts.isInferTypeNode(d.parent))
      : false;
    if (isInfer && symbol) inferred.set(symbol, gotArgs[i]!);
    else if (want !== gotArgs[i]) return undefined;
  }
  return inferred;
}

/** The type parameter an `infer X` declares, when `t` is one. */
function inferSymbolOf(t: ts.Type, _ctx: TypeMapperCtx): ts.Symbol | undefined {
  if (!(t.flags & ts.TypeFlags.TypeParameter)) return undefined;
  const symbol = t.getSymbol();
  return symbol &&
    symbol.declarations.some((d) => d.parent !== undefined && ts.isInferTypeNode(d.parent))
    ? symbol
    : undefined;
}

/** `checked extends (...args: any) => infer R` — the shape of the standard
 * library's ReturnType, over a concrete function type: R binds to its
 * result. Pattern parameters must be `any` or `any[]`, and a pattern rest
 * `any` or `any[]`; anything else stays undecided. The match follows
 * TypeScript's assignability: a primitive never matches a function type,
 * a function that needs more arguments than a pattern without a rest
 * passes never matches, and a positional `any[]` parameter needs the
 * function's parameter there to accept an array. */
function matchInferSignature(
  checked: ts.Type,
  extendsType: ts.Type,
  ctx: TypeMapperCtx,
): Map<ts.Symbol, ts.Type> | false | undefined {
  const { checker } = ctx;
  const wantSigs = checker.getCallSignatures(extendsType);
  const want = wantSigs[0];
  if (wantSigs.length !== 1 || !want || want.getTypeParameters().length > 0) return undefined;
  const wantShape = signatureShape(want, ctx);
  if (wantShape === undefined) return undefined;
  const isAny = (t: ts.Type): boolean => (t.flags & ts.TypeFlags.Any) !== 0;
  const isAnyArray = (t: ts.Type): boolean =>
    checker.isArrayType(t) && isAny(checker.getTypeArguments(t as ts.TypeReference)[0]!);
  if (!wantShape.params.every((p) => isAny(p.type) || isAnyArray(p.type))) return undefined;
  if (wantShape.rest !== null && !isAny(wantShape.rest)) return undefined;
  if (!(checked.flags & ts.TypeFlags.Object)) return false;
  const gotSigs = checker.getCallSignatures(checked);
  const got = gotSigs[0];
  if (gotSigs.length !== 1 || !got || got.getTypeParameters().length > 0) return undefined;
  const gotShape = signatureShape(got, ctx);
  if (gotShape !== undefined) {
    // `(a: any) => infer R` rejects `(a: string, b: string) => R` and
    // `(...args: [string, number]) => R`: they need more arguments.
    if (wantShape.rest === null && requiredArguments(gotShape) > wantShape.params.length)
      return false;
    for (let i = 0; i < wantShape.params.length; i++) {
      if (!isAnyArray(wantShape.params[i]!.type)) continue;
      const param = gotShape.params[i]?.type ?? gotShape.rest;
      if (param === undefined || param === null) continue;
      const accepts = acceptsArray(param, ctx);
      if (accepts !== true) return accepts;
    }
  } else if (wantShape.params.some((p) => isAnyArray(p.type))) {
    return undefined;
  }
  const wantRet = checker.getReturnTypeOfSignature(want);
  const infer = inferSymbolOf(wantRet, ctx);
  if (infer) return new Map([[infer, checker.getReturnTypeOfSignature(got)]]);
  return wantRet.flags & ts.TypeFlags.Any ? new Map() : undefined;
}

/** A signature's parameters as a call sees them: the positional ones, with
 * a fixed-tuple rest (`...args: [A, B?]`) flattened into positions, and the
 * element type of an array rest (`any` for `...args: any`). Undefined when
 * a parameter has no declaration, or the rest is a variadic tuple or
 * another type. */
function signatureShape(
  sig: ts.Signature,
  ctx: TypeMapperCtx,
): { params: { type: ts.Type; optional: boolean }[]; rest: ts.Type | null } | undefined {
  const { checker } = ctx;
  const params: { type: ts.Type; optional: boolean }[] = [];
  for (const p of sig.getParameters()) {
    const decl = p.valueDeclaration;
    if (decl === undefined || !ts.isParameter(decl)) return undefined;
    const type = checker.getTypeOfSymbol(p);
    if (decl.dotDotDotToken === undefined) {
      params.push({
        type,
        optional: decl.questionToken !== undefined || decl.initializer !== undefined,
      });
      continue;
    }
    if (type.flags & ts.TypeFlags.Any) return { params, rest: type };
    if (checker.isArrayType(type))
      return { params, rest: checker.getTypeArguments(type as ts.TypeReference)[0]! };
    const elems = restTupleElements(type, ctx);
    if (!elems) return undefined;
    for (const e of elems) params.push({ type: e.type, optional: e.optional });
    return { params, rest: null };
  }
  return { params, rest: null };
}

/** The fewest arguments a call must pass: up to the last required position. */
function requiredArguments(shape: { params: { optional: boolean }[] }): number {
  let required = 0;
  shape.params.forEach((p, i) => {
    if (!p.optional) required = i + 1;
  });
  return required;
}

/** Whether a parameter of this type accepts an `any[]` argument: true for
 * `any`, `unknown` and array types, false for primitives, undefined
 * otherwise. */
function acceptsArray(t: ts.Type, ctx: TypeMapperCtx): boolean | undefined {
  if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  if (ctx.checker.isArrayType(t)) return true;
  const primitive =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.ESSymbolLike |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Null |
    ts.TypeFlags.Void;
  return t.flags & primitive ? false : undefined;
}

/** `checked extends PromiseLike<infer U>` (or `Promise<infer U>`) over the
 * standard library's Promise: U binds to the settled type. An object with
 * no `then` member is no thenable. Everything else stays undecided. */
function matchInferThenable(
  checked: ts.Type,
  extendsType: ts.Type,
  ctx: TypeMapperCtx,
): Map<ts.Symbol, ts.Type> | false | undefined {
  const { checker } = ctx;
  const stdlibNamed = (t: ts.Type, names: readonly string[]): boolean => {
    const symbol = t.getSymbol();
    return (
      symbol !== undefined &&
      names.includes(ts.symbolName(symbol)) &&
      symbol.declarations.some((d) => ctx.isStdlibFile(ts.getSourceFileOfNode(d)))
    );
  };
  if (!stdlibNamed(extendsType, ["PromiseLike", "Promise"])) return undefined;
  const wantArgs = checker.getTypeArguments(extendsType as ts.TypeReference);
  const infer = wantArgs.length === 1 ? inferSymbolOf(wantArgs[0]!, ctx) : undefined;
  if (!infer) return undefined;
  if (stdlibNamed(checked, ["Promise", "PromiseLike"])) {
    const gotArgs = checker.getTypeArguments(checked as ts.TypeReference);
    return gotArgs.length === 1 ? new Map([[infer, gotArgs[0]!]]) : undefined;
  }
  return checker.getPropertyOfType(checked, "then") === undefined ? false : undefined;
}

/** The type mentions a mapped key or bound alias parameter (a template
 * shape evalMappedTemplate does not reduce). */
function mentionsMappedParams(
  type: ts.Type,
  keys: Map<ts.Symbol, string>,
  aliases: Map<ts.Symbol, ts.Type>,
): boolean {
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const symbol = type.getSymbol();
    return symbol !== undefined && (keys.has(symbol) || aliases.has(symbol));
  }
  if (type.isUnionType() || type.isIntersectionType())
    return ts.constituentTypes(type).some((part) => mentionsMappedParams(part, keys, aliases));
  return false;
}

function readonlyClassType(type: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const alias = type.getAliasSymbol();
  if (alias === undefined || ts.symbolName(alias) !== "Readonly") return null;
  const args = type.getAliasTypeArguments();
  if (args.length !== 1 || !args[0]) return null;
  const isLibAlias = alias.declarations.some(
    (d) => ts.isTypeAliasDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
  );
  if (!isLibAlias) return null;
  const mapped = mapType(args[0], ctx);
  return mapped !== null && isDynTypedRefType(mapped) ? mapped : null;
}

function mapGenericUtilityAlias(widened: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const { resolveTypeParam, shapes, unions } = ctx;
  if (!resolveTypeParam) return null;
  const alias = widened.getAliasSymbol();
  if (!alias || (ts.symbolName(alias) !== "Partial" && ts.symbolName(alias) !== "Readonly"))
    return null;
  const aliasArgs = widened.getAliasTypeArguments();
  const arg = aliasArgs[0];
  if (aliasArgs.length !== 1 || !arg) return null;
  if (!(arg.flags & ts.TypeFlags.TypeParameter)) return null;
  // Provenance: the STANDARD LIBRARY's alias, not a user's shadowing one.
  const isLibAlias = alias.declarations.some(
    (d) => ts.isTypeAliasDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
  );
  if (!isLibAlias) return null;
  const bound = resolveTypeParam(arg);
  if (!bound || bound.kind !== "record") return null;
  if (ts.symbolName(alias) === "Readonly") return bound;
  const shape = shapes.get(bound.shapeId);
  if (!shape) return null;
  // Partial over an index-signature shape would need `V | undefined`
  // overflow arming; no generic body needs it yet — stay unmapped.
  if (shape.indexValue) return null;
  const fields: { name: string; type: IrType }[] = [];
  for (const f of shape.fields) {
    const armed = withUndefinedArm(f.type, unions);
    if (!armed) return null;
    fields.push({ name: f.name, type: armed });
  }
  // Fields inherit the source shape's canonical (name-sorted) order — and
  // its declaration order (mapped types preserve property order in TS).
  const originalOrder = shape.declaredOrder;
  const shapeId = shapes.intern(fields, false, undefined, originalOrder);
  if (originalOrder !== undefined) {
    shapes.inheritDeclaredOrder(shapeId, originalOrder, bound.shapeId);
  }
  return { kind: "record", shapeId };
}

/** The UNIT-ONLY slot type: the interned `null | undefined` union, the one
 * representation the IR already has for values that are nothing but units.
 * Bindings and fields whose CHECKER type is a bare unit (`null`,
 * `undefined`, `void` in value position, or unions of only those) ride it:
 * the runtime value is always one of the two interned unit instances, the
 * tag is the narrowing test (`x === null`, `typeof x === "undefined"`),
 * and JSON keeps Node's split (null serializes, undefined omits). The type
 * admits an arm the checker may not spell (a `null`-typed slot gets an
 * undefined arm too) — the representation is coarser than the TS type,
 * exactly like literal widening, and tsc has already rejected every write
 * that could inhabit the extra arm. */
export function unitOnlyUnion(unions: UnionRegistry): IrType {
  const arms = [NULL_T, UNDEFINED_T];
  arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  return { kind: "union", unionId: unions.intern(arms) };
}

/** `Iterable<T>`: a union whose arms are the sources that keep their own
 * representation — `T[]`, a `Set<T>`, a `Map<K, V>` (T the `[K, V]`
 * tuple), a string (T string) — and a generator over T, which also holds
 * every other iterator (Map/Set and array iterators adapt into one). The
 * generator arm marks the union as iterable (iterableArmsElem): no other
 * union has one. Null when T has no array or generator form. */
export function iterableUnionType(
  elem: IrType,
  shapes: ShapeRegistry,
  unions: UnionRegistry,
): IrType | null {
  if (elem.kind === "void" || elem.kind === "generator" || !isSupportedArrayElem(elem)) return null;
  if (!genResultRecord(elem, VOID, shapes, unions)) return null;
  const arms: IrType[] = [
    { kind: "array", elem },
    { kind: "generator", yieldT: elem, retT: VOID, nextT: UNDEFINED_T },
  ];
  const elemArms = elem.kind === "union" ? unions.get(elem.unionId)?.arms : undefined;
  if (isSupportedSetElem(elem, elemArms)) arms.push({ kind: "set", elem });
  if (elem.kind === "string") arms.push(STRING);
  if (elem.kind === "record") {
    const shape = shapes.get(elem.shapeId);
    const [k, v] = shape?.fields ?? [];
    if (
      shape?.tuple &&
      shape.fields.length === 2 &&
      k?.name === "0" &&
      v?.name === "1" &&
      isSupportedMapKey(
        k.type,
        k.type.kind === "union" ? unions.get(k.type.unionId)?.arms : undefined,
      ) &&
      isSupportedMapValue(v.type)
    )
      arms.push({ kind: "map", key: k.type, value: v.type });
  }
  arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  return { kind: "union", unionId: unions.intern(arms) };
}

/** The IteratorResult record of a generator's value channels: `{ done:
 * boolean, value: V }` where V is dyn (an any/unknown channel) or the
 * canonical union of the yield arms, the return arms (when the return
 * channel carries a value), and `undefined` (an exhausted `.next()`
 * answers undefined). ONE shape per channel pair — `g.next()`'s lowering,
 * `.return()`, `.throw()`, the for-of desugar, and mapType's
 * IteratorResult alias mapping all intern through here, so reads agree.
 * Null when the combined union would be illegal (a promise arm beside
 * data arms, a regex/Date arm — kinds with no narrowing test here): such
 * generators stay unmapped. */
export function genResultRecord(
  yieldT: IrType,
  retT: IrType,
  shapes: ShapeRegistry,
  unions: UnionRegistry,
): (IrType & { kind: "record" }) | null {
  let valueT: IrType;
  if (yieldT.kind === "dyn" || retT.kind === "dyn") {
    valueT = DYN;
  } else {
    const byKey = new Map<string, IrType>();
    const add = (t: IrType): boolean => {
      if (t.kind === "void") return true; // no value on this channel
      if (t.kind === "union") {
        for (const a of unions.get(t.unionId)?.arms ?? []) byKey.set(typeKey(a), a);
        return true;
      }
      if (t.kind === "regex" || t.kind === "generator") {
        return false; // no legal union arm exists for these kinds
      }
      byKey.set(typeKey(t), t);
      return true;
    };
    if (!add(yieldT) || !add(retT)) return null;
    byKey.set(typeKey(UNDEFINED_T), UNDEFINED_T);
    const arms = [...byKey.values()];
    // Promises keep the shared nullable-only rule. Generator function
    // payloads retain their existing unit-only boundary too.
    if (
      !unionContainerArmsOk(arms) ||
      arms.some((a) => a.kind === "func" && !arms.every((b) => b === a || isUnitType(b)))
    ) {
      return null;
    }
    if (arms.every(isUnitType) && arms.length < 2) {
      // The degenerate no-value generator (never yields, void return):
      // the slot still needs a readable undefined — the unit-only union.
      valueT = unitOnlyUnion(unions);
    } else {
      arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
      valueT = { kind: "union", unionId: unions.intern(arms) };
    }
  }
  return {
    kind: "record",
    shapeId: shapes.intern(
      [
        { name: "done", type: BOOL },
        { name: "value", type: valueT },
      ],
      false,
      undefined,
      ["value", "done"],
    ),
  };
}

/** True when a checker type is inhabited ONLY by the unit values —
 * undefined (or `void`, whose runtime inhabitant is undefined) and null,
 * or a union of just those. The positions that today fence VOID (record
 * fields, tuple/array elements, variable slots) substitute unitOnlyUnion
 * for these; RETURN positions keep the VOID mapping (a void return is not
 * a value). */
export function isUnitOnlyTsType(t: ts.Type, resolveTypeParam?: TypeParamResolver): boolean {
  const UNIT = ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null;
  const parts: readonly ts.Type[] = t.isUnionType() ? ts.constituentTypes(t) : [t];
  return parts.every(
    (p) =>
      (p.flags & UNIT) !== 0 ||
      ((p.flags & ts.TypeFlags.TypeParameter) !== 0 && resolveTypeParam?.(p)?.kind === "void") ||
      boundVoidReturnType(p, resolveTypeParam),
  );
}

/** `ReturnType<F>` over a type parameter bound to a void-returning
 * function (a variadic wrapper's result slot): a unit-only value. */
function boundVoidReturnType(p: ts.Type, resolveTypeParam?: TypeParamResolver): boolean {
  if (!resolveTypeParam || ts.symbolNameOf(p.getAliasSymbol()) !== "ReturnType") return false;
  const args = p.getAliasTypeArguments();
  const arg = args[0];
  if (args.length !== 1 || !arg || !(arg.flags & ts.TypeFlags.TypeParameter)) return false;
  const bound = resolveTypeParam(arg);
  return bound?.kind === "func" && bound.ret.kind === "void";
}

/** IR-level `t | undefined`, canonicalized and fenced exactly like the
 * ts-union branch of mapType (typeKey-sorted arms, deduplicated;
 * Date/dyn/void arms unrepresentable; a func arm IS representable — the
 * result is exactly the nullable-callback shape mapType's union branch
 * admits, `(() => void) | undefined`) so the interned union is IDENTICAL
 * to what mapping the checker's own `T | undefined` produces. */
export function withUndefinedArm(t: IrType, unions: UnionRegistry): IrType | null {
  return withUnitArm(t, "undefinedT", unions);
}

/** Preserve a nullish runtime value that JavaScript inference omitted. */
export function withUnitArm(
  t: IrType,
  kind: "nullT" | "undefinedT",
  unions: UnionRegistry,
): IrType | null {
  const unit: IrType = { kind };

  if (t.kind === "union") {
    const def = unions.get(t.unionId);
    if (!def) return null;
    if (def.arms.some((a) => a.kind === kind)) return t;
    const arms = [...def.arms, unit];
    // Date and Promise arms beside other data arms have no union home.
    if (!unionContainerArmsOk(arms)) return null;
    arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
    return { kind: "union", unionId: unions.transform(def, arms) };
  }
  if (
    t.kind === "void" ||
    t.kind === "dyn" ||
    // A bare unit field type cannot occur (units live only inside unions),
    // but guard against constructing a single-arm union from one.
    isUnitType(t)
  ) {
    return null;
  }
  const arms = [t, unit];
  arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  return { kind: "union", unionId: unions.intern(arms) };
}

/** The chalk-shape recognizer behind mapType's hybrid branch: an
 * intersection with ONE call signature whose callable part maps to a func
 * and whose other parts are plain object refinements over data properties
 * (no construct signatures, no class identity, no index signatures). The
 * result interns a record of the data properties plus the reserved
 * `%call` slot holding the callable. `declaredOrder` lists only the DATA
 * properties — Object.keys over the hybrid answers the enumerable
 * assigned keys, which is also Node's answer for Object.assign(fn, obj)
 * (a function's own length/name are non-enumerable). Null whenever the
 * shape doesn't fit — the caller falls through to the plain-func mapping. */
function mapHybridCallableIntersection(widened: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const { checker, shapes } = ctx;
  if (!widened.isIntersectionType()) return null;
  if (checker.getCallSignatures(widened).length !== 1) return null;
  let funcPart: ts.Type | null = null;
  for (const part of ts.constituentTypes(widened)) {
    if (checker.getCallSignatures(part).length > 0) {
      if (funcPart) return null; // exactly one callable part
      funcPart = part;
      continue;
    }
    const partSym = part.getSymbol();
    if (
      (part.flags & ts.TypeFlags.Object) === 0 ||
      checker.getConstructSignatures(part).length > 0 ||
      (partSym !== undefined && (partSym.flags & ts.SymbolFlags.Class) !== 0) ||
      checker.getIndexInfosOfType(part).length > 0
    ) {
      return null;
    }
  }
  if (!funcPart) return null;
  const fn = mapType(funcPart, ctx);
  if (!fn || fn.kind !== "func") return null;
  const fields: { name: string; type: IrType }[] = [{ name: "%call", type: fn }];
  const declaredOrder: string[] = [];
  for (const p of checker.getPropertiesOfType(widened)) {
    if (p.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) return null;
    const pt = mapType(checker.getTypeOfSymbol(p), ctx);

    if (!pt || pt.kind === "void") return null;
    fields.push({ name: ts.symbolName(p), type: pt });
    declaredOrder.push(ts.symbolName(p));
  }
  if (fields.length === 1) return null; // no properties — it is just F
  fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { kind: "record", shapeId: shapes.intern(fields, false, undefined, declaredOrder) };
}

/** The record every part of a union of function-with-properties
 * intersections maps to, or null when a part does not map to the same one. */
function mapUniformHybridUnion(widened: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const parts = ts.constituentTypes(widened);
  if (!parts.every((p) => p.isIntersectionType())) return null;
  let first: IrType | null = null;
  for (const part of parts) {
    if (ctx.checker.getConstructSignatures(part).length > 0) return null;
    const mapped = mapHybridCallableIntersection(part, ctx);
    if (!mapped || (first && typeKey(mapped) !== typeKey(first))) return null;
    first ??= mapped;
  }
  return first;
}

/** Optional standard error metadata refines an existing Error identity;
 * it does not allocate a structural copy or extend its native layout. */
function mapErrorMetadataIntersection(type: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const parts = ts.constituentTypes(type);
  // Do not map unrelated intersections speculatively: mapping recursive
  // structural types can intern their representation before it is complete.
  const hasError = parts.some((part) => {
    const symbol = part.getSymbol();
    return (
      symbol !== undefined &&
      [
        "Error",
        "EvalError",
        "RangeError",
        "ReferenceError",
        "SyntaxError",
        "TypeError",
        "URIError",
        "AggregateError",
        "SuppressedError",
      ].includes(ts.symbolName(symbol)) &&
      symbol.declarations.some((decl) => ctx.isStdlibFile(ts.getSourceFileOfNode(decl)))
    );
  });
  if (!hasError) return null;
  let error: IrType | null = null;
  const extra: ts.Symbol[] = [];
  for (const part of parts) {
    const mapped = mapType(part, ctx);
    if (mapped?.kind === "object" && RUNTIME_ERROR_CLASSES.has(mapped.className)) {
      if (error && !typeEquals(error, mapped)) return null;
      error = mapped;
      continue;
    }
    if (
      ctx.checker.getCallSignatures(part).length ||
      ctx.checker.getConstructSignatures(part).length ||
      ctx.checker.getIndexInfosOfType(part).length
    )
      return null;
    for (const property of ctx.checker.getPropertiesOfType(part)) {
      const expected =
        ts.symbolName(property) === "errno"
          ? "f64"
          : ["code", "syscall", "path", "dest"].includes(ts.symbolName(property))
            ? "string"
            : null;
      if (!expected) {
        extra.push(property);
        continue;
      }
      const field = mapType(ctx.checker.getTypeOfSymbol(property), ctx);
      const arms =
        field?.kind === "union" ? ctx.unions.get(field.unionId)?.arms : field ? [field] : [];
      if (!arms?.length || !arms.every((arm) => arm.kind === expected || arm.kind === "undefinedT"))
        return null;
      // A required member must still admit the absent value the slot reads.
      if (
        !(property.flags & ts.SymbolFlags.Optional) &&
        !arms.some((arm) => arm.kind === "undefinedT")
      )
        return null;
    }
  }
  if (!error) return null;
  // Members beyond Error's own and the system-error metadata (`Error & {
  // status: number }`, Object.assign's result) are own properties of the
  // error's checked-dynamic node: each must map to a type a checked read
  // can produce. Error's own string members keep their slots.
  for (const property of extra) {
    const field = mapType(ctx.checker.getTypeOfSymbol(property), ctx);
    if (!field || field.kind === "void") return null;
    if (ts.symbolName(property) === "message" || ts.symbolName(property) === "name") {
      if (field.kind !== "string") return null;
      continue;
    }
    if (ts.symbolName(property) === "stack" || ts.symbolName(property) === "cause") return null;
    if (
      !canDynCheckTo(
        field,
        (id) => ctx.shapes.get(id),
        (id) => ctx.unions.get(id),
      )
    )
      return null;
  }
  return error;
}

/** A conventional primitive brand has one runtime-carrying primitive part
 * and one or more phantom object parts whose fields are literal marker
 * values. The marker can use a string or unique-symbol key, can be imported
 * from a declaration file, and can be expressed through a generic alias;
 * none of those facts changes the runtime value. Empty `{}` refinements are
 * the marker-free form of the same primitive narrowing.
 *
 * Arbitrary primitive/object intersections do not erase here. A companion
 * with a class identity, call/construct/index signature, accessor, or a
 * non-literal value field might describe runtime behavior, so it retains the
 * SC2008 refusal instead of borrowing the primitive representation. */
function mapBrandedPrimitiveIntersection(widened: ts.Type, ctx: TypeMapperCtx): IrType | null {
  if (!widened.isIntersectionType()) return null;
  const { checker, resolveTypeParam, resolveTypeParamTs } = ctx;
  const primitivePart = (part: ts.Type): IrType | null => {
    const base = checker.getBaseTypeOfLiteralType(part);
    if (base.flags & ts.TypeFlags.Number) return F64;
    if (base.flags & ts.TypeFlags.String) return STRING;
    if (base.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) return BOOL;
    if (base.flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) return SYMBOL_T;
    if (base.flags & (ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral)) return BIGINT_T;
    if (base.flags & ts.TypeFlags.TypeParameter) {
      const bound = resolveTypeParam?.(base) ?? null;
      if (
        bound &&
        (bound.kind === "f64" ||
          bound.kind === "bigint" ||
          bound.kind === "string" ||
          bound.kind === "bool" ||
          bound.kind === "symbol")
      ) {
        contextResolutions++;
        return bound;
      }
    }
    return null;
  };
  const markerValue = (value: ts.Type): boolean => {
    if (
      value.flags &
      (ts.TypeFlags.StringLiteral |
        ts.TypeFlags.NumberLiteral |
        ts.TypeFlags.BigIntLiteral |
        ts.TypeFlags.BooleanLiteral |
        ts.TypeFlags.UniqueESSymbol |
        ts.TypeFlags.EnumLiteral |
        ts.TypeFlags.Never |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Void |
        ts.TypeFlags.Null)
    ) {
      return true;
    }
    if (value.isUnionType()) return ts.constituentTypes(value).every(markerValue);
    if (value.flags & ts.TypeFlags.TypeParameter) {
      const bound = resolveTypeParamTs?.(value) ?? null;
      if (bound) {
        contextResolutions++;
        return markerValue(bound);
      }
    }
    return false;
  };
  let primitive: IrType | null = null;
  let markerParts = 0;
  for (const part of ts.constituentTypes(widened)) {
    const mappedPrimitive = primitivePart(part);
    if (mappedPrimitive) {
      if (primitive && !typeEquals(primitive, mappedPrimitive)) return null;
      primitive = mappedPrimitive;
      continue;
    }
    const partSym = part.getSymbol();
    const props = checker.getPropertiesOfType(part);
    if (
      (part.flags & ts.TypeFlags.Object) === 0 ||
      checker.getCallSignatures(part).length > 0 ||
      checker.getConstructSignatures(part).length > 0 ||
      checker.getIndexInfosOfType(part).length > 0 ||
      (partSym !== undefined && (partSym.flags & ts.SymbolFlags.Class) !== 0) ||
      props.some(
        (prop) =>
          (prop.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) !== 0 ||
          !markerValue(checker.getTypeOfSymbol(prop)),
      )
    ) {
      return null;
    }
    markerParts++;
  }
  return primitive && markerParts > 0 ? primitive : null;
}

/** The declaration file of @scriptc/types (installed, pnpm-linked or the
 * workspace package). */
const CONTRACT_TYPES_FILE = /[\\/](?:@scriptc[\\/]types|packages[\\/]types)[\\/]index\.d\.ts$/;

/** `Immutable<T>` over a class, interface or object literal type resolves to
 * a mapped type declared in @scriptc/types; TypeScript drops the alias, but
 * homomorphic mapped members keep their original declarations. The source
 * type is the non-generic declaration that declares every member (the most
 * derived class or interface). Null for every other type. */
function immutableSourceType(type: ts.Type, ctx: TypeMapperCtx): ts.Type | null {
  if (!isMappedShape(type)) return null;
  const { checker } = ctx;
  const symbol = type.getSymbol();
  const decl = symbol ? symbol.declarations[0] : undefined;
  if (decl === undefined || !CONTRACT_TYPES_FILE.test(ts.getSourceFileOfNode(decl).fileName))
    return null;
  const props = checker.getPropertiesOfType(type);
  const seen = new Set<ts.Node>();
  for (const prop of props) {
    const owner = prop.declarations[0]?.parent;
    if (owner === undefined || seen.has(owner)) continue;
    seen.add(owner);
    let source: ts.Type | null = null;
    if (ts.isTypeLiteralNode(owner)) source = checker.getTypeFromTypeNode(owner);
    else if (
      (ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner)) &&
      owner.name !== undefined &&
      (owner.typeParameters?.nodes.length ?? 0) === 0
    ) {
      const ownerSymbol = checker.getSymbolAtLocation(owner.name);
      if (ownerSymbol) source = checker.getDeclaredTypeOfSymbol(ownerSymbol);
    }
    if (source !== null && checker.getPropertiesOfType(source).length === props.length)
      return source;
  }
  return null;
}

/** True for MAPPED-type results — `Partial<Config>`, `Record<"a", n>`,
 * whatever `Pick`/`Omit` reduce to. Their shape is computed by the checker,
 * not declared anywhere: the only declaration behind them is the utility
 * type's `{ [P in keyof T]: ... }` machinery in lib.es5.d.ts. */
function isMappedShape(t: ts.Type): boolean {
  return (
    (t.flags & ts.TypeFlags.Object) !== 0 &&
    ((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) !== 0
  );
}

/** A declaration file an installed package ships (its own or an @types
 * twin), outside the standard library and @types/node: the type surface
 * of a package the program does not compile. Its pure type shapes —
 * interfaces, aliases, type literals — describe data a program can build
 * itself (`import type` from a types-only package such as type-fest). */
/** A class an SDK declares only to describe data (aws-sdk's
 * `declare class PresignedPost { url: string; fields: Fields }`, which
 * arrives as JSON and is never constructed): public instance fields and
 * nothing else — no constructor, methods, accessors, index signatures,
 * static, private or protected members, base classes, implemented
 * interfaces or type parameters. Its instances are exactly the records
 * of those fields, so the type maps structurally like an interface. */
function isDeclaredDataClass(d: ts.Node): boolean {
  if (!ts.isClassDeclaration(d) || !d.getSourceFile().isDeclarationFile) return false;
  if (d.heritageClauses !== undefined && d.heritageClauses.nodes.length > 0) return false;
  if (d.typeParameters !== undefined && d.typeParameters.nodes.length > 0) return false;
  return d.members.nodes.every(
    (member) =>
      ts.isPropertyDeclaration(member) &&
      !ts.isPrivateIdentifier(member.name) &&
      !(member.modifiers?.nodes ?? []).some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.StaticKeyword ||
          modifier.kind === ts.SyntaxKind.PrivateKeyword ||
          modifier.kind === ts.SyntaxKind.ProtectedKeyword ||
          modifier.kind === ts.SyntaxKind.AbstractKeyword,
      ),
  );
}

/** A namespace merged into a declared data class that holds only types
 * (`namespace PresignedPost { interface Fields { … } }`): it adds no value
 * the program could reach. */
function isTypeOnlyNamespace(d: ts.Node): boolean {
  if (!ts.isModuleDeclaration(d)) return false;
  const body = d.body;
  if (body === undefined) return true;
  if (ts.isModuleDeclaration(body)) return isTypeOnlyNamespace(body);
  if (!ts.isModuleBlock(body)) return false;
  return body.statements.nodes.every(
    (statement) =>
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      isTypeOnlyNamespace(statement),
  );
}

function packageTypeFile(sf: ts.SourceFile, ctx: Pick<TypeMapperCtx, "isStdlibFile">): boolean {
  return (
    sf.isDeclarationFile && /[\\/]node_modules[\\/]/.test(sf.fileName) && !ctx.isStdlibFile(sf)
  );
}

/** The record path's provenance fence. Declared shapes (object literals,
 * interfaces, type literals) must come from user code or an explicitly
 * mapped external type surface, never an arbitrary .d.ts — the empty
 * ambient interfaces (Object, Function, Boolean, ...) exist only to
 * satisfy tsc and must not become zero-field records. Checker-COMPUTED
 * shapes (mapped-type results, intersections) have no user declaration to
 * point at: mapped types pass here and get per-MEMBER provenance in the
 * field walk instead; an intersection passes when every part is itself an
 * ordinary provenance-passing object type (class parts keep their nominal
 * identity and never flatten into a struct). */
function recordProvenanceOk(t: ts.Type, ctx: TypeMapperCtx): boolean {
  const { checker } = ctx;
  if (t.isIntersectionType()) {
    return ts.constituentTypes(t).every((part) => {
      const partSym = part.getSymbol();
      return (
        (part.flags & ts.TypeFlags.Object) !== 0 &&
        !(partSym && partSym.flags & ts.SymbolFlags.Class) &&
        checker.getCallSignatures(part).length === 0 &&
        checker.getConstructSignatures(part).length === 0 &&
        recordProvenanceOk(part, ctx)
      );
    });
  }
  if (isMappedShape(t)) return true;
  const tSym = t.getSymbol();
  const decls = tSym ? tSym.declarations : undefined;
  if (!decls || decls.length === 0) {
    // Inferred destructuring parameters can have a synthesized anonymous
    // shape with no declaration or member symbols to trace to a source.
    return checker
      .getPropertiesOfType(t)
      .every((property) =>
        property.declarations.every(
          (decl) =>
            !ts.getSourceFileOfNode(decl).isDeclarationFile ||
            ctx.isExternalTypeFile(ts.getSourceFileOfNode(decl)) ||
            packageTypeFile(ts.getSourceFileOfNode(decl), ctx),
        ),
      );
  }
  return !decls.some((d) => {
    const sf = ts.getSourceFileOfNode(d);
    return sf.isDeclarationFile && !ctx.isExternalTypeFile(sf) && !packageTypeFile(sf, ctx);
  });
}

/** A GENERIC-callable member type (`m<T>(x: T): T` / `f: <T>(x: T) => T` in
 * an object type): pure function-shaped — call signatures only, every one
 * carrying its own type parameters — with no data properties, no construct
 * signatures, no index signatures. Such members are EXCLUDED from record
 * shapes instead of failing them: no single closure slot can hold a generic
 * function, so the shape keeps its data fields and calls of the member
 * monomorphize per call site against the defining declaration (see
 * lower-calls.ts, lowerObjLitGenericMethodCall). Node's JSON.stringify drops
 * function-valued properties, so serialization of the shape stays exact;
 * Object.keys over such a shape omits the member (a pin — every excluded
 * member is a function the key walk would name). */
export function isGenericCallableMemberType(t: ts.Type, checker: ts.TypeChecker): boolean {
  const sigs = checker.getCallSignatures(t);
  if (sigs.length === 0 || !sigs.every((s) => s.getTypeParameters().length > 0)) return false;
  return (
    checker.getConstructSignatures(t).length === 0 &&
    checker.getPropertiesOfType(t).length === 0 &&
    checker.getIndexInfosOfType(t).length === 0
  );
}

/** Result containers an erased async function or generator must keep:
 * their contents are erased instead (`Promise<T>` maps as
 * `Promise<unknown>`). */
const ERASURE_KEPT_CONTAINERS = new Set(["Promise", "Generator", "AsyncGenerator"]);

/** The type mentions a type parameter that the active erasure binds to
 * `unknown` (erasedGenericMemberType, erased bodies). */
function mentionsErasedTypeParam(type: ts.Type, ctx: TypeMapperCtx, depth: number): boolean {
  if (depth > 8) return false;
  const { checker } = ctx;
  if (type.flags & ts.TypeFlags.TypeParameter) return ctx.resolveTypeParam?.(type)?.kind === "dyn";
  if (
    type.flags &
    (ts.TypeFlags.IndexedAccess | ts.TypeFlags.Conditional | ts.TypeFlags.Substitution)
  )
    return true;
  if (type.isUnionType() || type.isIntersectionType())
    return ts.constituentTypes(type).some((part) => mentionsErasedTypeParam(part, ctx, depth + 1));
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  if (
    (type as ts.Type).isTypeReference() &&
    checker
      .getTypeArguments(type as ts.TypeReference)
      .some((arg) => mentionsErasedTypeParam(arg, ctx, depth + 1))
  )
    return true;
  for (const sig of checker.getCallSignatures(type)) {
    if (mentionsErasedTypeParam(checker.getReturnTypeOfSignature(sig), ctx, depth + 1)) return true;
    for (const param of sig.getParameters())
      if (mentionsErasedTypeParam(checker.getTypeOfSymbol(param), ctx, depth + 1)) return true;
  }
  const symbol = type.getSymbol();
  const anonymous =
    symbol !== undefined &&
    (symbol.flags & (ts.SymbolFlags.TypeLiteral | ts.SymbolFlags.ObjectLiteral)) !== 0;
  if (anonymous)
    for (const property of checker.getPropertiesOfType(type))
      if (mentionsErasedTypeParam(checker.getTypeOfSymbol(property), ctx, depth + 1)) return true;
  return false;
}

/** A generic callable member's runtime type: its one call signature with
 * every own type parameter bound to `unknown`, the erased instance a stored
 * or escaping definition carries (JavaScript erases type parameters the
 * same way). Undefined when the member has overloads or the erased
 * signature does not map: the member then stays out of the shape, and only
 * calls on a provable definition compile. */
export function erasedGenericMemberType(t: ts.Type, ctx: TypeMapperCtx): IrType | null | undefined {
  const sigs = ctx.checker.getCallSignatures(t);
  if (sigs.length !== 1) return undefined;
  const sig = sigs[0]!;
  const own = new Set<ts.Type>(sig.getTypeParameters());
  const outer = ctx.resolveTypeParam;
  const erased = mapType(t, {
    ...ctx,
    erasingSignature: sig,
    resolveTypeParam: (param) => (own.has(param) ? DYN : (outer?.(param) ?? null)),
  });
  return erased?.kind === "func" ? erased : undefined;
}

/** An OVERLOADED callable member type (`on(event: "a", h: (x: number) =>
 * void): () => void; on(event: "b", h: (x: string) => void): () => void`
 * in a program interface or type literal): two or more call signatures and
 * nothing else (no data properties, construct signatures, or index
 * signatures), every one declared in TypeScript program source. Such a
 * member keeps a record slot holding its erased runtime function
 * (erasedOverloadMemberType); calls convert per their resolved overload
 * (lowerRecordFieldCall). */
export function isOverloadedCallableMemberType(t: ts.Type, checker: ts.TypeChecker): boolean {
  const sigs = checker.getCallSignatures(t);
  if (sigs.length < 2) return false;
  if (
    checker.getConstructSignatures(t).length > 0 ||
    checker.getPropertiesOfType(t).length > 0 ||
    checker.getIndexInfosOfType(t).length > 0
  )
    return false;
  return sigs.every((sig) => {
    const decl = sig.declaration;
    if (decl === undefined) return false;
    if (!ts.isMethodSignatureDeclaration(decl) && !ts.isCallSignatureDeclaration(decl))
      return false;
    const file = ts.getSourceFileOfNode(decl);
    return !file.isDeclarationFile && !isJsSourceFile(file);
  });
}

/** Scalar arms an overload join may combine into one union. */
const OVERLOAD_JOIN_SCALARS = new Set(["f64", "string", "bool", "undefinedT", "nullT"]);

/** The join of one position's types across an overload set: equal types
 * stay; scalar mixes form their union; anything else is `unknown` when
 * every joined type crosses the checked-dynamic boundary in both directions
 * (the call site converts into the slot, the implementation converts out
 * of it). Differing callbacks (`(x: number) => void` beside `(x: string) =>
 * void`) therefore travel as checked function values, which any
 * implementation's own callback type adapts from. Null when no join
 * exists. */
function joinOverloadTypes(types: readonly IrType[], ctx: TypeMapperCtx): IrType | null {
  const first = types[0]!;
  if (types.every((t) => typeEquals(t, first))) return first;
  const getRecord = (id: string) => ctx.shapes.get(id);
  const getUnion = (id: string) => ctx.unions.get(id);
  const arms = new Map<string, IrType>();
  let scalar = true;
  for (const t of types) {
    const parts = t.kind === "union" ? (ctx.unions.get(t.unionId)?.arms ?? []) : [t];
    if (parts.length === 0) scalar = false;
    for (const part of parts) {
      if (!OVERLOAD_JOIN_SCALARS.has(part.kind)) scalar = false;
      arms.set(typeKey(part), part);
    }
  }
  if (scalar && [...arms.values()].some((arm) => !isUnitType(arm))) {
    const sorted = [...arms.values()].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
    return { kind: "union", unionId: ctx.unions.intern(sorted) };
  }
  if (
    types.every(
      (t) =>
        t.kind === "dyn" ||
        (t.kind !== "void" &&
          canConvertToDyn(t, getRecord, getUnion) &&
          canDynCheckTo(t, getRecord, getUnion)),
    )
  )
    return DYN;
  return null;
}

/** An overloaded member's runtime type (isOverloadedCallableMemberType).
 * JavaScript stores ONE function under the member; overload signatures only
 * constrain call sites. The slot's type joins the overloads per parameter
 * position and result (joinOverloadTypes), and a position some overloads
 * omit is optional. Each overload's own type parameters erase to `unknown`
 * first. Calls pick their overload statically, convert arguments into the
 * slot's parameter types and the result back to the overload's; an
 * implementation converts into the slot like any function value. Undefined
 * when the set does not join (rest parameters, a void result beside a
 * value result, a component outside the checked-dynamic boundary): the
 * member keeps its fence. */
export function erasedOverloadMemberType(t: ts.Type, ctx: TypeMapperCtx): IrType | undefined {
  const funcs: (IrType & { kind: "func" })[] = [];
  for (const sig of ctx.checker.getCallSignatures(t)) {
    const own = new Set<ts.Type>(sig.getTypeParameters());
    const outer = ctx.resolveTypeParam;
    const mapped = mapCallSignature(
      sig,
      own.size === 0
        ? ctx
        : {
            ...ctx,
            erasingSignature: sig,
            resolveTypeParam: (param) => (own.has(param) ? DYN : (outer?.(param) ?? null)),
          },
    );
    if (mapped?.kind !== "func" || mapped.rest === true || mapped.argumentsAll === true)
      return undefined;
    funcs.push(mapped);
  }
  const arity = Math.max(...funcs.map((f) => f.params.length));
  const params: IrType[] = [];
  for (let i = 0; i < arity; i++) {
    const present = funcs.filter((f) => i < f.params.length).map((f) => f.params[i]!);
    let param = joinOverloadTypes(present, ctx);
    if (param !== null && present.length < funcs.length && param.kind !== "dyn")
      param = withUndefinedArm(param, ctx.unions);
    if (param === null) return undefined;
    params.push(param);
  }
  const voids = funcs.filter((f) => f.ret.kind === "void").length;
  if (voids !== 0 && voids !== funcs.length) return undefined;
  const ret =
    voids === funcs.length
      ? VOID
      : joinOverloadTypes(
          funcs.map((f) => f.ret),
          ctx,
        );
  if (ret === null) return undefined;
  return funcOf(params, ret);
}

/** Why an overloaded member's set has no erased type
 * (erasedOverloadMemberType): the first overload, and within it the first
 * parameter or result, that does not map; otherwise the join itself. A
 * message tail after "its member 'name'". */
function describeOverloadSetBlocker(t: ts.Type, ctx: TypeMapperCtx): string {
  const { checker } = ctx;
  for (const sig of checker.getCallSignatures(t)) {
    const own = new Set<ts.Type>(sig.getTypeParameters());
    const outer = ctx.resolveTypeParam;
    const sigCtx: TypeMapperCtx =
      own.size === 0
        ? ctx
        : {
            ...ctx,
            erasingSignature: sig,
            resolveTypeParam: (param) => (own.has(param) ? DYN : (outer?.(param) ?? null)),
          };
    const mapped = mapCallSignature(sig, sigCtx);
    if (mapped?.kind === "func" && mapped.rest !== true && mapped.argumentsAll !== true) continue;
    const decl = sig.declaration;
    const spelled = decl ? ts.getTextOfNode(decl).replace(/\s+/g, " ").replace(/;$/, "") : "";
    const which = spelled ? `overload '${spelled}'` : "one overload";
    if (mapped?.kind === "func")
      return `is an overload set, and its ${which} has a rest parameter (an overload set stores one fixed-arity function)`;
    for (const param of sig.getParameters()) {
      const paramTs = checker.getTypeOfSymbol(param);
      if (!mapType(paramTs, sigCtx))
        return `is an overload set, and its ${which} has parameter '${ts.symbolName(param)}' of type '${checker.typeToString(paramTs)}', which does not compile`;
    }
    const retTs = checker.getReturnTypeOfSignature(sig);
    return `is an overload set, and its ${which} returns '${checker.typeToString(retTs)}', which does not compile`;
  }
  return "is an overload set whose signatures do not join into one stored function (a void result beside a value result, or positions whose differing types do not cross the checked-dynamic boundary)";
}

/** The computed pieces of a record shape mapRecordTypeInner hands back for
 * the OUTER frame to intern — or, when a back-reference minted a recursive
 * placeholder for the type mid-construction, to finalize INTO that
 * placeholder (the named-recursive-shape knot). */
interface RecordShapeParts {
  fields: { name: string; type: IrType }[];
  indexValue?: IrType;
  declaredOrder?: string[];
  accessorOrder?: string[];
}

function mapRecordType(widened: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const { shapes } = ctx;
  // A type whose recursive shape already finalized answers its id straight
  // off the registry (identity is per checker type; remapping would walk
  // the same members to the same answer).
  const knownRecursive = shapes.recursiveShapeFor(widened);
  if (knownRecursive !== undefined) return { kind: "record", shapeId: knownRecursive };
  // A BACK-REFERENCE to a shape currently being mapped (`interface
  // TreeNode { label: string; children: TreeNode[] }` reaching TreeNode
  // through its own field walk — directly or through arrays, unions,
  // optionals, Maps): the recursive knot. Answer a NAMED RECURSIVE SHAPE —
  // a placeholder shape-table entry whose fields fill in when the outer
  // frame completes (finalizeRecursive below). Backends represent records
  // as heap references, so the self-reference is an ordinary pointer.
  if (shapes.inProgress.has(widened)) {
    return {
      kind: "record",
      shapeId: shapes.recursiveRef(widened, () => checkerTypeDescription(widened, ctx)),
    };
  }
  shapes.inProgress.add(widened);
  const sensitivityAtEntry = contextResolutions;
  try {
    const inner = mapRecordTypeInner(widened, ctx);
    if (inner === null) return null; // a pending placeholder, if minted, stays unfinalized (prunes as unreachable)
    if (!("fields" in inner)) {
      // canonical shape). If a back-reference minted a placeholder for
      // this very type meanwhile, the two answers disagree — fence rather
      // than leave references to a shape that is not this type's mapping.
      if (shapes.recursivePending(widened) && inner.kind !== "dyn") return null;
      return inner;
    }
    if (shapes.recursivePending(widened)) {
      // The knot closed through this shape. Context-sensitive frames
      // (generic type parameters, mixin instantiations) cannot intern by
      // checker-type identity — fence recursive generic-open shapes.
      if (contextResolutions !== sensitivityAtEntry) return null;
      const recursive = shapes.finalizeRecursive(
        widened,
        inner.fields,
        inner.indexValue,
        inner.declaredOrder,
      );
      adoptAccessorOrder(shapes.get(recursive), inner.accessorOrder);
      return { kind: "record", shapeId: recursive };
    }
    // A record with no typed payload contract is a view of an existing
    // object, including across parameters and returns. Building a native
    // struct for it would copy a checked-dynamic object at each boundary
    // and sever mutation/identity. Keep the same representation as unknown;
    // constrained records and tuples retain their native layouts.
    if (
      (inner.fields.length > 0 || inner.indexValue !== undefined) &&
      inner.fields.every((field) => field.type.kind === "dyn") &&
      (inner.indexValue === undefined || inner.indexValue.kind === "dyn")
    )
      return DYN;
    const covered = coveredOptionalFieldsShape(widened, inner, ctx);
    if (covered !== null) return { kind: "record", shapeId: covered };
    const merged = dictSpreadLiteralShape(widened, inner, ctx);
    if (merged === "dyn") return DYN;
    if (merged !== null) return { kind: "record", shapeId: merged };
    const refined = refinedConstituentShape(widened, inner, ctx);
    if (refined !== null) return { kind: "record", shapeId: refined };
    const shapeId = shapes.intern(inner.fields, false, inner.indexValue, inner.declaredOrder);
    adoptAccessorOrder(shapes.get(shapeId), inner.accessorOrder);
    return { kind: "record", shapeId };
  } finally {
    shapes.inProgress.delete(widened);
  }
}

/** An index signature already describes every OPTIONAL declared member
 * whose type is its slot type: @types/node's `ProcessEnv extends
 * Dict<string> { TZ?: string }` and every spread of it, or a declared
 * environment `{ CI?: string } & Dictionary<string>`. At runtime such a
 * member is just another key, so the shape interns as the pure
 * index-signature record. Its slot admits undefined, as the optional
 * members do (`env.CI = undefined` keeps the key). A hybrid layout would
 * give each member a struct slot, which enumerates before the overflow
 * keys (Node keeps one insertion order) and makes `delete` and spread
 * answer differently for declared and undeclared keys. Required members,
 * and members typed otherwise than the slot (whose reads the slot type
 * could not give back), keep the hybrid shape. */
function coveredOptionalFieldsShape(
  widened: ts.Type,
  parts: RecordShapeParts,
  ctx: TypeMapperCtx,
): string | null {
  const slot = parts.indexValue;
  if (!slot || parts.fields.length === 0) return null;
  const { checker, shapes, unions } = ctx;
  // The members' common type must be the slot plus undefined. Read it off
  // the members (already interned) rather than building it: a hybrid that
  // does not qualify must not intern anything new.
  const optionalSlot = parts.fields[0]!.type;
  if (!parts.fields.every((field) => typeEquals(field.type, optionalSlot))) return null;
  if (optionalSlot.kind !== "union" || unions.armTag(optionalSlot.unionId, UNDEFINED_T) < 0)
    return null;
  const memberArms = unions.get(optionalSlot.unionId)?.arms ?? [];
  const slotArms =
    slot.kind === "union" ? (unions.get(slot.unionId)?.arms ?? []) : isUnitType(slot) ? [] : [slot];
  const definedArms = memberArms.filter((arm): boolean => arm.kind !== "undefinedT");
  const slotDefined = slotArms.filter((arm): boolean => arm.kind !== "undefinedT");
  if (
    definedArms.length === 0 ||
    definedArms.length !== slotDefined.length ||
    !slotDefined.every((arm) => definedArms.some((other) => typeEquals(arm, other)))
  )
    return null;
  if (!isSupportedIndexValue(optionalSlot)) return null;
  const props = checker.getPropertiesOfType(widened);
  if (props.length !== parts.fields.length) return null;
  if (!props.every((p) => (p.flags & ts.SymbolFlags.Optional) !== 0)) return null;
  return shapes.intern([], false, optionalSlot, []);
}

/** The type of an object literal that spreads an index-signature record
 * (`{ ...tags, bucket: b, status }`, the metric-tags idiom). The checker
 * drops the signature and types the literal by its explicit members only,
 * but at run time the object holds every key the spread copied, in one
 * insertion order. Such a literal maps to the pure index-signature record
 * whose slot joins the spread slots and the member types, so the merge,
 * every enumeration and keyed writes see the same keys Node does. A
 * member read still answers its member type: members written after the
 * spreads always win, and a member written before a spread must have that
 * spread's slot type, so an override cannot change its type. The join
 * covers scalar and unit types only; other literals keep their shape and
 * the spread fence. */
function dictSpreadLiteralShape(
  widened: ts.Type,
  parts: RecordShapeParts,
  ctx: TypeMapperCtx,
): string | "dyn" | null {
  if (parts.indexValue) return null;
  const symbol = widened.getSymbol();
  if (!symbol || (symbol.flags & ts.SymbolFlags.ObjectLiteral) === 0) return null;
  const literal = symbol.declarations.find((d): d is ts.ObjectLiteralExpression =>
    ts.isObjectLiteralExpression(d),
  );
  if (!literal) return null;
  const { checker, shapes, unions } = ctx;
  const props = literal.properties.nodes;
  if (!props.some((p) => ts.isSpreadAssignment(p))) return null;
  // Decide on checker types alone before mapping anything: object literals
  // with ordinary spreads are everywhere, and mapping their sources here
  // would intern types out of their usual order.
  // A literal written into a typed index-signature slot already lowers into
  // it (the merge into the contextual record); its own type keeps its
  // mapping.
  const contextualRaw = checker.getContextualType(literal);
  const contextual = contextualRaw ? checker.getNonNullableType(contextualRaw) : undefined;
  // A literal written into a declared slot lowers into that slot (a typed
  // index-signature record merges into it, a declared record converts),
  // and its own type keeps its mapping. Only a literal with no declared
  // destination (an unannotated binding, a type parameter, `any` or
  // `unknown`, an unknown-valued record) is built by its own type.
  // A generic argument's context is the instantiated parameter: the
  // literal's own type when the type argument was inferred from it.
  const ownContext =
    contextual !== undefined &&
    (contextual === widened || contextual.getSymbol()?.declarations.includes(literal) === true);
  if (
    contextual &&
    !ownContext &&
    !(contextual.flags & (ts.TypeFlags.TypeParameter | ts.TypeFlags.Any | ts.TypeFlags.Unknown))
  ) {
    const infos = checker.getIndexInfosOfType(contextual);
    const unknownValued =
      infos.length > 0 &&
      infos.every((info) => (info.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0);
    if (!unknownValued) return null;
  }
  const kinds = props.map((p) =>
    ts.isSpreadAssignment(p) ? spreadSourceKindTs(checker, p.expression) : "member",
  );
  if (kinds.some((k) => k === null) || !kinds.includes("dict")) return null;
  const dictSlotOf = (e: ts.Expression): IrType | null => {
    const t = checker.getNonNullableType(checker.getTypeAtLocation(e));
    if (checker.getPropertiesOfType(t).length === 0) {
      const infos = checker.getIndexInfosOfType(t);
      if (infos.length !== 1 || !(infos[0]!.keyType.flags & ts.TypeFlags.String)) return null;
      return mapType(infos[0]!.type, ctx);
    }
    // Another such literal's type (`{ ...tags, repo }` over a binding
    // initialized by `{ ...base, plan }`) is stored as the same kind of
    // pure index-signature record.
    if (t === widened) return null;
    const mapped = mapType(t, ctx);
    if (mapped?.kind === "dyn") return DYN;
    const shape = mapped?.kind === "record" ? shapes.get(mapped.shapeId) : undefined;
    return shape?.indexValue && shape.fields.length === 0 && !shape.tuple ? shape.indexValue : null;
  };
  const arms = new Map<string, IrType>();
  const addArms = (t: IrType): boolean => {
    const list = t.kind === "union" ? (unions.get(t.unionId)?.arms ?? []) : [t];
    for (const arm of list) {
      if (!OVERLOAD_JOIN_SCALARS.has(arm.kind)) return false;
      arms.set(typeKey(arm), arm);
    }
    return true;
  };
  const before: string[] = [];
  // An unknown-valued spread (`Record<string, unknown>`, or another such
  // literal) makes the object the checked-dynamic value: it is built like
  // a JavaScript object literal (copy each spread's own keys in order), and
  // member reads check their declared types.
  let unknownValued = false;
  for (const [i, p] of props.entries()) {
    // A fixed-shape or conditional spread contributes its own members,
    // which the checker already types exactly (they are in `parts`).
    if (kinds[i] === "record") {
      // Its members may be overwritten by a later dict spread, like members
      // written before one.
      before.push(...spreadMemberNamesTs(checker, (p as ts.SpreadAssignment).expression));
      continue;
    }
    if (ts.isSpreadAssignment(p)) {
      const slot = dictSlotOf(p.expression);
      if (slot?.kind === "dyn") {
        unknownValued = true;
        continue;
      }
      if (!slot) return null;
      if (!addArms(slot)) {
        // A slot outside the scalar join still has the checked-dynamic
        // representation when it converts to it.
        if (
          !canConvertToDyn(
            slot,
            (id) => shapes.get(id),
            (id) => unions.get(id),
          )
        )
          return null;
        unknownValued = true;
      }
      // A member written before this spread may be overwritten by it: the
      // typed join keeps member types only where the slot is that type;
      // otherwise the checked-dynamic object (whose member reads check
      // their types) holds whatever the spread wrote.
      for (const name of before) {
        const field = parts.fields.find((f) => f.name === name);
        if (!field) return null;
        if (!typeEquals(field.type, slot)) unknownValued = true;
      }
      continue;
    }
    if (!(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))) return null;
    const name = p.name;
    if (!(ts.isIdentifier(name) || ts.isStringLiteral(name))) return null;
    before.push(name.text);
  }
  if (parts.fields.some((f) => f.name.startsWith("%"))) return null;
  // Members outside the scalar join (an array of labels beside the tags)
  // make the object the checked-dynamic value too.
  if (!unknownValued && !parts.fields.every((f) => addArms(f.type))) unknownValued = true;
  if (unknownValued) {
    const getRecord = (id: string) => shapes.get(id);
    const getUnion = (id: string) => unions.get(id);
    return parts.fields.every(
      (f) => f.type.kind === "dyn" || canConvertToDyn(f.type, getRecord, getUnion),
    )
      ? "dyn"
      : null;
  }
  for (const field of parts.fields) if (!addArms(field.type)) return null;
  if (![...arms.values()].some((arm) => !isUnitType(arm))) return null;
  const sorted = [...arms.values()].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  const slot: IrType =
    sorted.length === 1 ? sorted[0]! : { kind: "union", unionId: unions.intern(sorted) };
  return shapes.intern([], false, slot, []);
}

/** How a spread source contributes to dictSpreadLiteralShape, judged on
 * checker types only: "dict" for a pure string index signature or another
 * literal that spreads one, "record" for a fixed object shape or a
 * conditional spread (`...(c && { k: v })`), null otherwise. */
function spreadSourceKindTs(checker: ts.TypeChecker, e: ts.Expression): "dict" | "record" | null {
  if (dictSpreadSourceTs(checker, e, 0)) return "dict";
  let inner = e;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (
    (ts.isBinaryExpression(inner) &&
      inner.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) ||
    ts.isConditionalExpression(inner)
  )
    return "record";
  const t = checker.getNonNullableType(checker.getTypeAtLocation(e));
  if ((t.flags & ts.TypeFlags.Object) === 0 || t.isUnionType()) return null;
  if (checker.getIndexInfosOfType(t).length > 0) return null;
  if (checker.getCallSignatures(t).length > 0 || checker.getConstructSignatures(t).length > 0)
    return null;
  const symbol = t.getSymbol();
  if (symbol && (symbol.flags & ts.SymbolFlags.Class) !== 0) return null;
  return "record";
}

/** The member names a fixed-shape or conditional spread contributes. */
function spreadMemberNamesTs(checker: ts.TypeChecker, e: ts.Expression): string[] {
  let inner = e;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  const literals: ts.Expression[] = [];
  if (ts.isBinaryExpression(inner)) literals.push(inner.right);
  else if (ts.isConditionalExpression(inner)) literals.push(inner.whenTrue, inner.whenFalse);
  else literals.push(inner);
  const names: string[] = [];
  for (const l of literals) {
    const t = checker.getNonNullableType(checker.getTypeAtLocation(l));
    for (const property of checker.getPropertiesOfType(t)) names.push(ts.symbolName(property));
  }
  return names;
}

/** A spread source the checker types as a pure string index signature,
 * or as another object literal that spreads one (dictSpreadLiteralShape),
 * judged on checker types only. */
function dictSpreadSourceTs(checker: ts.TypeChecker, e: ts.Expression, depth: number): boolean {
  const t = checker.getNonNullableType(checker.getTypeAtLocation(e));
  if (checker.getPropertiesOfType(t).length === 0) {
    const infos = checker.getIndexInfosOfType(t);
    return infos.length === 1 && (infos[0]!.keyType.flags & ts.TypeFlags.String) !== 0;
  }
  if (depth > 4) return false;
  const symbol = t.getSymbol();
  if (!symbol || (symbol.flags & ts.SymbolFlags.ObjectLiteral) === 0) return false;
  const literal = symbol.declarations.find((d): d is ts.ObjectLiteralExpression =>
    ts.isObjectLiteralExpression(d),
  );
  if (!literal) return false;
  const spreads = literal.properties.nodes.filter((p) => ts.isSpreadAssignment(p));
  return (
    spreads.length > 0 &&
    spreads.every((p) =>
      dictSpreadSourceTs(checker, (p as ts.SpreadAssignment).expression, depth + 1),
    )
  );
}

/** The first-seen accessor key order of a shape with accessor slots. */
function adoptAccessorOrder(shape: IrRecordShape | undefined, order: string[] | undefined): void {
  if (shape !== undefined && order !== undefined && shape.accessorOrder === undefined)
    shape.accessorOrder = order;
}

/** A refinement intersection (`Expr & { kind: "mul" }`, which the checker
 * reduces to `Mul & { kind: "mul" }`) keeps the shape of the constituent it
 * refines when the refinement changes no field's representation. Recursive
 * declarations own distinct shape ids even when their layouts coincide
 * (`Add` and `Mul` both `{ kind; left; right }`), and the structural key
 * names only the first of them, so interning the intersection by structure
 * could select a lookalike: a different arm of the very union the value is
 * narrowed from. Constituents still being mapped are left alone, so this
 * never mints a recursive placeholder. */
function refinedConstituentShape(
  widened: ts.Type,
  parts: RecordShapeParts,
  ctx: TypeMapperCtx,
): string | null {
  if (!widened.isIntersectionType()) return null;
  const { checker, shapes } = ctx;
  const names = checker.getPropertiesOfType(widened).map((prop) => ts.symbolName(prop));
  let found: string | null = null;
  for (const part of ts.constituentTypes(widened)) {
    if ((part.flags & ts.TypeFlags.Object) === 0 || shapes.inProgress.has(part)) continue;
    const own = new Set(checker.getPropertiesOfType(part).map((prop) => ts.symbolName(prop)));
    if (own.size !== names.length || !names.every((name) => own.has(name))) continue;
    const mapped = mapType(part, ctx);
    if (mapped?.kind !== "record") continue;
    const shape = shapes.get(mapped.shapeId);
    if (
      !shape ||
      shape.tuple ||
      shape.fields.length !== parts.fields.length ||
      !shape.fields.every(
        (field, i) =>
          field.name === parts.fields[i]!.name && typeEquals(field.type, parts.fields[i]!.type),
      ) ||
      (shape.indexValue === undefined) !== (parts.indexValue === undefined) ||
      (shape.indexValue !== undefined && !typeEquals(shape.indexValue, parts.indexValue!))
    )
      continue;
    if (found !== null && found !== mapped.shapeId) return null;
    found = mapped.shapeId;
  }
  return found;
}

/** The optional `undefined` members widening adds to an object literal's
 * type for properties only its sibling literals declare (`[{ a: 1 }, { b: 2
 * }]` gives the first `b?: undefined`). They are never own keys of the
 * literal's value, so they go after the declared members, by name. Where
 * the checker lists them is not observable: TypeScript 7.0.2 orders them
 * by the literal its checker widened first, TypeScript 7.1 by the sibling
 * that declares them. */
function wideningAddedProperties(
  type: ts.Type,
  props: readonly ts.Symbol[],
  ctx: TypeMapperCtx,
): Set<string> {
  const added = new Set<string>();
  const literal = type.getSymbol()?.declarations.find(ts.isObjectLiteralExpression);
  if (literal === undefined || literal.properties.nodes.some(ts.isSpreadAssignment)) return added;
  for (const prop of props) {
    if ((prop.flags & ts.SymbolFlags.Optional) === 0 || prop.declarations.length === 0) continue;
    if (prop.declarations.some((d) => d.parent === literal)) continue;
    if ((ctx.checker.getTypeOfSymbol(prop).flags & ts.TypeFlags.Undefined) === 0) continue;
    added.add(ts.symbolName(prop));
  }
  return added;
}

/** Whether `type` is an interface one of whose `extends` clauses names a
 * type the checker answers `any` (or an error type) for. */
function interfaceExtendsAny(type: ts.Type, checker: ts.TypeChecker): boolean {
  const symbol = type.getSymbol();
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Interface) === 0) return false;
  for (const decl of symbol.declarations) {
    if (!ts.isInterfaceDeclaration(decl)) continue;
    for (const clause of decl.heritageClauses?.nodes ?? []) {
      for (const base of clause.types.nodes) {
        if ((checker.getTypeAtLocation(base).flags & ts.TypeFlags.Any) !== 0) return true;
      }
    }
  }
  return false;
}

function mapRecordTypeInner(
  widened: ts.Type,
  ctx: TypeMapperCtx,
): IrType | RecordShapeParts | null {
  const { checker, shapes } = ctx;
  if (checker.getConstructSignatures(widened).length > 0) return null;
  if (checker.isTupleType(widened) || checker.isArrayLikeType(widened)) return null;
  // ENUM OBJECTS (`typeof e` — the enum used as a first-class value) look
  // exactly like a number-keyed hybrid (member fields + the reverse-map
  // index signature), but the VALUE has no lowering: an enum identifier in
  // value position resolves to nothing. Mapping the type would strand the
  // reference sites, so the enum-object type stays unmapped and badType
  // names the construct.
  const widenedSym = widened.getSymbol();
  if (widenedSym !== undefined && (widenedSym.flags & ts.SymbolFlags.Enum) !== 0) return null;
  // An interface extending a type the checker answers `any` for (in the
  // compiled world, a package type computed from members only its .d.ts
  // declares, such as `interface P extends z.infer<typeof S>`) has members
  // the checker cannot list: its own declared fields are not the whole
  // object. The value is checked-dynamic, never a record of the declared
  // fields alone.
  if (interfaceExtendsAny(widened, checker)) return DYN;
  // An index signature maps to a hybrid shape: declared fields keep
  // struct slots, undeclared keys ride the shape's overflow map, valued
  // uniformly by the signature's value type (`unknown` → dyn — a model-pricing table's
  // ModelPricing; `Record<string, T>` resolves here too, declared-field-
  // free). STRING and NUMBER key domains both compile — JS object keys ARE
  // strings (`o[1]` reads `o["1"]`), so a number-keyed signature is the
  // same string-keyed store with every access canonicalized through the
  // JS-exact number formatter (the access lowerings own that step). The
  // `string & {}` key — the special-intersection idiom mapped types use to
  // keep a literal-key union wide (`Record<(string & {}) | "left", T>`) —
  // is a string key: every part is string-flavored or the empty refinement.
  // BOTH signatures at once (string + number) collapse into the one store
  // when their value types intern identically (tsc requires only
  // assignability; unequal slots would need a per-key answer the store
  // cannot give). The value domain is the overflow store's
  // (isSupportedIndexValue): the map-value kinds plus 'unknown', functions
  // (the command-registry pattern), Maps/Sets, and nested index-signature
  // records; everything else stays unmapped.
  let indexValue: IrType | undefined;
  const indexInfos = checker.getIndexInfosOfType(widened);
  if (indexInfos.length > 0) {
    const stringKey = (k: ts.Type): boolean =>
      (k.flags & ts.TypeFlags.String) !== 0 ||
      (k.isIntersectionType() &&
        ts
          .constituentTypes(k)
          .every(
            (p) =>
              (p.flags & ts.TypeFlags.String) !== 0 ||
              ((p.flags & ts.TypeFlags.Object) !== 0 &&
                checker.getPropertiesOfType(p).length === 0 &&
                checker.getCallSignatures(p).length === 0 &&
                checker.getConstructSignatures(p).length === 0 &&
                checker.getIndexInfosOfType(p).length === 0),
          ));
    if (indexInfos.length > 2) return null;
    let v: IrType | null = null;
    for (const info of indexInfos) {
      if (!stringKey(info.keyType) && !(info.keyType.flags & ts.TypeFlags.Number)) return null;
      // An `any`-valued signature (`{ [key: string]: any }`, an SDK's
      // `Dictionary<any>`) holds whatever the program stores: its
      // overflow values are checked-dynamic, exactly `Record<string,
      // unknown>`'s.
      const iv = info.type.flags & ts.TypeFlags.Any ? DYN : mapType(info.type, ctx);
      if (!iv || !isSupportedIndexValue(iv)) return null;
      if (v !== null && !typeEquals(v, iv)) return null;
      v = iv;
    }
    indexValue = v!;
  }
  // The HEADER-FAMILY canonicalization: an index-signature shape whose
  // slot carries a `string[]` arm (alongside string/number/undefined —
  // nothing else) is the http header world: @types/node's
  // IncomingHttpHeaders and OutgoingHttpHeaders both declare ~60 OPTIONAL
  // well-known members over a Dict slot, and every literal SPREAD of them
  // (`{ ...req.headers, host }`) inherits those phantom members — struct
  // slots they are not; they are well-known KEYS of the slot. All such
  // shapes intern as ONE pure index-signature record over the canonical
  // OUTGOING slot `number | string | string[] | undefined` (numbers join
  // type-level only — parsed header values are strings), provided every
  // declared member's type fits inside the slot. Identical shapes make
  // the proxy's forwarded-header build (`{ ...req.headers }` into an
  // outgoing literal) a plain copy instead of an arm-wise re-tag the
  // merge machinery cannot do.
  if (indexValue?.kind === "union") {
    const slotDef = ctx.unions.get(indexValue.unionId);
    const armOk = (a: IrType): boolean =>
      a.kind === "f64" ||
      a.kind === "string" ||
      a.kind === "undefinedT" ||
      (a.kind === "array" && a.elem.kind === "string");
    // A pure Dict<string[]> is the distinct-header shape, not a general
    // outgoing-header slot: retain its precise string[] | undefined value
    // so reads from a materialized headersDistinct/trailersDistinct record
    // can use array methods without an assertion.
    const distinctOnly =
      slotDef !== undefined &&
      checker.getPropertiesOfType(widened).length === 0 &&
      slotDef.arms.length === 2 &&
      slotDef.arms.some((a) => a.kind === "array" && a.elem.kind === "string") &&
      slotDef.arms.some((a) => a.kind === "undefinedT");
    if (
      slotDef !== undefined &&
      !distinctOnly &&
      slotDef.arms.some((a) => a.kind === "array" && a.elem.kind === "string") &&
      slotDef.arms.every(armOk)
    ) {
      const armsRaw = [F64, STRING, arrayOf(STRING), UNDEFINED_T];
      armsRaw.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
      const canonical: IrType = { kind: "union", unionId: ctx.unions.intern(armsRaw) };
      const fits = (t: IrType | null): boolean => {
        if (!t) return false;
        if (t.kind === "union") {
          const def = ctx.unions.get(t.unionId);
          return def !== undefined && def.arms.every(armOk);
        }
        return armOk(t);
      };
      if (
        checker
          .getPropertiesOfType(widened)
          .every((p) => fits(mapType(checker.getTypeOfSymbol(p), ctx)))
      ) {
        return { kind: "record", shapeId: shapes.intern([], false, canonical, []) };
      }
    }
  }
  // Provenance keeps LIB type worlds out — but a PURE string index
  // signature with no declared members is structurally Record<string, V>
  // wherever it is declared (the lib's Object.fromEntries return type
  // `{ [k: string]: T }` — a data shape, not an API surface). Members, if
  // any, still walk the per-member provenance below.
  const pureIndexShape =
    indexValue !== undefined && checker.getPropertiesOfType(widened).length === 0;
  // The ANONYMOUS empty object type (`var v: {}` — the checker's shared
  // `{}` intrinsic carries a declaration-less `__type` symbol, so
  // declaration provenance has nothing to inspect): structurally the empty
  // record. tsc admits ANY non-nullish assignment into a `{}` slot;
  // non-record values fence at their assignment site (the exact-shape
  // stance), records of other shapes at theirs — the declaration itself is
  // representable.
  const anonSym = widened.getSymbol();
  const anonymousEmpty =
    (anonSym === undefined || anonSym.declarations.length === 0) &&
    !widened.isIntersectionType() &&
    indexValue === undefined &&
    checker.getPropertiesOfType(widened).length === 0;
  if (!recordProvenanceOk(widened, ctx) && !pureIndexShape && !anonymousEmpty) return null;
  // Checker-computed shapes (no user declaration) need two extra fences in
  // the member walk below; see the comments there.
  const computed = widened.isIntersectionType() || isMappedShape(widened);
  {
    const props = checker.getPropertiesOfType(widened);
    if (ctx.classImplementedProtocol?.(widened)) return DYN;
    // Symbol-keyed records use the checked object's descriptor table. A
    // checker-internal __@ name is not a string field in a native struct.
    if (props.some((property) => ts.symbolName(property).startsWith("__@"))) return DYN;
    // A computed shape with NO members is not a real empty record: inside a
    // generic body `Partial<T>` resolves to no members at all (keyof T is
    // still unknown there) — interning `{}` would give a wrong type. The
    // degenerate empties (`Partial<{}>`, `Omit<C, keyof C>`) go with it.
    // An INDEX-SIGNATURE shape is exempt: `Record<string, T>` legitimately
    // has zero declared members — the signature is the shape.
    if (computed && props.length === 0 && !indexValue) return null;
    // An empty object type — `{}` (spelled, the checker's shared
    // intrinsic, or inferred from an empty object literal), `interface
    // Empty {}` — is tsc's TOP type over non-nullish values: every number,
    // string, record, array, function, or class instance is assignable
    // into the slot, so the exact-record stance cannot hold it. It lowers
    // like `unknown` (the dyn), the same rule as `object` and the lib's
    // `Object`: assignments convert at the site (sources outside the
    // checked-dynamic tree fence there, exactly as unknown does), reads
    // narrow back out through the same checked casts. A literal's inferred
    // `{}` is no exception: union subtype reduction folds primitives into
    // it (`["12", {}]` is `{}[]`, `flag ? "x" : {}` is `{}`), and `let o =
    // {}` admits `o = "x"`. As an arm beside another non-nullish arm (the
    // union was not reduced, `string | {} | DataView`) it holds only the
    // literal's objects and stays the empty record (emptyLiteralArm).
    // Computed empties (`Partial<T>` in a generic body) returned null
    // above. Empty shapes WITH an index signature (`Record<string, T>`) are
    // not empty: the signature is the shape.
    if (
      props.length === 0 &&
      indexValue === undefined &&
      checker.getCallSignatures(widened).length === 0 &&
      checker.getConstructSignatures(widened).length === 0 &&
      !(ctx.emptyLiteralArm && isEmptyObjectLiteralType(widened, ctx))
    ) {
      return DYN;
    }
    const fields: { name: string; type: IrType }[] = [];
    for (let propertyIndex = 0; propertyIndex < props.length; propertyIndex++) {
      if (propertyIndex % 32 === 0) checker.prefetchMemberTypes(props, propertyIndex);
      const p = props[propertyIndex]!;
      if (p.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) {
        // OBJECT-LITERAL get/set accessors (TS sources): the property has
        // no data slot — the shape carries reserved closure fields instead
        // (`%get:x` invoked per read, `%set:x` per write; see
        // accessorSlotProp in ir/ir.ts). Type-literal and interface
        // accessor MEMBERS map the same way so accessor records cross
        // annotated boundaries (`function f(p: { get x(): number })`) —
        // tsc lets a plain DATA property satisfy such a member, but the
        // exact-shape stance turns that into a shape-mismatch diagnostic
        // at the literal instead of an undiagnosed split. JS-file literals keep
        // their existing paths (the CJS export-table narrowing and the
        // checked-dynamic fallback), and .d.ts declarations stay out with
        // the rest of the lib's type worlds.
        const decls = p.declarations;
        const getDecl = decls.find((d) => ts.isGetAccessorDeclaration(d));
        const setDecl = decls.find((d) => ts.isSetAccessorDeclaration(d));
        const accessorOwned =
          decls.length > 0 &&
          decls.every(
            (d) =>
              (ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d)) &&
              d.parent !== undefined &&
              (ts.isObjectLiteralExpression(d.parent) ||
                ts.isInterfaceDeclaration(d.parent) ||
                d.parent.kind === ts.SyntaxKind.TypeLiteral) &&
              !ts.getSourceFileOfNode(d).isDeclarationFile &&
              !isJsSourceFile(ts.getSourceFileOfNode(d)),
          );
        if (!accessorOwned || (!getDecl && !setDecl)) return null;
        // Symbol-keyed accessors have no foldable literal name to fill at
        // the literal — no slot to make.
        if (ts.symbolName(p).startsWith("__@")) return null;
        // An index-signature shape stores accessor NAMES nowhere the keyed
        // read/walk machinery can answer (the overflow would miss where
        // Node dispatches the getter) — those shapes stay unmapped.
        if (indexValue !== undefined) return null;
        let readT: IrType | null = null;
        if (getDecl) {
          readT = mapType(checker.getTypeOfSymbol(p), ctx);
          if (readT === null) return null;
        }
        let writeT: IrType | null = null;
        if (setDecl) {
          const param = (setDecl as ts.SetAccessorDeclaration).parameters.nodes[0];
          if (!param) return null;
          writeT = mapType(checker.getTypeAtLocation(param), ctx);
          // A void/unit-typed write slot has no value form; DIVERGENT
          // getter/setter types stay out too (one property, one type —
          // the class-accessor stance).
          if (writeT === null || writeT.kind === "void" || isUnitType(writeT)) return null;
          if (readT !== null && typeKey(readT) !== typeKey(writeT)) return null;
        }
        if (readT !== null || getDecl)
          fields.push({ name: `%get:${ts.symbolName(p)}`, type: funcOf([], readT ?? VOID) });
        if (writeT !== null)
          fields.push({ name: `%set:${ts.symbolName(p)}`, type: funcOf([writeT], VOID) });
        continue;
      }
      // Computed shapes carry provenance per MEMBER: a utility type over a
      // lib interface (`Readonly<Date>`) is still the lib's type world, not
      // a data shape. Synthesized members (a literal-key Record's) have no
      // declarations and pass.
      if (
        computed &&
        p.declarations.some((d) => {
          const sf = ts.getSourceFileOfNode(d);
          return sf.isDeclarationFile && !ctx.isExternalTypeFile(sf) && !packageTypeFile(sf, ctx);
        })
      ) {
        return null;
      }
      const fieldTs = checker.getTypeOfSymbol(p);
      // GENERIC-callable members leave the shape (no single closure slot
      // can hold them — see isGenericCallableMemberType): the shape keeps
      // its data fields, and calls of the member monomorphize per call
      // site against the defining object literal's declaration.
      // OVERLOADED members hold their erased runtime function (see
      // erasedOverloadMemberType); a set that does not join fails the
      // shape as before.
      let pt = isGenericCallableMemberType(fieldTs, checker)
        ? erasedGenericMemberType(fieldTs, ctx)
        : isOverloadedCallableMemberType(fieldTs, checker)
          ? (erasedOverloadMemberType(fieldTs, ctx) ?? null)
          : mapType(fieldTs, ctx);
      if (pt === undefined) continue;
      // tsgo PANICS computing `readonly []` through the symbol-type query
      // (the TupleType conversion — the facade's panic fence answers
      // `any`), which would absorb the whole shape into the dynamic tier.
      // The declaration pins the truth syntactically: a property whose
      // initializer is an EMPTY array literal inside a const assertion IS
      // the empty tuple — map it exactly as the tuple branch does (the
      // unit-element array; see the `[] as const` rule there).
      if (
        pt === null &&
        (fieldTs.flags & ts.TypeFlags.Any) !== 0 &&
        constAssertedEmptyArrayProp(p)
      ) {
        pt = arrayOf(unitOnlyUnion(ctx.unions));
      }
      // A TypeScript property initialized with an empty literal and typed
      // `never[]` (`const out = { files: [] }`) holds no element, so it maps
      // like the empty tuple: the unit-only element array, which a
      // destination's typed array field (`files: string[]`) receives through
      // the checked empty-array lift. never's f64 element would make it a
      // `number[]` field.
      if (pt?.kind === "array" && emptyNeverArrayProp(p, fieldTs, checker))
        pt = arrayOf(unitOnlyUnion(ctx.unions));
      if (pt === null && (fieldTs.flags & ts.TypeFlags.Any) !== 0) pt = DYN;
      // An `any[]` field (`list: any[]` in an SDK's message type, also
      // optional or nullable) is the checked-dynamic array, exactly as
      // `unknown[]` maps; the checked-dynamic value holds the units too.
      // Declared members only: an object literal's inferred `any[]` member
      // keeps its existing story.
      if (
        pt === null &&
        declaredMember(p) &&
        (fieldTs.isUnionType() ? ts.constituentTypes(fieldTs) : [fieldTs]).every(
          (part) =>
            isAnyArrayType(part, checker) ||
            (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0,
        ) &&
        !isUnitOnlyTsType(fieldTs, ctx.resolveTypeParam)
      )
        pt = DYN;
      // Unit-only FIELDS (`{ msg?: undefined }` — the discriminated-union
      // absent-field idiom — and `{ p: undefined }` spellings): the
      // unit-only union. The runtime value is the interned unit, JSON
      // omits the undefined arm exactly like an omitted optional.
      if (pt?.kind === "void" && isUnitOnlyTsType(fieldTs, ctx.resolveTypeParam))
        pt = unitOnlyUnion(ctx.unions);
      if (pt !== null && isUnitOnlyIr(pt, ctx) && jsObjectLiteralProperty(p)) pt = DYN;
      if (pt?.kind === "array" && jsNeverArrayProp(p, fieldTs, checker)) pt = DYN;
      // dyn FIELDS map now (`{ v: unknown }`, `[string, unknown]` tuples):
      // the slot carries a dyn value exactly like an `unknown`-valued
      // overflow entry — same RC adapters, same dynFrom conversion on the
      // way in, same checked casts on the way out. (JSON.stringify of a
      // dyn-field-bearing shape keeps its fence: jsonSafe stays false.)
      if (!pt || pt.kind === "void") return null;
      // A DATA property spelled like a reserved accessor slot (`{ "%get:x":
      // v }` — a string-literal key): mapping it would collide with the
      // accessor dispatch, so the shape stays unmapped.
      if (accessorSlotProp(ts.symbolName(p)) !== null) return null;

      // an options record with `signal?: AbortSignal` must not turn its

      fields.push({ name: ts.symbolName(p), type: pt });
    }
    // getPropertiesOfType yields DECLARATION order (interface/alias/literal
    // source order) — captured before the canonical sort so Object.keys/
    // entries/values can emit it (SEMANTICS.md 36). Two rules compose:
    // accessor slots stay out like every '%'-field (key-order surfaces
    // over accessor-carrying shapes fence by name at their lowerings),
    // and JS's own-key order applies — integer-like keys (canonical array
    // indices, from folded numeric computed keys and quoted numeric keys)
    // enumerate FIRST ascending, then string keys in insertion order
    // (OrdinaryOwnPropertyKeys) — Object.keys/JSON/inspect all read it.
    const widenedAbsent = wideningAddedProperties(widened, props, ctx);
    const declaredOrder = esOwnKeyOrder(
      fields
        .filter((f) => accessorSlotProp(f.name) === null && !widenedAbsent.has(f.name))
        .map((f) => f.name)
        .concat([...widenedAbsent].sort()),
    );
    // With accessors: every own key in that order, an accessor property
    // named once for its get/set pair (the checked-dynamic copy lists it).
    const accessorOrder = fields.some((f) => accessorSlotProp(f.name) !== null)
      ? esOwnKeyOrder([...new Set(fields.map((f) => accessorSlotProp(f.name)?.prop ?? f.name))])
      : undefined;
    fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      fields,
      ...(indexValue ? { indexValue } : {}),
      declaredOrder,
      ...(accessorOrder ? { accessorOrder } : {}),
    };
  }
}

/* ── Component-fence classification (SC2009) ───────────────────────────────
 * badType's post-hoc classifiers: given a type mapType REJECTED, decide
 * whether the failure lives in a COMPONENT of an otherwise supported shape
 * — and if so, name it. Pure description: these run only on the failure
 * path (the build already carries a diagnostic for the site), mirror
 * mapType's own rules, and never change what maps. Probing through mapType
 * here is safe for the same reason badType's dynamic probe is: anything
 * interned on the way belongs to a build that is not emitted. */

/** The recognized stdlib containers and the slot name each type-argument
 * position plays in their messages. */
const STDLIB_CONTAINERS: Record<string, { role: (i: number) => string }> = {
  Map: { role: (i) => (i === 0 ? "key" : "value") },
  ReadonlyMap: { role: (i) => (i === 0 ? "key" : "value") },
  Set: { role: () => "element" },
  ReadonlySet: { role: () => "element" },
  Promise: { role: () => "value" },
  Generator: { role: (i) => ["yield", "return", "next"][i] ?? "channel" },
  AsyncGenerator: { role: (i) => ["yield", "return", "next"][i] ?? "channel" },
};

/** The `string | object`-family collapse domain (mapTypeInner's union
 * rule): arms the checked-dynamic representation holds FAITHFULLY, so a
 * union carrying a dyn arm beside only these maps to DYN wholesale.
 * Scalars and units are the checked-dynamic tree's own kinds (value-exact ===/typeof);
 * records and arrays qualify exactly when the dynFrom conversion can
 * build them (canConvertToDyn — JSON-safe data plus bytes-bearing
 * composites), entering as dyn data under the documented deep-copy
 * stance. Everything else — class instances, Maps/Sets, functions
 * (closure identity and `x === String` narrowing live in the typed union
 * machinery), promises, regexes, generators, handles, nested unions —
 * would DEGRADE (identity, methods, dispatch) riding dyn, so those arms
 * keep their existing homes and fences. */
function dynSubsumableUnionArm(arm: IrType, ctx: TypeMapperCtx): boolean {
  switch (arm.kind) {
    case "dyn":
    case "f64":
    case "string":
    case "bool":
    case "undefinedT":
    case "nullT":
      return true;
    // URL boxes BY REFERENCE (its checked-dynamic handle keeps identity,
    // reads and writes its members through the native accessors, answers
    // `instanceof URL`, and checks back out to the typed value), so it
    // rides the collapse beside fetch's Request/Response handles:
    // `string | URL | Request`, fetch's own input type under @types/node.
    case "url":
      return true;
    case "record":
    case "array":
    // `T | Promise<T>` with T bound to `unknown`: the checked-dynamic value
    // holds a promise by reference, so `unknown` absorbs the promise arm
    // exactly as the checker's own union reduction does.
    case "promise":
      return canConvertToDyn(
        arm,
        (id) => ctx.shapes.get(id),
        (id) => ctx.unions.get(id),
      );
    default:
      return false;
  }
}

/** A parameter of a function type that is the default of a type parameter
 * declared in node:test's standard-library declarations (MockTracker.fn's
 * `F extends Function = (...args: any[]) => undefined`). */
function isNodeTestDefaultFunctionParam(decl: ts.Declaration, ctx: TypeMapperCtx): boolean {
  const fnType = decl.parent;
  return (
    ts.isParameter(decl) &&
    fnType !== undefined &&
    ts.isFunctionTypeNode(fnType) &&
    fnType.parent !== undefined &&
    ts.isTypeParameterDeclaration(fnType.parent) &&
    fnType.parent.defaultType === fnType &&
    ctx.isStdlibFile(ts.getSourceFileOfNode(decl)) &&
    isDeclaredInAmbientModule(decl, "test")
  );
}

/** `any[]` (or `readonly any[]`): an array type whose element is `any`. */
export function isAnyArrayType(t: ts.Type, checker: ts.TypeChecker): boolean {
  if (!checker.isArrayType(t)) return false;
  const elem = checker.getTypeArguments(t as ts.TypeReference)[0];
  return elem !== undefined && (elem.flags & ts.TypeFlags.Any) !== 0;
}

/** The maybe-promise union rule (mapTypeInner's union rule; IR
 * maybePromiseUnionArmsOk): at most one promise arm, and when it has data
 * siblings none of them may be thenable — `await` and async `return`
 * dispatch on the union tag, so a data arm whose type declares `then`
 * would skip the thenable adoption JS performs. */
function maybePromiseUnionOk(
  parts: readonly ts.Type[],
  arms: IrType[],
  ctx: TypeMapperCtx,
): boolean {
  if (unionContainerArmsOk(arms)) return true;
  if (!maybePromiseUnionArmsOk(arms)) return false;
  // A function beside a promise (`Promise<T> | (() => Promise<T>)`, the
  // assert.rejects argument) keeps its existing representation: callers
  // dispatch on callability, not on a then-able promise.
  if (arms.some((arm) => arm.kind === "func")) return false;
  return maybePromiseThenableArm(parts, ctx) === null;
}

/** The first non-promise constituent of a promise-armed union whose type
 * has a `then` member (a thenable data arm), or null. */
function maybePromiseThenableArm(parts: readonly ts.Type[], ctx: TypeMapperCtx): ts.Type | null {
  const { checker } = ctx;
  for (const part of parts) {
    if (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null)) continue;
    if (mapType(part, ctx)?.kind === "promise") continue;
    // Primitive arms answer through their wrapper prototypes, none of
    // which has `then`; object arms answer through their own members.
    if (checker.getPropertyOfType(part, "then")) return part;
  }
  return null;
}

/** Arm kinds with no home in a compiled union (mapTypeInner's union rule):
 * no runtime narrowing test exists against sibling data arms. */
function armHasUnionHome(arm: IrType): boolean {
  switch (arm.kind) {
    case "void":
    case "union":
    case "regex":
    case "generator":
    case "dyn":
      return false;
    default:
      return true;
  }
}

/** When an unmapped type is a SUPPORTED container/composite whose failure
 * lives in a component, answer a message tail naming the component (the
 * SC2009 story); null when the shape itself is the blocker (the caller
 * falls through to the other fences). Stdlib container heads (Map, Set,
 * Promise, generators) ALWAYS answer — their shapes have lowerings, so a
 * later "no lowering" claim about them would be false. */
export function describeComponentBlocker(widened: ts.Type, ctx: TypeMapperCtx): string | null {
  const { checker } = ctx;
  const text = (t: ts.Type): string => checker.typeToString(t);

  // Stdlib container references (provenance, not the name — a user's own
  // `interface Map` is a record shape and keeps the record stories).
  const psym = widened.getSymbol();
  const container =
    psym !== undefined &&
    Object.prototype.hasOwnProperty.call(STDLIB_CONTAINERS, ts.symbolName(psym)) &&
    psym.declarations.some(
      (d) => ts.isInterfaceDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
      ? ts.symbolName(psym)
      : undefined;
  if (container !== undefined) {
    const spec = STDLIB_CONTAINERS[container]!;
    const args = checker.getTypeArguments(widened as ts.TypeReference);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      const role = spec.role(i);
      const mapped = mapType(arg, ctx);
      if (!mapped) {
        return `the ${container} shape is supported, but its ${role} type '${text(arg)}' does not compile`;
      }
      if (
        (container === "Map" || container === "ReadonlyMap") &&
        i === 0 &&
        !isSupportedMapKey(
          mapped,
          mapped.kind === "union" ? ctx.unions.get(mapped.unionId)?.arms : undefined,
        )
      ) {
        return `the ${container} shape is supported, but '${text(arg)}' is outside its supported key domain (numbers, strings, booleans, bigints, identity references, or supported unions)`;
      }
      if (
        (container === "Map" || container === "ReadonlyMap") &&
        i === 1 &&
        !isSupportedMapValue(mapped)
      ) {
        return `the ${container} shape is supported, but '${text(arg)}' values have no Map slot yet`;
      }
      if (
        (container === "Set" || container === "ReadonlySet") &&
        !isSupportedSetElem(
          mapped,
          mapped.kind === "union" ? ctx.unions.get(mapped.unionId)?.arms : undefined,
        )
      ) {
        return `the ${container} shape is supported, but '${text(arg)}' is outside its supported element domain (numbers, strings, booleans, bigints, identity references, or supported unions)`;
      }
    }
    // Every argument passed the per-slot checks and the type still failed:
    // a composition rule the slots alone don't show (a generator's channel
    // interplay, a promise wrapper rule). Still the container's story.
    return `the ${container} shape is supported, but this instantiation's type arguments are outside the supported set`;
  }

  // Arrays: the element is the failure by construction (a mappable element
  // makes the array map).
  if (checker.isArrayType(widened)) {
    const elemTs = checker.getTypeArguments(widened as ts.TypeReference)[0];
    if (elemTs === undefined) return null;
    const elem = mapType(elemTs, ctx);
    if (!elem) {
      return `the array shape is supported, but its element type '${text(elemTs)}' does not compile`;
    }
    return `the array shape is supported, but '${text(elemTs)}' elements have no array representation yet`;
  }

  // Tuples: name the first element whose type does not map. Optional/rest
  // tuples in static builds are dynamic-representable and never get here
  // (badType's dynamic probe speaks first).
  if (checker.isTupleType(widened)) {
    for (const arg of checker.getTypeArguments(widened as ts.TypeReference)) {
      const et = mapType(arg, ctx);
      if (et?.kind === "void" && isUnitOnlyTsType(arg, ctx.resolveTypeParam)) continue;
      if (!et || et.kind === "void") {
        return `the tuple shape is supported, but its element type '${text(arg)}' does not compile`;
      }
    }
    return null;
  }

  // Unions: name the first arm that does not compile, or the first mapped
  // arm kind with no union home. Unions have no symbol, so a null answer
  // falls through to the residual fence, never to a false lib claim.
  if (widened.isUnionType()) {
    const parts = ts.constituentTypes(widened);
    const UNIT = ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null;
    const dataArms = parts.filter((p) => (p.flags & UNIT) === 0);
    // A union carrying an 'object'/'unknown'-flavored arm rides the
    // checked-dynamic representation WHOLESALE when every sibling is
    // dyn-subsumable (mapTypeInner's collapse) — so when such a union
    // still failed, the story is the sibling that CANNOT ride the
    // collapse, never the dyn arm itself.
    const mappedArms = dataArms.map((p) => ({ p, mapped: mapType(p, ctx) }));
    if (mappedArms.some(({ mapped }) => mapped?.kind === "dyn")) {
      const blocker = mappedArms.find(
        ({ mapped }) => mapped !== null && !dynSubsumableUnionArm(mapped, ctx),
      );
      if (blocker) {
        return `the union shape is supported, and unions in the 'string | object' family ride the checked-dynamic representation wholesale, but '${text(blocker.p)}' arms have a typed representation whose semantics (identity, methods, dispatch) do not survive that collapse`;
      }
      // Every sibling subsumable and the union STILL failed: the
      // recursive-placeholder fence (a degenerate spelling) — no per-arm
      // story is true, so the residual fence speaks.
      return null;
    }
    for (const { p: part, mapped } of mappedArms) {
      if (!mapped) {
        return `the union shape is supported, but its arm '${text(part)}' does not compile`;
      }
      if (!armHasUnionHome(mapped)) {
        return `the union shape is supported, but '${text(part)}' arms have no home in a compiled union yet (no runtime narrowing test exists against sibling arms)`;
      }
    }
    const promiseArms = mappedArms.filter(({ mapped }) => mapped?.kind === "promise");
    if (promiseArms.length > 1) {
      return `the union shape is supported, but it has several promise arms ('${text(promiseArms[0]!.p)}' and '${text(promiseArms[1]!.p)}'), and a compiled union holds at most one (the union tag is the 'instanceof Promise' test)`;
    }
    if (promiseArms.length === 1 && dataArms.length > 1) {
      const callable = mappedArms.find(({ mapped }) => mapped?.kind === "func");
      if (callable) {
        return `the union shape is supported, but its function arm '${text(callable.p)}' sits beside a promise arm, and a maybe-promise union holds only data arms beside its promise`;
      }
      const thenable = maybePromiseThenableArm(parts, ctx);
      if (thenable) {
        return `the union shape is supported, but its arm '${text(thenable)}' declares 'then' beside a promise arm, so 'await' would have to adopt it as a thenable (a maybe-promise union's data arms must not be thenable)`;
      }
    }
    return null;
  }

  // Single-signature, non-generic function types: a parameter type or the
  // return type carries the failure. Typed rest parameters use their array
  // type here like any other completed ABI slot. (Generic and
  // overloaded signatures have their own fences — SC2005/SC2007 — and
  // badType runs those first.)
  const callSigs = checker.getCallSignatures(widened);
  if (callSigs.length === 1) {
    const sig = callSigs[0]!;
    if (sig.getTypeParameters().length > 0) return null;
    const sigDecl = sig.declaration;
    if (
      sigDecl !== undefined &&
      ts.isFunctionLike(sigDecl) &&
      (runtimeParameterCount(sigDecl.parameters.nodes) !== sig.getParameters().length ||
        bodyReadsArguments(sigDecl))
    ) {
      return `the function shape is supported, but its signature is variadic ('arguments'-reading), and a compiled signature is fixed-arity`;
    }
    for (const p of sig.getParameters()) {
      const pTs = checker.getTypeOfSymbol(p);
      if (!mapType(pTs, ctx)) {
        return `the function shape is supported, but its parameter '${ts.symbolName(p)}' has type '${text(pTs)}', which does not compile`;
      }
    }
    const retTs = checker.getReturnTypeOfSignature(sig);
    if ((retTs.flags & ts.TypeFlags.Never) === 0 && !mapType(retTs, ctx)) {
      return `the function shape is supported, but its return type '${text(retTs)}' does not compile`;
    }
    return null;
  }

  return null;
}

/** The record-member arm of the component fence: a USER record shape
 * blocked by ONE member's type. Runs AFTER badType's stdlib/npm/index-
 * signature routing, so what reaches it is a plain data shape; a null
 * answer (no member pinpointed — provenance fences, accessor rules, shape
 * knots) keeps the residual SC2001 story. */
export function describeRecordMemberBlocker(widened: ts.Type, ctx: TypeMapperCtx): string | null {
  const { checker } = ctx;
  if ((widened.flags & ts.TypeFlags.Object) === 0) return null;
  if (checker.getCallSignatures(widened).length > 0) return null;
  if (checker.getConstructSignatures(widened).length > 0) return null;
  if (checker.isTupleType(widened) || checker.isArrayLikeType(widened)) return null;
  if (checker.getIndexInfosOfType(widened).length > 0) return null;
  const widenedSym = widened.getSymbol();
  if (widenedSym !== undefined && (widenedSym.flags & ts.SymbolFlags.Enum) !== 0) return null;
  const computed = isMappedShape(widened);
  for (const p of checker.getPropertiesOfType(widened)) {
    // Accessor members and symbol-keyed members have their own multi-shaped
    // rules (mapRecordTypeInner) — no single-member claim is honest there.
    if ((p.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) !== 0) continue;
    if (ts.symbolName(p).startsWith("__@")) continue;
    // Computed shapes over LIBRARY members (`Readonly<Date>`): the record
    // fence there is per-member PROVENANCE (mapRecordTypeInner's rule), not
    // any one member's type — that story stays with the residual fence.
    if (
      computed &&
      p.declarations.some((d) => {
        const sf = ts.getSourceFileOfNode(d);
        return sf.isDeclarationFile && !ctx.isExternalTypeFile(sf) && !packageTypeFile(sf, ctx);
      })
    ) {
      return null;
    }
    const fieldTs = checker.getTypeOfSymbol(p);
    if (isOverloadedCallableMemberType(fieldTs, checker)) {
      if (erasedOverloadMemberType(fieldTs, ctx) !== undefined) continue;
      return `the record shape is supported, but its member '${ts.symbolName(p)}' ${describeOverloadSetBlocker(fieldTs, ctx)}`;
    }
    if (memberMaps(fieldTs, ctx, p)) continue;
    // Name the deepest member the failure comes from (`order.deployment.
    // builds[].config`): a large message type otherwise points only at
    // its outermost member.
    const inner = innerBlockedMember(fieldTs, ctx, new Set());
    if (inner !== null && inner.path !== "") {
      return `the record shape is supported, but its member '${ts.symbolName(p)}${inner.path}' has type '${checker.typeToString(inner.type)}', which does not compile`;
    }
    return `the record shape is supported, but its member '${ts.symbolName(p)}' has type '${checker.typeToString(fieldTs)}', which does not compile`;
  }
  return null;
}

/** A member an interface, type literal or class declares (not one an
 * object literal's inferred type carries). */
function declaredMember(member: ts.Symbol): boolean {
  return (
    member.declarations.length > 0 &&
    member.declarations.every((d) => ts.isPropertySignature(d) || ts.isPropertyDeclaration(d))
  );
}

/** Whether a record member of type `fieldTs` maps, by the member rules of
 * mapRecordTypeInner (generic members erase; `any` and `any[]` members
 * are checked-dynamic; unit-only members are the unit union). Overloaded
 * members answer true: describeOverloadSetBlocker tells their story. */
function memberMaps(fieldTs: ts.Type, ctx: TypeMapperCtx, member?: ts.Symbol): boolean {
  const { checker } = ctx;
  if (isOverloadedCallableMemberType(fieldTs, checker)) return true;
  const pt = isGenericCallableMemberType(fieldTs, checker)
    ? erasedGenericMemberType(fieldTs, ctx)
    : mapType(fieldTs, ctx);
  if (pt === undefined) return true;
  if (pt === null && (fieldTs.flags & ts.TypeFlags.Any) !== 0) return true;
  if (
    pt === null &&
    (member === undefined || declaredMember(member)) &&
    (fieldTs.isUnionType() ? ts.constituentTypes(fieldTs) : [fieldTs]).every(
      (part) =>
        isAnyArrayType(part, checker) ||
        (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0,
    ) &&
    !isUnitOnlyTsType(fieldTs, ctx.resolveTypeParam)
  )
    return true;
  if (pt?.kind === "void" && isUnitOnlyTsType(fieldTs, ctx.resolveTypeParam)) return true;
  return pt !== null && pt.kind !== "void";
}

/** The member path inside the unmapped type `t` that its failure comes
 * from, and that member's type: `.name` steps into record members, `[]`
 * into array elements, `()` into a function's return; union arms and
 * promise payloads are transparent. The empty path means `t` itself is
 * the blocker; null means `t` maps (or is `any`). */
function innerBlockedMember(
  t: ts.Type,
  ctx: TypeMapperCtx,
  seen: Set<ts.Type>,
): { path: string; type: ts.Type } | null {
  const { checker } = ctx;
  // `any` is no component to name: the member holding it is the blocker.
  if ((t.flags & ts.TypeFlags.Any) !== 0 || mapType(t, ctx) !== null) return null;
  const here = { path: "", type: t };
  if (seen.has(t) || seen.size >= 16) return here;
  seen.add(t);
  const step = (prefix: string, inner: ts.Type): { path: string; type: ts.Type } => {
    const found = innerBlockedMember(inner, ctx, seen);
    return found === null ? here : { path: prefix + found.path, type: found.type };
  };
  if (t.isUnionType()) {
    const UNIT = ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null;
    for (const part of ts.constituentTypes(t)) {
      if ((part.flags & UNIT) !== 0 || mapType(part, ctx) !== null) continue;
      return step("", part);
    }
    return here;
  }
  if ((t.flags & ts.TypeFlags.Object) === 0) return here;
  if (checker.isArrayType(t)) {
    const elem = checker.getTypeArguments(t as ts.TypeReference)[0];
    return elem === undefined ? here : step("[]", elem);
  }
  const symbol = t.getSymbol();
  if (
    symbol !== undefined &&
    ts.symbolName(symbol) === "Promise" &&
    symbol.declarations.some((d) => ctx.isStdlibFile(d.getSourceFile()))
  ) {
    const payload = checker.getTypeArguments(t as ts.TypeReference)[0];
    return payload === undefined ? here : step("", payload);
  }
  const calls = checker.getCallSignatures(t);
  if (calls.length === 1) {
    const sig = calls[0]!;
    if (sig.getTypeParameters().length > 0) return here;
    if (sig.getParameters().some((p) => mapType(checker.getTypeOfSymbol(p), ctx) === null))
      return here;
    return step("()", checker.getReturnTypeOfSignature(sig));
  }
  if (
    calls.length > 0 ||
    checker.getConstructSignatures(t).length > 0 ||
    checker.isTupleType(t) ||
    checker.getIndexInfosOfType(t).length > 0
  )
    return here;
  for (const p of checker.getPropertiesOfType(t)) {
    if ((p.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) !== 0) continue;
    if (ts.symbolName(p).startsWith("__@")) continue;
    const fieldTs = checker.getTypeOfSymbol(p);
    if (memberMaps(fieldTs, ctx, p)) continue;
    return step(`.${ts.symbolName(p)}`, fieldTs);
  }
  return here;
}

/** The type tsc infers from an empty object literal (`{}` written as a
 * value): no members, index signatures or signatures, declared by an object
 * literal expression. */
function isEmptyObjectLiteralType(type: ts.Type, ctx: TypeMapperCtx): boolean {
  const { checker } = ctx;
  const symbol = type.getSymbol();
  return (
    symbol !== undefined &&
    symbol.declarations.some((d) => ts.isObjectLiteralExpression(d)) &&
    checker.getPropertiesOfType(type).length === 0 &&
    checker.getIndexInfosOfType(type).length === 0 &&
    checker.getCallSignatures(type).length === 0 &&
    checker.getConstructSignatures(type).length === 0
  );
}
