import { InternalCompilerError } from "../errors.js";
import * as ts from "./ts7/adapter.js";
import type { IrRecordShape, IrType, IrUnionDef } from "../ir/ir.js";
import { arrayOf, BOOL, bytesOf, canConvertToDyn, CHILD_T, DATE_T, DYN, F64, funcOf, isSupportedArrayElem, isSupportedIndexValue, isSupportedMapKey, isSupportedMapValue, isSupportedSetElem, isUnitType, JSVAL, mapOf, NULL_T, PROCSTREAM_T, RUNTIME_EMITTER_CLASS, RUNTIME_ERROR_CLASSES, RUNTIME_STREAM_CLASSES, setOf, STRING, SYMBOL_T, typeEquals, typeKey, UNDEFINED_T, VOID } from "../ir/ir.js";

import { isJsSourceFile, isNodeTypesPath } from "./program.js";
import { accessorSlotProp } from "../ir/ir.js";
// typeKey moved to ir/ir.ts (the backend needs it too, for per-type
// helper interning); re-exported here so frontend call sites keep their
// import path.
export { typeKey };

/** The ambient TYPE names of the fetch slice. Under --dynamic their
 * values live in the embedded engine and map to island handles (jsval).
 * Static fetch gives Response, RequestInit, AbortController/AbortSignal, response
 * Headers, and the readable Web Streams slice native checked-dynamic
 * handle representations. The Headers constructor itself remains
 * dynamic-only even though response.headers is native.
 * Declaration provenance is checked in mapType so user types with the
 * same names keep their ordinary structural representation. */
export const ISLAND_AMBIENT_TYPES = [
  "Response",
  "ResponseInit",
  "RequestInit",
  "Event",
  "EventTarget",
  "AbortController",
  "AbortSignal",
  "Headers",
  "ReadableStream",
  "ReadableStreamDefaultReader",
  "ReadableStreamDefaultController",
  "ReadableStreamReadResult",
  "ReadableStreamReadValueResult",
  "ReadableStreamReadDoneResult",
] as const;

/** node:util.parseArgs's public and @types/node helper type names. Values
 * behind this surface use the checked-dynamic tree; see mapTypeInner. */
const PARSE_ARGS_DYN_TYPES = new Set([
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
  return "rank" in priority ? priority.rank : priority;
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
  /** All interned shapes in first-seen (`r0`, `r1`, ...) order. */
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
  private keyOf(fields: { name: string; type: IrType }[], tuple: boolean, indexValue?: IrType): string {
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
    if (previous !== undefined && comparePriority(previous, this.currentDeclaredOrderPriority) <= 0) {
      return;
    }
    shape.declaredOrder = declaredOrder;
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
      shape.declaredOrder = best.order;
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
      if (next !== undefined) shape.declaredOrder = next;
    };
  }

  /** The shape id a back-reference to an in-progress type resolves to:
   * reuses the type's persistent recursive id or mints a PLACEHOLDER
   * entry (empty fields) the outer frame finalizes. */
  recursiveRef(t: ts.Type): string {
    let id = this.recIds.get(t);
    if (id === undefined) {
      id = `r${this.shapes.length}`;
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
  finalizeRecursive(t: ts.Type, fields: { name: string; type: IrType }[], indexValue?: IrType, declaredOrder?: string[]): string {
    const id = this.recIds.get(t);
    if (id === undefined) throw new InternalCompilerError("shape registry bug: finalizeRecursive without a placeholder");
    if (this.pendingRec.has(id)) {
      const shape = this.byId.get(id)!;
      shape.fields = fields;
      if (indexValue) shape.indexValue = indexValue;
      this.adoptDeclaredOrder(shape, declaredOrder);
      this.pendingRec.delete(id);
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
  intern(fields: { name: string; type: IrType }[], tuple = false, indexValue?: IrType, declaredOrder?: string[],): string {
    const key = this.keyOf(fields, tuple, indexValue);
    let id = this.byKey.get(key);
    if (id === undefined) {
      id = `r${this.shapes.length}`;
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
}

/** The frontend's union interner — mirrors ShapeRegistry. A union's
 * canonical identity is its typeKey-sorted arm list; two ts unions whose
 * arms map to the same IR types share one unionId (and later one runtime
 * tag numbering: an arm's index in the canonical list IS its tag). Owned by
 * the Lowerer; threaded through mapType exactly like ShapeRegistry. */
export class UnionRegistry {
  private readonly byKey = new Map<string, string>();
  private readonly byId = new Map<string, IrUnionDef>();
  /** All interned unions in first-seen (`u0`, `u1`, ...) order. */
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
   * entry (empty arms) the outer frame finalizes. */
  recursiveRef(t: ts.Type): string {
    let id = this.recIds.get(t);
    if (id === undefined) {
      id = `u${this.unions.length}`;
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
  finalizeRecursive(t: ts.Type, arms: IrType[]): string {
    const id = this.recIds.get(t);
    if (id === undefined) throw new InternalCompilerError("union registry bug: finalizeRecursive without a placeholder");
    if (this.pendingRec.has(id)) {
      const def = this.byId.get(id)!;
      def.arms.push(...arms);
      this.pendingRec.delete(id);
      const key = JSON.stringify(arms.map(typeKey));
      if (!this.byKey.has(key)) this.byKey.set(key, id);
    }
    return id;
  }

  /** Interns a canonical (typeKey-sorted, deduplicated) arm list, returning
   * its unionId. */
  intern(arms: IrType[]): string {
    const key = JSON.stringify(arms.map(typeKey));
    let id = this.byKey.get(key);
    if (id === undefined) {
      id = `u${this.unions.length}`;
      const def: IrUnionDef = { id, arms };
      this.byKey.set(key, id);
      this.byId.set(id, def);
      this.unions.push(def);
    }
    return id;
  }

  get(unionId: string): IrUnionDef | undefined {
    return this.byId.get(unionId);
  }
}

/** Human-readable rendering of an IrType for diagnostics (records expand to
 * their canonical field list, unions to their arms; `checker.typeToString`
 * can't — it never sees IR types). `seen` breaks recursive shapes/unions:
 * a back-reference renders as "..." instead of expanding forever. */
export function formatIrType(t: IrType, shapes: ShapeRegistry, unions: UnionRegistry, seen: Set<string> = new Set()): string {
  switch (t.kind) {
    case "f64":
      return "number";
    case "string":
      return "string";
    case "bool":
      return "boolean";
    case "dyn":
      return "unknown";
    case "caught":
      // What tsc calls the binding; the fence messages carry the real story.
      return "unknown";
    case "void":
      return "void";
    case "undefinedT":
      return "undefined";
    case "nullT":
      return "null";
    case "array": {
      // Union/func elements need the parens TS syntax would ("(number |
      // string)[]" — without them the [] reads as binding to the last arm).
      const elem = formatIrType(t.elem, shapes, unions, seen);
      return t.elem.kind === "union" || t.elem.kind === "func" ? `(${elem})[]` : `${elem}[]`;
    }
    case "bytes":
      // The u8 kind reads as Uint8Array (Buffer maps here too — one
      // runtime representation; the message stays honest either way).
      return t.elem === "u8" ? "Uint8Array" : t.elem === "u32" ? "Uint32Array" : t.elem === "i32" ? "Int32Array" : "Float32Array";
    case "map":
      return `Map<${formatIrType(t.key, shapes, unions, seen)}, ${formatIrType(t.value, shapes, unions, seen)}>`;
    case "set":
      return `Set<${formatIrType(t.elem, shapes, unions, seen)}>`;
    case "func":
      return `(${t.params.map((p) => formatIrType(p, shapes, unions, seen)).join(", ")}) => ${formatIrType(t.ret, shapes, unions, seen)}`;
    case "object":
      // Runtime-provided error classes carry '%'-prefixed IR names
      // ("%Error") so user classes can never collide; diagnostics show the
      // source-level name.
      return t.className.startsWith("%") ? t.className.slice(1) : t.className;
    case "classval":
      // The static side, in TS's own spelling.
      return `typeof ${t.className.startsWith("%") ? t.className.slice(1) : t.className}`;
    case "record": {
      const shape = shapes.get(t.shapeId);
      if (!shape) return `{ /* unknown shape ${t.shapeId} */ }`;
      if (seen.has(t.shapeId)) return "..."; // the recursive knot
      seen.add(t.shapeId);
      try {
        if (shape.tuple) {
          const byIndex = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
          return `[${byIndex.map((f) => formatIrType(f.type, shapes, unions, seen)).join(", ")}]`;
        }
        const members = shape.fields.map((f) => {
          // Accessor slots print in TS's accessor spelling, not the
          // reserved '%'-field encoding.
          const slot = accessorSlotProp(f.name);
          if (slot && f.type.kind === "func") {
            return slot.kind === "get"
              ? `get ${slot.prop}(): ${formatIrType(f.type.ret, shapes, unions, seen)}`
              : `set ${slot.prop}(${formatIrType(f.type.params[0] ?? VOID, shapes, unions, seen)})`;
          }
          return `${f.name}: ${formatIrType(f.type, shapes, unions, seen)}`;
        });
        if (shape.indexValue) {
          members.push(`[key: string]: ${formatIrType(shape.indexValue, shapes, unions, seen)}`);
        }
        if (members.length === 0) return "{}";
        return `{ ${members.join("; ")} }`;
      } finally {
        seen.delete(t.shapeId); // sibling occurrences still expand
      }
    }
    case "union": {
      const def = unions.get(t.unionId);
      if (!def) return `/* union ${t.unionId} */`;
      if (seen.has(t.unionId)) return "..."; // the recursive knot
      seen.add(t.unionId);
      try {
        return def.arms.map((a) => formatIrType(a, shapes, unions, seen)).join(" | ");
      } finally {
        seen.delete(t.unionId);
      }
    }
    case "jsval":
      return "any";
    case "regex":
      return "RegExp";
    case "date":
      return "Date";
    case "url":
      return "URL";
    case "searchParams":
      return "URLSearchParams";
    case "symbol":
      return "symbol";
    case "stats":
      return "Stats";
    case "fileHandle":
      return "FileHandle";
    case "spawnRes":
      return "SpawnSyncReturns";
    case "child":
      return "ChildProcess";
    case "netServer":
      return "Server";
    case "netSocket":
      return "Socket";
    case "http2Session":
      return "Http2Session";
    case "http2Stream":
      return "Http2Stream";
    case "dgramSocket":
      return "dgram.Socket";
    case "testCtx":
      return "TestContext";
    case "httpReq":
      return "IncomingMessage";
    case "httpRes":
      return "ServerResponse";
    case "httpClientReq":
      return "ClientRequest";
    case "secureCtx":
      return "SecureContext";
    case "fsWatcher":
      return "FSWatcher";
    case "childStream":
      return "Readable";
    case "procStream":
      return "WriteStream";
    case "promise":
      return `Promise<${formatIrType(t.inner, shapes, unions, seen)}>`;
    case "generator":
      return `Generator<${formatIrType(t.yieldT, shapes, unions, seen)}, ${formatIrType(t.retT, shapes, unions, seen)}, ${formatIrType(t.nextT, shapes, unions, seen)}>`;
    default: {
      const _exhaustive: never = t;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
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
function isDeclaredInAmbientNamespace(d: ts.Declaration, name: string): boolean {
  let node: ts.Node | undefined = d.parent;
  while (node) {
    if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      return node.name.text === name;
    }
    node = node.parent;
  }
  return false;
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
  checker: ts.TypeChecker;
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
   * family never collected. Absent in checkers with no lowering attached
   * (generic instance types stay unmapped there). */
  genericClassInstance?: (decl: ts.ClassLikeDeclaration, typeRef: ts.Type) => IrType | null;
  /** MIXIN class nodes (the class inside a mixin function): one shared
   * AST node, one instantiation per call site — the node's instance type
   * resolves to the instantiation CURRENTLY collecting/lowering (`this`
   * inside members, self-referential member types), null outside any
   * mixin context (the type alone cannot name a call site). */
  mixinClassInstance?: (decl: ts.ClassLikeDeclaration) => IrType | null;
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
  /** True for an npm package's shipped .d.ts — a declaration file under
   * node_modules that is NOT the standard library (typescript's own lib
   * files live under node_modules too). Types declared there map to jsval
   * under --dynamic: the package's implementation runs in the embedded
   * engine, so its values are island handles. */
  isNpmFile: (sf: ts.SourceFile) => boolean;
  /** True for a declaration file explicitly mapped by coverage's
   * --external-types option. These declarations are trusted as structural
   * type descriptions for project-owned values, but their imported runtime
   * bindings are fenced separately by the Lowerer. */
  isExternalTypeFile: (sf: ts.SourceFile) => boolean;
  /** --dynamic: `any` maps to the island handle type (jsval). Off, `any`
   * stays unmapped and the requires-dynamic diagnostic fires per site. */
  dynamic: boolean;
  /** Successful context-free mappings, keyed by dynamic posture + the
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
}


/** lower-calls.ts's bodyReadsArguments, duplicated here (type-mapper.ts must not
 * import from lowering/ — that edge is a module cycle): does the function's
 * OWN body read `arguments`? Nested plain functions/methods own theirs
 * (skipped); arrows see the enclosing one (descended). */
function bodyReadsArgumentsLocal(fn: { body?: ts.Node | undefined }): boolean {
  let found = false;
  if (fn.body === undefined) return false;
  // Iterative walk (walkPreorder): function bodies can hold pathologically
  // deep expression chains that a recursive visit would die on.
  ts.walkPreorder(fn.body, (n) => {
    if (ts.isIdentifier(n) && n.text === "arguments" && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
      found = true;
      return "stop";
    }
    if ((ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && (n as unknown) !== fn) {
      return "skip"; // own `arguments` scope
    }
    return undefined;
  });
  return found;
}

/** A generator type's normalized value channels (Generator<T, TReturn,
 * TNext> and the IteratorResult alias share this):
 * - yield: `never` (a generator that never yields) rides the VOID
 *   sentinel; any/unknown ride dyn; undefined-only yields have no C value
 *   form (null); else the mapped type.
 * - return: void/undefined/never carry no value (VOID — the done-value is
 *   the undefined arm); any/unknown are DEFAULTS (`Generator<number>` is
 *   Generator<number, any, any>), and a defaulted return channel means
 *   "no modeled return value" — VOID, not dyn (a dyn return channel would
 *   force the yield channel dyn too; bodies that `return v` under a
 *   defaulted TReturn keep their fence at the return site).
 * - next: void/undefined/never mean valueless resumes (the undefined
 *   unit); any/unknown ride dyn; else the mapped type (`.next(v)` then
 *   requires its argument — fenced at the call site).
 * Mixed dyn/concrete value channels stay unmapped (the shared result
 * record's value slot is one representation). */
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
  const retT = retTs === undefined || retTs.flags & (UNITISH | ANYISH)
    ? VOID
    : mapType(retTs, ctx);
  if (!retT || (retT.kind !== "void" && isUnitType(retT))) return null;
  const nextT = nextTs === undefined || nextTs.flags & UNITISH
    ? UNDEFINED_T
    : nextTs.flags & ANYISH ? DYN : mapType(nextTs, ctx);
  if (!nextT || nextT.kind === "void" || nextT.kind === "nullT") return null;
  const dynMix =
    (yieldT.kind === "dyn" && retT.kind !== "dyn" && retT.kind !== "void") ||
    (retT.kind === "dyn" && yieldT.kind !== "dyn" && yieldT.kind !== "void");
  if (dynMix) return null;
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

export function mapType(type: ts.Type, ctx: TypeMapperCtx): IrType | null {
  if (mapTypeDepth >= MAP_TYPE_MAX_DEPTH) return null;
  const topLevel = mapTypeDepth === 0;
  const typeId = (type as { id?: number }).id;
  const memoizable = typeId !== undefined && (ctx.canMemoizeType?.() ?? true);
  const memoKey = memoizable ? `${ctx.dynamic ? 1 : 0}:${typeId}` : null;
  if (memoKey !== null) {
    const memo = ctx.typeMemo?.get(memoKey);
    if (memo !== undefined) return memo;
  }
  const sensitivityAtEntry = contextResolutions;
  mapTypeDepth++;
  try {
    const mapped = mapTypeInner(type, ctx);
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

/** True when a class expression can NEVER register a lowering: one
 * enclosed by a function-like body or a class static block mints a
 * DISTINCT class per evaluation, which lowerClassExpressionInfo always
 * fences. Its instance/static types must stay UNMAPPED — an object type
 * naming a struct that will never be emitted is the invalid-C escape
 * family (every SITE using the value already carries its own fence). */
function classExprNeverRegisters(decl: ts.ClassLikeDeclaration): boolean {
  if (!ts.isClassExpression(decl)) return false;
  for (let p: ts.Node = decl.parent; !ts.isSourceFile(p); p = p.parent) {
    if (ts.isFunctionLike(p) || ts.isClassStaticBlockDeclaration(p)) return true;
  }
  return false;
}

function mapTypeInner(type: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const { checker, unions, classNamer, resolveTypeParam } = ctx;
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
  }
  const widened = checker.getBaseTypeOfLiteralType(type);
  const flags = widened.flags;

  if (flags & ts.TypeFlags.Number) return F64;
  if (flags & ts.TypeFlags.String) return STRING;
  if (flags & ts.TypeFlags.Boolean || flags & ts.TypeFlags.BooleanLiteral) return BOOL;
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
    if (
      parseArgsSym &&
      PARSE_ARGS_DYN_TYPES.has(parseArgsSym.name) &&
      checker.declarationsOf(parseArgsSym).some(
        (d) =>
          ctx.isStdlibFile(d.getSourceFile()) &&
          isDeclaredInAmbientModule(d as ts.Declaration, "util"),
      )
    ) {
      return DYN;
    }
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
      (boxSym.name === "Number" || boxSym.name === "String" || boxSym.name === "Boolean") &&
      checker.declarationsOf(boxSym).some((d) => ctx.isStdlibFile(d.getSourceFile()))
    ) {
      return boxSym.name === "Number" ? F64 : boxSym.name === "String" ? STRING : BOOL;
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
      (ctorSym.name === "StringConstructor" ||
        ctorSym.name === "NumberConstructor" ||
        ctorSym.name === "BooleanConstructor") &&
      checker.declarationsOf(ctorSym).some((d) => ctx.isStdlibFile(d.getSourceFile()))
    ) {
      return funcOf(
        [STRING],
        ctorSym.name === "StringConstructor" ? STRING : ctorSym.name === "NumberConstructor" ? F64 : BOOL,
      );
    }
  }
  // `symbol` and `unique symbol` (the type of `const k = Symbol(...)` —
  // getBaseTypeOfLiteralType widens unique symbols, but check both flags)
  // map to the symbol identity kind.
  if (flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) return SYMBOL_T;
  // STANDALONE undefined (and void) map to VOID: return-type mapping flows
  // through here, and `(): void | undefined` functions must stay void.
  // Inside a union, undefined becomes the undefinedT unit ARM instead (see
  // the union branch below). VALUE positions that today receive VOID
  // (record fields, tuple/array elements, variable slots) substitute the
  // unit-only union themselves (isUnitOnlyTsType + unitOnlyUnion) — the
  // position knows it wants a value; this mapping cannot.
  if (flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return VOID;
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
  // `any` is the island handle type under --dynamic (the type-hole becomes
  // dynamically-executed code); without the flag it stays unmapped and the
  // per-site diagnostic tells the user about --dynamic and the static
  // alternative (`unknown` + a checked cast).
  if (flags & ts.TypeFlags.Any) return ctx.dynamic ? JSVAL : null;
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
  // Types DECLARED by a shipped .d.ts — an npm package's, or a LOCAL
  // declaration file describing sibling JS the program loads dynamically
  // (an Emscripten factory's .d.mts): the .d.ts is trusted as the type
  // surface, but the values behind it live in the embedded engine — under
  // --dynamic they are island handles (jsval), and every operation on them
  // rides the engine ops with validated exits at typed boundaries.
  // Primitives/arrays/etc. REACHED THROUGH such types keep their
  // structural mapping (they were handled above or recurse normally); this
  // rule fires only when the type's own identity is declaration-file-
  // declared — interfaces, classes, type literals, and aliases from the
  // .d.ts. The standard library's declaration files are carved out (their
  // surfaces have static lowerings), as are declarations explicitly mapped
  // by --external-types: those describe project-owned structural data while
  // the Lowerer fences their imported runtime bindings. The program's own
  // compiled modules are never declaration files. Without --dynamic this
  // stays unmapped; badType reports the per-package requires-dynamic
  // diagnostic for node_modules types and the generic story otherwise.
  const npmSym = widened.getAliasSymbol() ?? widened.getSymbol();
  const npmDecls = npmSym ? checker.declarationsOf(npmSym) : undefined;
  if (
    npmDecls &&
    npmDecls.length > 0 &&
    npmDecls.every((d) => {
      const sf = d.getSourceFile();
      return sf.isDeclarationFile && !ctx.isStdlibFile(sf) && !ctx.isExternalTypeFile(sf);
    })
  ) {
    return ctx.dynamic ? JSVAL : null;
  }
  // NOTE on module NAMESPACE types (`typeof import("./x.mjs")` — what a
  // dynamic import resolves to): non-stdlib ones fall under the rule
  // above (their declarations are the .d.ts SourceFiles themselves).
  // Stdlib `declare module` namespaces ("fs", "path") deliberately stay
  // unmapped: their members have STATIC lowerings keyed off import
  // bindings (builtinImportOf), and a handle mapping would reroute
  // `import * as path` member calls into the engine — dynamic imports of
  // builtins get their handles from the import lowering's IR type
  // instead.
  // T[]: monomorphic arrays, recursively (number[][] works). An element type
  // that doesn't map (never from a context-free `[]`) makes the whole array
  // unsupported — null propagates. Record/object/union elements ride the
  // runtime's REF element kind (per-array RC entry points, the map-value
  // technique), and PROMISE elements ride it too (Promise<T>[] is
  // Promise.all's food: promises are refcounted, cycle-headered values
  // with `_v` adapters like any other ref element — they just never
  // JSON-serialize or cross the island boundary, which the safety
  // predicates already refuse). FUNCTION elements ride REF too (closure
  // `_v` adapters + scr_closure_trace_v — closures are cycle-headered):
  // `f === f` identity through indexOf/includes is sound because a
  // function VALUE is one ScrClosure for its whole life — top-level
  // declarations intern one immortal closure, and inner closures are
  // allocated once at their definition's evaluation and flow by
  // reference, exactly JS's function identity. map/set/regex/url/dyn and
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
    if (elem?.kind === "void" && isUnitOnlyTsType(elemTs)) elem = unitOnlyUnion(unions);
    // A jsval element ABSORBS the array — with one carve-out. An array
    // type entangled with package-declared ('npm-jsval') elements
    // (`GeneratedFile[]`, `ModelMessage[]`) describes ISLAND values: the
    // handles those APIs produce are engine arrays, never the static
    // ScrArr this mapping would otherwise claim, so the whole array is
    // one handle and every operation on it is an engine op. The carve-out
    // is literal `any[]`: an EXPLICIT static array of dynamic values —
    // the messages-building pattern (`const content: any[] = []`) — which
    // keeps its static array-of-handles representation.
    if (elem?.kind === "jsval" && !(elemTs.flags & ts.TypeFlags.Any)) return JSVAL;
    if (!elem) return null;
    // A dyn ELEMENT makes the WHOLE array the checked-dynamic value:
    // `unknown[]`, `object[]`, and the collapsed `(string | object)[]`
    // (the plugins-slot shape) — the checked-dynamic tree has real arrays, so length/
    // index/push/iteration ride the keyed-dyn paths, while a dyn-element
    // STATIC array has no backend representation (ScrArr has no dyn
    // element kind). This is dynFallbackType's JS stance promoted into
    // the mapping itself; construction sites build dynArrLit (the checked-dynamic tree
    // array literal) and typed sources convert per element at the slot.
    if (elem.kind === "dyn") return DYN;
    // The shared predicate is the runtime/backend storage contract. In
    // particular, valid standalone values such as Map/Set/Date and opaque
    // handles do not automatically have an array element representation.
    if (!isSupportedArrayElem(elem)) return null;
    // ChildProcess[] (the running-apps list) and Server[] (the [...set]
    // drain of the auxiliary-server registries): handles are ordinary
    // refcounted REF elements (their `_v` adapters, no trace — both drop
    // their closures at their terminal event).
    return arrayOf(elem);
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
    const tupleShape = (ref.elementFlags as ts.ElementFlags[] | undefined) !== undefined
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
    // Optional/rest elements (`[string?, number?]`, `[string, ...number[]]`)
    // have no fixed shape — the ARITY is a runtime fact. Under --dynamic
    // the value lives in the engine, a real JS array carrying its true
    // length (reads, destructuring, JSON, .length all exact); static
    // builds stay unmapped and badType tells the dynamic-tier story.
    if (tupleShape.elementFlags.some((f) => !(f & ts.ElementFlags.Required))) {
      return ctx.dynamic ? JSVAL : null;
    }
    const fields: { name: string; type: IrType }[] = [];
    for (let i = 0; i < args.length; i++) {
      let et = mapType(args[i]!, ctx);
      // A unit-only element (`[number, undefined]`) rides the unit-only
      // union, the record-field rule.
      if (et?.kind === "void" && isUnitOnlyTsType(args[i]!)) et = unitOnlyUnion(unions);
      // dyn ELEMENTS map now — `[string, unknown]`, the Object.entries
      // tuple over an `unknown`-valued index signature (the pricing-table
      // normalizer shape): the slot has the overflow map's RC/JSON/dyn
      // plumbing, values arrive dyn or convert via dynFrom.
      if (!et || et.kind === "void") return null;
      // A jsval MEMBER absorbs the tuple (bare jsval fields have no shape
      // slot — the record-field rule), exactly like record fields below.
      if (et.kind === "jsval") return JSVAL;
      fields.push({ name: String(i), type: et });
    }
    fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { kind: "record", shapeId: ctx.shapes.intern(fields, true) };
  }
  // Class instances: the type's symbol is a class declared in the user's
  // file. The class NAME as a value has the *constructor* type — same
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
      "netServer", "netSocket", "httpReq", "httpRes", "httpClientReq", "dgramSocket",
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
  // symbol, but with construct signatures — that is the STATIC side, and
  // it maps to classval below.
  const widenedSym = widened.getSymbol();
  const classDecl = widenedSym ? checker.valueDeclarationOf(widenedSym) : undefined;
  if (
    classDecl &&
    (ts.isClassDeclaration(classDecl) || ts.isClassExpression(classDecl)) &&
    // Nameless class DECLARATIONS are legal only as `export default class
    // {}` — classNamer spells them "%anon" (unique per file), the same
    // name their collection registered.
    !classDecl.getSourceFile().isDeclarationFile &&
    checker.getConstructSignatures(widened).length === 0
  ) {
    // Declared OUTSIDE the lowered program (reached through the type world
    // alone — jsdoc `typeof import()` over a never-required module): the
    // class will never register, so the instance type is unmappable, not
    // an object type naming a struct that cannot exist.
    if (!ctx.isProgramFile(classDecl.getSourceFile())) return null;
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
    // A class expression inside a function/static block never registers
    // (a distinct class per evaluation): unmappable for the same reason.
    if (classExprNeverRegisters(classDecl)) return null;
    // A GENERIC class's instance type (`Box<number>`) maps to the concrete
    // INSTANTIATION's class (`Box%0`), registered on demand — the Lowerer
    // hook owns the instance table (monomorphization by flow).
    if (classDecl.typeParameters) {
      const instance = ctx.genericClassInstance
        ? ctx.genericClassInstance(classDecl, widened)
        : null;
      // Before the generic declaration's collection turn, the hook can only
      // return its family shell; after collection the same checker type names
      // a concrete registered instance. Never memoize either phase's answer.
      if (instance !== null) contextResolutions++;
      return instance;
    }
    return { kind: "object", className: classNamer(classDecl) };
  }
  // The class STATIC side (`typeof C` — the class name as a value): the
  // same symbol WITH its construct signatures. Program classes only; lib
  // and package statics keep their fences.
  if (
    classDecl &&
    (ts.isClassDeclaration(classDecl) || ts.isClassExpression(classDecl)) &&
    !classDecl.getSourceFile().isDeclarationFile &&
    checker.getConstructSignatures(widened).length > 0
  ) {
    if (!ctx.isProgramFile(classDecl.getSourceFile())) return null;
    // The MIXIN class node's static side (`typeof C` inside the mixin):
    // the current instantiation's classval, like the instance type above.
    {
      const viaMixin = ctx.mixinClassInstance?.(classDecl);
      if (viaMixin?.kind === "object") {
        contextResolutions++;
        return { kind: "classval", className: viaMixin.className };
      }
    }
    if (classExprNeverRegisters(classDecl)) return null;
    // A GENERIC class's static side: only an INSTANTIATED one maps — an
    // instantiation expression's type (`Box<number>` as a value) carries a
    // construct signature returning the concrete instance, which maps to
    // the instantiation's classval. Uninstantiated `typeof Box` keeps the
    // type parameter in the construct signature's return — unmapped (the
    // family has no thunk and no single constructor ABI).
    if (classDecl.typeParameters) {
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
  }
  // Map<K, V>: a reference to the standard library's Map interface —
  // provenance, not the name (a user's own `interface Map` maps as a record
  // like any other). Keys are fenced to f64/string (SameValueZero hashing),
  // values to the supported kinds (see isSupportedMapValue); anything
  // outside stays unmapped — callers report the component fence (SC2009)
  // naming the offending half, as does the `new Map` lowering per site.
  const psym = widened.getSymbol();
  const isStdlibInterface = (name: string): boolean =>
    psym?.name === name &&
    checker.declarationsOf(psym).some(
      (d) => ts.isInterfaceDeclaration(d) && ctx.isStdlibFile(d.getSourceFile()),
    );
  // The builtin Error classes: references to the LIB's Error/TypeError/
  // RangeError/SyntaxError interfaces map to the runtime-provided class
  // hierarchy (provenance, not the name — a user's own `class Error`
  // resolved through the class-instance branch above, and a user
  // `interface Error` maps as a record). The '%'-prefixed IR names are the
  // RUNTIME_ERROR_CLASSES table's; the Lowerer registers the matching
  // ClassInfos eagerly, so every consumer of the class name finds them.
  for (const [irName, rec] of RUNTIME_ERROR_CLASSES) {
    if (isStdlibInterface(rec.lib)) return { kind: "object", className: irName };
  }
  // The lib's `Object` interface is a TOP type: tsc admits every
  // non-nullish value into an `Object` slot (`const x: Object = "s"`), so
  // it lowers like `unknown` (the dyn) — the same rule as `object` and
  // the empty object type, provenance-checked so a user's own `interface
  // Object` still maps as a record. Its Object.prototype member surface
  // (`x.toString()`) fences at each use site, never silently.
  if (isStdlibInterface("Object")) return DYN;
  // The lib's `Function` interface is a TOP callable type: it lowers like
  // `dyn` (the dynamic value representation).
  if (isStdlibInterface("Function")) return DYN;
  // events.EventEmitter: the runtime-provided emitter base class (the
  // Error-hierarchy precedent — user subclasses resolved through the
  // class-instance branch above). Both type layers declare it in the
  // "events" ambient module — the fallback as a class, @types/node as a
  // (generic) class plus a same-named interface — and @types/node's
  // NodeJS.EventEmitter interface (the structural surface net.Socket
  // et al. extend) is the same runtime value. Provenance-checked.
  if (
    psym?.name === "EventEmitter" &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()) &&
        (isDeclaredInAmbientModule(d, "events") || isDeclaredInAmbientNamespace(d, "NodeJS")),
    )
  ) {
    return { kind: "object", className: RUNTIME_EMITTER_CLASS };
  }
  // readline.Interface: the interface value is an f64 handle into the
  // runtime's registry (the Timeout-id precedent). The NAME is generic,
  // so the provenance check adds the enclosing ambient module, like
  // net.Server (@types/node also declares Interface in
  // readline/promises — that one stays unmapped and fences).
  if (
    psym?.name === "Interface" &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()) &&
        isDeclaredInAmbientModule(d, "readline"),
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
    psym?.name === "Channel" &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()) &&
        isDeclaredInAmbientModule(d, "diagnostics_channel"),
    )
  ) {
    return F64;
  }
  // async_hooks.AsyncLocalStorage: the store value is an f64 handle into
  // the runtime's store id space (the Channel story — stores are
  // process-lived; contexts ride the fiber machinery).
  if (
    psym?.name === "AsyncLocalStorage" &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()) &&
        isDeclaredInAmbientModule(d, "async_hooks"),
    )
  ) {
    return F64;
  }
  // diagnostics_channel.TracingChannel: the same f64-handle story over the
  // runtime's tracing registry (five event channels per entry).
  if (
    psym?.name === "TracingChannel" &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()) &&
        isDeclaredInAmbientModule(d, "diagnostics_channel"),
    )
  ) {
    return F64;
  }
  // string_decoder.StringDecoder: the decoder value is a two-field record
  // — the CANONICAL encoding name (construction normalizes aliases; the
  // `.encoding` property reads it) and the f64 packing the pending
  // partial sequence (the %strdec helpers' state cell). Provenance-
  // checked like Stats; construction and the write/end methods are
  // special-cased in lowerNew / lowerStringDecoderMethodCall, so the
  // record shape never surfaces.
  if (
    psym?.name === "StringDecoder" &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()),
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
  if (
    flags & ts.TypeFlags.Object &&
    (psym ? checker.declarationsOf(psym).length : 0) > 0 &&
    (psym ? checker.declarationsOf(psym) : []).every((d) => d.getSourceFile().isDeclarationFile)
  ) {
    const props = checker.getPropertiesOfType(widened);
    if (
      props.length === 3 &&
      ["promise", "resolve", "reject"].every((n) => props.some((p) => p.name === n))
    ) {
      const promProp = props.find((p) => p.name === "promise")!;
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
                type: { kind: "func", params: [{ kind: "object", className: "%Error" }], ret: VOID },
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
  // read has its own lowering (errno/syscall/path stay per-member fences).
  if (isStdlibInterface("ErrnoException")) return { kind: "object", className: "%Error" };
  // The fetch ambient slice: under --dynamic these are island handles
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
      !ctx.dynamic &&
      alias?.name === "ReadableStreamReadResult" &&
      checker.declarationsOf(alias).some(
        (d) =>
          ts.isTypeAliasDeclaration(d) &&
          ctx.isStdlibFile(d.getSourceFile()),
      )
    ) {
      const elemTs = widened.getAliasTypeArguments()?.[0];
      const elem =
        elemTs && elemTs.flags & ts.TypeFlags.Any
          ? DYN
          : elemTs
            ? mapType(elemTs, ctx)
            : null;
      if (!elem) return null;
      return genResultRecord(elem, VOID, ctx.shapes, ctx.unions);
    }
  }
  if (
    !ctx.dynamic &&
    psym &&
    (psym.name === "ReadableStreamReadValueResult" ||
      psym.name === "ReadableStreamReadDoneResult") &&
    checker.declarationsOf(psym).some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        ctx.isStdlibFile(d.getSourceFile()),
    )
  ) {
    const elemTs = checker.getTypeArguments(widened as ts.TypeReference)[0];
    const elem =
      elemTs && elemTs.flags & ts.TypeFlags.Any
        ? DYN
        : elemTs
          ? mapType(elemTs, ctx)
          : null;
    if (!elem) return null;
    return genResultRecord(elem, VOID, ctx.shapes, ctx.unions);
  }
  if (
    psym &&
    (ISLAND_AMBIENT_TYPES as readonly string[]).includes(psym.name) &&
    !(
      psym.name === "ReadableStream" &&
      checker.declarationsOf(psym).some(
        (d) => ts.isInterfaceDeclaration(d) && isDeclaredInAmbientNamespace(d, "NodeJS"),
      )
    ) &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()),
    )
  ) {
    return ctx.dynamic ? JSVAL : DYN;
  }
  // ReadonlyMap/ReadonlySet are the SAME runtime values as Map/Set — the
  // readonly-ness is a checker-only view (no mutating members on the
  // interface), so both map to the identical IR kinds and the read-side
  // method lowerings (.has/.get/.size/iteration) dispatch unchanged.
  if (isStdlibInterface("Map") || isStdlibInterface("ReadonlyMap")) {
    const args = checker.getTypeArguments(widened as ts.TypeReference);
    if (args.length !== 2) return null;
    const key = mapType(args[0]!, ctx);
    if (!key || !isSupportedMapKey(key)) return null;
    const value = mapType(args[1]!, ctx);
    if (!value || !isSupportedMapValue(value)) return null;
    return mapOf(key, value);
  }
  // Set<T>: Map's sibling — same provenance rule, elements fenced to Map's
  // KEY kinds (f64/string, SameValueZero). Anything else stays unmapped;
  // the `new Set` lowering names the offending element type specifically.
  if (isStdlibInterface("Set") || isStdlibInterface("ReadonlySet")) {
    const args = checker.getTypeArguments(widened as ts.TypeReference);
    if (args.length !== 1) return null;
    const elem = mapType(args[0]!, ctx);
    if (!elem || !isSupportedSetElem(elem)) return null;
    return setOf(elem);
  }
  // Date: a TimeClip'd epoch-millisecond scalar in the static runtime.
  // This supports stored/passed values and the read-only getter slice;
  // identity and mutation stay fenced because the scalar deliberately
  // carries no object identity.
  if (isStdlibInterface("Date")) return DATE_T;
  // RegExp: a reference to the lib RegExp interface — provenance, not the
  // name (a user's own `interface RegExp` maps as a record). Regex values
  // are literals interned as immortal statics; the kind is fenced out of
  // array elements, union arms, and Map keys/values above/below.
  if (isStdlibInterface("RegExp")) {
    return { kind: "regex" };
  }
  // Typed arrays: references to the lib's Uint8Array/Uint32Array/
  // Float32Array interfaces (provenance, not names). The es2022+ lib
  // declares them generic over the backing buffer (`Uint8Array<ArrayBuffer>`
  // in error text) — the type argument is irrelevant here: no views exist,
  // every value owns its storage. The other TypedArray flavors stay
  // unmapped (the record path's index-signature check rejects them).
  // RegExpMatchArray (s.match's result) IS a string[] here — the honest
  // slice: [whole match, ...captures] (a nonparticipating capture reads
  // "" — SEMANTICS.md). The `.index`/`.input`/`.groups` extras fence per
  // member like any other unlowered array property.
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
  if (isStdlibInterface("Timeout")) return F64;
  // NodeJS.Immediate / the fallback `Immediate` (setImmediate's return):
  // the same numeric-handle story over the check-phase queue — its own id
  // space, so clearTimeout of an Immediate no-ops like Node.
  if (isStdlibInterface("Immediate")) return F64;
  if (isStdlibInterface("Uint8Array")) return bytesOf("u8");
  if (isStdlibInterface("Uint32Array")) return bytesOf("u32");
  // Int32Array: the signed 32-bit kind (element reads sign-extend, writes
  // ToInt32-wrap) — the Atomics.wait sleep idiom constructs one over a
  // SharedArrayBuffer, and the i32 semantics hold for every other use.
  if (isStdlibInterface("Int32Array")) return bytesOf("i32");
  if (isStdlibInterface("Float32Array")) return bytesOf("f32");
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
    psym?.name === "Buffer" &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()),
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
    psym?.name === "URL" &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()),
    )
  ) {
    return { kind: "url" };
  }
  // URLSearchParams: the WHATWG live query view — declared as a global
  // interface by the shipped fallback and by @types/node (plus `class
  // URLSearchParams` in the "url" module). Provenance-checked like URL.
  if (
    psym?.name === "URLSearchParams" &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()),
    )
  ) {
    return { kind: "searchParams" };
  }
  // fs.Stats: @types/node's `class Stats` (module "fs") or the fallback
  // declarations' interface. Provenance-checked like URL.
  if (
    psym?.name === "Stats" &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()),
    )
  ) {
    return { kind: "stats" };
  }
  // fs/promises.FileHandle: an owned descriptor object. Module provenance
  // distinguishes it from user interfaces with the same name; both the
  // fallback and @types/node declare it in "fs/promises".
  if (
    psym?.name === "FileHandle" &&
    checker.declarationsOf(psym).some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        ctx.isStdlibFile(d.getSourceFile()) &&
        isDeclaredInAmbientModule(d, "fs/promises"),
    )
  ) {
    return { kind: "fileHandle" };
  }
  // child_process.SpawnSyncReturns: @types/node's generic interface (the
  // Buffer/string split is re-checked at the stdout/stderr READ — status
  // reads work either way) or the fallback declarations' plain interface.
  // Provenance-checked like Stats.
  if (
    psym?.name === "SpawnSyncReturns" &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()),
    )
  ) {
    return { kind: "spawnRes" };
  }
  // child_process.ChildProcess: @types/node's class or the fallback
  // declarations' interface. Provenance-checked like Stats.
  if (
    psym?.name === "ChildProcess" &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()),
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
    (psym?.name === "Server" || psym?.name === "Socket" || psym?.name === "TLSSocket") &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()) &&
        (isDeclaredInAmbientModule(d, "net") ||
          // http.Server extends net.Server in @types/node — and tls.Server
          // / https.Server extend it transitively: same lowered surface
          // (listen/close/address/'error'), same handle kind. tls.TLSSocket
          // extends net.Socket the same way: post-handshake it IS a net
          // socket to every lowered member.
          (psym.name === "Server" &&
            (isDeclaredInAmbientModule(d, "http") ||
              isDeclaredInAmbientModule(d, "tls") ||
              isDeclaredInAmbientModule(d, "https"))) ||
          (psym.name === "TLSSocket" && isDeclaredInAmbientModule(d, "tls"))),
    )
  ) {
    return psym.name === "Server" ? { kind: "netServer" } : { kind: "netSocket" };
  }
  // tls.SecureContext: the opaque parsed-cert/key handle SNI callbacks
  // answer with (tls.createSecureContext({ cert, key }) mints it; the TLS
  // server's handshake consumes it). Module-checked like net.Server —
  // @types/node declares `interface SecureContext` inside `declare module
  // "tls"`, and the shipped fallback mirrors it.
  if (
    psym?.name === "SecureContext" &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()) &&
        isDeclaredInAmbientModule(d, "tls"),
    )
  ) {
    return { kind: "secureCtx" };
  }
  // fs.FSWatcher: the fs.watch handle (scr_watch.c). Module-checked like
  // net.Server — @types/node declares `interface FSWatcher extends
  // EventEmitter` inside `declare module "fs"`, and the shipped fallback
  // mirrors it.
  if (
    psym?.name === "FSWatcher" &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()) &&
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
  if (
    (psym?.name === "WriteStream" &&
      checker.declarationsOf(psym).some(
        (d) =>
          (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
          ctx.isStdlibFile(d.getSourceFile()) &&
          isDeclaredInAmbientModule(d, "tty"),
      )) ||
    (psym?.name === "WritableStream" &&
      checker.declarationsOf(psym).some(
        (d) =>
          ts.isInterfaceDeclaration(d) &&
          ctx.isStdlibFile(d.getSourceFile()) &&
          isDeclaredInAmbientNamespace(d, "NodeJS"),
      ))
  ) {
    return PROCSTREAM_T;
  }
  // The static node:stream classes (the shipped fallback declarations —
  // NOT @types/node, whose stream.Readable also types child stdio; under
  // @types/node the childStream mapping below keeps priority and the
  // static stream classes stand down). Checked BEFORE the childStream
  // branch: the fallback's Readable must map to the runtime class, and
  // under the fallback child.stdout is NodeJS.ReadableStream (its own
  // branch below), so the two never collide.
  for (const [irName, rec] of RUNTIME_STREAM_CLASSES) {
    if (
      psym?.name === rec.lib &&
      checker.declarationsOf(psym).some(
        (d) =>
          ts.isClassDeclaration(d) &&
          ctx.isStdlibFile(d.getSourceFile()) &&
          !isNodeTypesPath(d.getSourceFile().fileName) &&
          isDeclaredInAmbientModule(d, "stream"),
      )
    ) {
      return { kind: "object", className: irName };
    }
  }
  if (
    (psym?.name === "Readable" &&
      checker.declarationsOf(psym).some(
        (d) =>
          (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
          ctx.isStdlibFile(d.getSourceFile()) &&
          isDeclaredInAmbientModule(d, "stream"),
      )) ||
    (psym?.name === "ReadableStream" &&
      checker.declarationsOf(psym).some(
        (d) =>
          ts.isInterfaceDeclaration(d) &&
          ctx.isStdlibFile(d.getSourceFile()) &&
          isDeclaredInAmbientNamespace(d, "NodeJS"),
      ))
  ) {
    return { kind: "childStream" };
  }
  // dgram.Socket: the same ambiguous "Socket" name disambiguated by its
  // enclosing ambient module — @types/node's `class Socket extends
  // EventEmitter` and the fallback declarations' interface both live
  // inside `declare module "dgram"`.
  if (
    psym?.name === "Socket" &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()) &&
        isDeclaredInAmbientModule(d, "dgram"),
    )
  ) {
    return { kind: "dgramSocket" };
  }
  // node:test's TestContext — the test-body parameter (`test('x', (t) =>
  // ...)`). @types/node's `class TestContext` and the fallback
  // declarations' interface both live inside `declare module "node:test"`
  // (isDeclaredInAmbientModule answers for both spellings).
  if (
    psym?.name === "TestContext" &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()) &&
        isDeclaredInAmbientModule(d, "test"),
    )
  ) {
    return { kind: "testCtx" };
  }
  // NodeJS.ErrnoException: @types/node's `interface ErrnoException extends
  // Error` (dns/fs callback error types). It IS an Error at runtime — map
  // it to the runtime %Error hierarchy like the lib Error interfaces
  // above; the optional errno/code/path/syscall extras fence per member
  // (the .stack stance). Provenance-checked like the rest.
  if (
    psym?.name === "ErrnoException" &&
    checker.declarationsOf(psym).some(
      (d) => ts.isInterfaceDeclaration(d) && ctx.isStdlibFile(d.getSourceFile()),
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
    psym?.name === "Agent" &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()) &&
        (isDeclaredInAmbientModule(d, "http") || isDeclaredInAmbientModule(d, "https")),
    )
  ) {
    return { kind: "dyn" };
  }
  // http.IncomingMessage / http.ServerResponse — module-checked like
  // net.Server (the names repeat nowhere today, but provenance stays the
  // rule).
  if (
    (psym?.name === "IncomingMessage" || psym?.name === "ServerResponse") &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()) &&
        isDeclaredInAmbientModule(d, "http"),
    )
  ) {
    return psym.name === "IncomingMessage" ? { kind: "httpReq" } : { kind: "httpRes" };
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
    (psym?.name === "Http2SecureServer" ||
      psym?.name === "Http2ServerRequest" ||
      psym?.name === "Http2ServerResponse") &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()) &&
        isDeclaredInAmbientModule(d, "http2"),
    )
  ) {
    return psym.name === "Http2SecureServer"
      ? { kind: "netServer" }
      : psym.name === "Http2ServerRequest"
        ? { kind: "httpReq" }
        : { kind: "httpRes" };
  }
  // The REAL h2 surface (scr_http2.c): the h2c server is a net server
  // like the secure one; sessions and streams are first-class handle
  // kinds (client and server flavors share a kind — the runtime handle
  // carries the role). Module-checked like the rest.
  if (
    (psym?.name === "Http2Server" || psym?.name === "Http2Session" ||
      psym?.name === "ClientHttp2Session" || psym?.name === "ServerHttp2Session" ||
      psym?.name === "ClientHttp2Stream" || psym?.name === "ServerHttp2Stream") &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()) &&
        isDeclaredInAmbientModule(d, "http2"),
    )
  ) {
    return psym.name === "Http2Server"
      ? { kind: "netServer" }
      : psym.name === "ClientHttp2Stream" || psym.name === "ServerHttp2Stream"
        ? { kind: "http2Stream" }
        : { kind: "http2Session" };
  }
  // http.ClientRequest (http.request/http.get results) — module-checked
  // like IncomingMessage.
  if (
    psym?.name === "ClientRequest" &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()) &&
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
    psym?.name === "ProcessEnv" &&
    checker.declarationsOf(psym).some(
      (d) => ts.isInterfaceDeclaration(d) && ctx.isStdlibFile(d.getSourceFile()),
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
    // value is checked-dynamic, the same honesty `unknown` gets. Dynamic
    // builds keep the jsval mapping below (an engine promise is one
    // handle).
    if (arg.flags & ts.TypeFlags.Any && !ctx.dynamic) return { kind: "promise", inner: DYN };
    const inner = mapType(arg, ctx);
    if (!inner) return null;
    return { kind: "promise", inner };
  }
  // Generator<T, TReturn, TNext> (and the lib's IterableIterator<T, ...>,
  // the older annotation spelling — Generator extends it): the sync
  // generator kind. Channel normalization keeps the runtime honest:
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
  // Mixed dyn/concrete channels stay unmapped: the shared result record's
  // value slot would need a dyn union arm, which does not exist.
  if (isStdlibInterface("Generator") || isStdlibInterface("IterableIterator")) {
    const args = checker.getTypeArguments(widened as ts.TypeReference);
    const channels = genChannels(args[0], args[1], args[2], ctx);
    if (!channels) return null;
    // The result record must exist too (its union must be legal), or
    // `.next()` could never answer — mapped generators always resume.
    if (!genResultRecord(channels.yieldT, channels.retT, ctx.shapes, unions)) return null;
    return { kind: "generator", ...channels };
  }
  // IteratorResult<T, TReturn> — the checker's type of `g.next()` (an
  // alias for IteratorYieldResult<T> | IteratorReturnResult<TReturn>):
  // maps to the SAME interned record genResume answers, so `const r =
  // g.next()` binds without an annotation and reads flow.
  {
    const alias = widened.getAliasSymbol();
    if (
      alias?.name === "IteratorResult" &&
      checker.declarationsOf(alias).some(
        (d) => ts.isTypeAliasDeclaration(d) && ctx.isStdlibFile(d.getSourceFile()),
      )
    ) {
      const targs = widened.getAliasTypeArguments() ?? [];
      const channels = genChannels(targs[0], targs[1], undefined, ctx);
      if (!channels) return null;
      return genResultRecord(channels.yieldT, channels.retT, ctx.shapes, unions);
    }
  }
  // PromiseSettledResult<T>'s parts: the lib's PromiseFulfilledResult<T> /
  // PromiseRejectedResult interfaces map to the documented HONEST SUBSET
  // record { status: string } — `value` (T) and `reason` (any) have no
  // record-field representation here (void fields don't exist; a jsval
  // field would absorb the record), and the manual-allSettled pattern this
  // mapping exists for (pMap) discards them. Construction literals still
  // EVALUATE a dropped initializer for its effects — the awaited mapper —
  // via the object-literal lowering's drop path. Both interfaces intern
  // the SAME shape, so the settled union collapses to one record arm and
  // status keeps its string reads/comparisons. SEMANTICS.md 46.
  // net/dgram AddressInfo and dgram RemoteInfo: stdlib interfaces over
  // data properties, interned EXPLICITLY (the record path's provenance
  // fence keeps .d.ts shapes out of the structural walk — the
  // PromiseFulfilledResult precedent). RemoteInfo's 'IPv4' | 'IPv6'
  // family widens to string here; the runtime only ever answers "IPv4"
  // (udp4 is the one lowered socket type).
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
  // literals fence at the shape check instead of silently dropping.
  if (isStdlibInterface("ExecFileSyncOptionsWithStringEncoding")) {
    const optStr = withUndefinedArm(STRING, ctx.unions);
    const optNum = withUndefinedArm(F64, ctx.unions);
    const optBool = withUndefinedArm(BOOL, ctx.unions);
    const stdioArms = [arrayOf(STRING), STRING, UNDEFINED_T].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
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
  // fs/promises FileReadResult<T> / FileWriteResult<T>: the two-field
  // null-prototype objects returned by FileHandle.read/write. The native
  // record does not model the prototype (unobservable through the lowered
  // surface); it preserves the caller buffer/string by reference.
  if (
    (psym?.name === "FileReadResult" || psym?.name === "FileWriteResult") &&
    checker.declarationsOf(psym).some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        ctx.isStdlibFile(d.getSourceFile()) &&
        isDeclaredInAmbientModule(d, "fs/promises"),
    )
  ) {
    const args = checker.getTypeArguments(widened as ts.TypeReference);
    if (args.length !== 1) return null;
    const payload = mapType(args[0]!, ctx);
    if (!payload || !(payload.kind === "string" || (payload.kind === "bytes" && payload.elem === "u8"))) {
      return null;
    }
    const count = psym.name === "FileReadResult" ? "bytesRead" : "bytesWritten";
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [
          { name: "buffer", type: payload },
          { name: count, type: F64 },
        ],
        false,
        undefined,
        [count, "buffer"],
      ),
    };
  }
  // fs.Dirent (readdirSync's withFileTypes rows): interned explicitly on
  // the AddressInfo pattern. The VISIBLE fields are Node's own keys (name,
  // parentPath — Object.keys order matches Node via declaredOrder); the
  // hidden %dtype field carries the entry kind (libuv's UV_DIRENT
  // encoding) that the isFile/isDirectory/isSymbolicLink call lowerings
  // read (lowerDirentMethodCall — the StringDecoder pattern, so the
  // %-field never surfaces through the lowered Dirent surface itself;
  // JSON.stringify of a Dirent would show it — the documented
  // internal-shape edge). @types/node declares Dirent<Name> generic over
  // the name's encoding — only the string instantiation maps (the
  // encoding:'buffer' readdir form has no lowering); the shipped fallback
  // declares it concrete (an interface; @types/node uses a class — both
  // provenance-checked, the Buffer/URL pattern).
  if (
    psym?.name === "Dirent" &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()),
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
  // crypto.X509Certificate — the Dirent-style data record: THREE visible
  // fields (fingerprint and the validFrom/validTo validity window, all
  // computed at construction by the new-expression lowering). Module-
  // checked like SecureContext; @types/node declares the class inside
  // `declare module "crypto"`, the shipped fallback mirrors it.
  // JSON.stringify of one shows the three fields where Node's
  // internal-slot object shows {} — the Dirent %dtype edge's cousin.
  if (
    psym?.name === "X509Certificate" &&
    checker.declarationsOf(psym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(d.getSourceFile()) &&
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
  if (isStdlibInterface("ResourceUsage")) {
    const names = [
      "userCPUTime", "systemCPUTime", "maxRSS", "sharedMemorySize",
      "unsharedDataSize", "unsharedStackSize", "minorPageFault",
      "majorPageFault", "swappedOut", "fsRead", "fsWrite", "ipcSent",
      "ipcReceived", "signalsCount", "voluntaryContextSwitches",
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
  if (isStdlibInterface("NetworkInterfaceInfoIPv4") || isStdlibInterface("NetworkInterfaceInfoIPv6")) {
    const v6 = psym!.name === "NetworkInterfaceInfoIPv6";
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
        "address", "netmask", "family", "mac", "internal", "cidr", "scopeid",
      ]),
    };
  }
  if (
    isStdlibInterface("PromiseFulfilledResult") ||
    isStdlibInterface("PromiseRejectedResult")
  ) {
    return {
      kind: "record",
      shapeId: ctx.shapes.intern([{ name: "status", type: STRING }], false, undefined, ["status"]),
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
  // Rest parameters keep the fence (a rest signature is never spellable
  // as one completed arity).
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
  }
  const callSigs = checker.getCallSignatures(widened);
  if (callSigs.length === 1) {
    const sig = callSigs[0]!;
    if (sig.getTypeParameters().length) return null;
    // A SYNTHESIZED rest param (tsc's JS inference for a function body
    // reading `arguments` — `(...args: any[]) => any` whose args symbol
    // has no declaration): the dotDotDot check below can't see it, and a
    // fixed-arity func mapping would LIE about the value's calling
    // convention. Detected by the param-count mismatch against the
    // signature's own declaration; unmappable like spelled rest.
    {
      const sigDecl = checker.signatureDeclaration(sig);
      const declParams = sigDecl !== undefined && ts.isFunctionLike(sigDecl) ? sigDecl.parameters : undefined;
      if (declParams !== undefined && declParams.length !== sig.getParameters().length) {
        return null;
      }
      // tsgo never SYNTHESIZES that rest param into the inferred signature
      // (5.9.3 did — the count mismatch above was the whole detector
      // there), so the declaration's own body answers directly.
      if (sigDecl !== undefined && ts.isFunctionLike(sigDecl) && bodyReadsArgumentsLocal(sigDecl as { body?: ts.Node })) {
        return null;
      }
    }
    const params: IrType[] = [];
    for (const p of sig.getParameters()) {
      const decl = checker.valueDeclarationOf(p);
      if (decl && ts.isParameter(decl) && decl.dotDotDotToken) {
        return null;
      }
      const optional =
        decl !== undefined &&
        ts.isParameter(decl) &&
        (decl.questionToken !== undefined || decl.initializer !== undefined);
      let pt = mapType(checker.getTypeOfSymbol(p), ctx);
      // Belt and braces for non-strict type worlds: an optional param's
      // ABI slot is always the undefined-armed union (strictNullChecks
      // already spells it that way; arm it here if the world didn't).
      if (optional && pt && pt.kind !== "void" && pt.kind !== "jsval") {
        const armed = withUndefinedArm(pt, ctx.unions);
        if (!armed) return null;
        pt = armed;
      }
      if (!pt) return null;
      // `(value: void) => void` (Promise<void>'s resolve) is callable with
      // no arguments — a void param is dropped, not a mapping failure.
      if (pt.kind === "void") continue;
      params.push(pt);
    }
    const retT = checker.getReturnTypeOfSignature(sig);
    // `() => never` (a throw-only lambda's inferred type) is assignable to
    // `() => void` and its calls never produce a value — map the return
    // like declaredReturnType does for declarations.
    const ret = retT.flags & ts.TypeFlags.Never ? VOID : mapType(retT, ctx);
    if (!ret) return null;
    return funcOf(params, ret);
  }
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
  // (kill/on/stdout/stderr/unref/exitCode — a data record like
  // `{ pid: number }` never qualifies). The TYPE maps to the child
  // handle: in a compiled program the only VALUE producer is spawn
  // itself (a mock object literal in this slot fences at its
  // construction site), and every member the interface may declare is
  // exactly a lowered child member, so uses typecheck against the
  // interface and lower against the handle.
  if (
    flags & ts.TypeFlags.Object &&
    callSigs.length === 0 &&
    psym !== undefined &&
    checker.declarationsOf(psym).length > 0 &&
    checker.declarationsOf(psym).every(
      (d) => ts.isInterfaceDeclaration(d) && !ctx.isStdlibFile(d.getSourceFile()),
    )
  ) {
    const CHILD_SURFACE = new Set([
      "pid", "exitCode", "killed", "kill", "on", "once", "off",
      "removeListener", "unref", "ref", "stdout", "stderr",
    ]);
    const CHILD_CORE = new Set(["kill", "on", "stdout", "stderr", "unref", "exitCode"]);
    const props = checker.getPropertiesOfType(widened);
    let core = 0;
    const childShaped =
      props.length > 0 &&
      props.every((p) => {
        if (!CHILD_SURFACE.has(p.name)) return false;
        if (CHILD_CORE.has(p.name)) core++;
        return true;
      });
    if (childShaped && core >= 2) return CHILD_T;
  }
  if (flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection) && callSigs.length === 0) {
    const viaAlias = mapGenericUtilityAlias(widened, ctx);
    if (viaAlias) return viaAlias;
    const record = mapRecordType(widened, ctx);
    if (record) return record;
  }
  // Unions. `boolean` is internally `true | false`, and narrowing produces
  // literal unions like `"a" | "b"` — parts that map to the SAME IR type
  // collapse (deduplicated by typeKey), so a single surviving arm is just
  // that type. Two or more distinct arms become a TAGGED union: the
  // typeKey-sorted arm list is interned (its identity), and an arm's index
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
      return { kind: "union", unionId: unions.recursiveRef(widened) };
    }
    unions.inProgress.add(widened);
    const sensitivityAtEntry = contextResolutions;
    try {
      const byKey = new Map<string, IrType>();
      for (const part of ts.constituentTypes(widened)) {
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
        const mapped = mapType(part, ctx);
        // A jsval PART absorbs the union: `GeneratedFile | undefined` (a
        // package-declared arm) is one island handle — the engine's
        // undefined/null ARE handle values, and any data sibling is
        // representable in the engine too, so the handle is the one
        // runtime representation. Exactly tsc's own collapse for `any | T`
        // (which never even reaches here as a union). Sibling arms that
        // already mapped don't matter — and ones that would NOT map on
        // their own don't block the absorb either: a STATIC value of such
        // an arm flowing in still fences per-site at the marshal
        // (jsvalIn's boundary message).
        if (mapped?.kind === "jsval") return JSVAL;
        if (!mapped) {
          // Before failing the whole union, let a LATER jsval part absorb.
          for (const rest of ts.constituentTypes(widened)) {
            if (mapType(rest, ctx)?.kind === "jsval") return JSVAL;
          }
          return null;
        }
        byKey.set(typeKey(mapped), mapped);
      }
      const arms = [...byKey.values()];
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
      // maybeNarrow's validated scalar extraction), and engine-valued
      // arms ride the island kind (SCR_DYN_JSVAL), so no per-arm runtime
      // tag is ever needed and the component fence retires at these
      // sites. The domain is dynSubsumableUnionArm's: scalars, units, dyn
      // itself, and records/arrays inside the dynFrom conversion domain
      // (those enter as dyn data — the deep-copy stance, so identity and
      // mutation coupling with the source value end at the slot;
      // SEMANTICS.md). Arms with real typed representations whose
      // semantics would DEGRADE under the collapse — class instances,
      // Maps/Sets, functions (closure identity, `x === String`
      // narrowing), promises, regexes, generators, handles — keep their
      // existing union homes and fences below. A pending recursive
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
            a.kind === "void" || a.kind === "union" || a.kind === "dyn" ||
            a.kind === "generator" ||
            ((a.kind === "map" || a.kind === "set" || a.kind === "date" || a.kind === "regex" || a.kind === "promise") &&
              arms.some((b) => b !== a && !isUnitType(b))),
        )
      ) {
        return null;
      }
      arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
      if (unions.recursivePending(widened)) {
        // The knot closed through this union. A frame that resolved
        // through context-sensitive hooks (generic type parameters, mixin
        // instantiations) cannot intern by checker-type identity — the
        // same ts.Type answers differently per instantiation — so
        // recursive generic-open unions stay fenced.
        if (contextResolutions !== sensitivityAtEntry) return null;
        return { kind: "union", unionId: unions.finalizeRecursive(widened, arms) };
      }
      return { kind: "union", unionId: unions.intern(arms) };
    } finally {
      unions.inProgress.delete(widened);
    }
  }
  return null;
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
  const resolveSide = (t: ts.Type): ts.Type | null =>
    t.flags & ts.TypeFlags.TypeParameter ? resolveTypeParamTs(t) : t;
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
/** `Awaited<T>` where T is a STILL-GENERIC type parameter, resolved against
 * the lowerer's binding: promise kinds unwrap recursively (the alias's own
 * recursion), everything else is already its awaited self — including
 * jsval (the engine's await handles thenables natively). Null off the
 * shape (not the lib's Awaited over a bound parameter). */
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
  for (let cur: ts.Node = n; cur !== undefined && !ts.isSourceFile(cur); cur = cur.parent) {
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
function constAssertedEmptyArrayProp(p: ts.Symbol, ctx: TypeMapperCtx): boolean {
  const d = ctx.checker.valueDeclarationOf(p);
  if (d === undefined || !ts.isPropertyAssignment(d)) return false;
  const init = d.initializer;
  // `a: [] as const` pins the field type by itself, wherever the literal sits.
  if (ts.isAsExpression(init) && isConstAssertionTypeNode(init.type)) {
    return ts.isArrayLiteralExpression(init.expression) && init.expression.elements.length === 0;
  }
  if (!ts.isArrayLiteralExpression(init) || init.elements.length > 0) return false;
  return underConstAssertion(d);
}

function mapGenericAwaitedAlias(type: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const { resolveTypeParam } = ctx;
  if (!resolveTypeParam) return null;
  const alias = type.getAliasSymbol();
  if (!alias || alias.name !== "Awaited") return null;
  const aliasArgs = type.getAliasTypeArguments();
  const arg = aliasArgs[0];
  if (aliasArgs.length !== 1 || !arg) return null;
  if (!(arg.flags & ts.TypeFlags.TypeParameter)) return null;
  // Provenance: the STANDARD LIBRARY's alias, not a user's shadowing one.
  const isLibAlias = ctx.checker.declarationsOf(alias).some(
    (d) => ts.isTypeAliasDeclaration(d) && ctx.isStdlibFile(d.getSourceFile()),
  );
  if (!isLibAlias) return null;
  const bound = resolveTypeParam(arg);
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
  if (!(obj.flags & ts.TypeFlags.TypeParameter)) return null;
  const bound = resolveTypeParam(obj);
  if (!bound || bound.kind !== "record") return null;
  const shape = shapes.get(bound.shapeId);
  if (!shape || shape.tuple) return null;
  const idx = type.getIndexType();
  let covered: IrType[] | null = null;
  if (idx.isStringLiteralType()) {
    const f = shape.fields.find((x) => x.name === idx.value);
    covered = f ? [f.type] : shape.indexValue ? [shape.indexValue] : null;
  } else {
    const allKeys =
      (idx.flags & ts.TypeFlags.TypeParameter && resolveTypeParam(idx)?.kind === "string") ||
      (idx.isIndexType() && idx.getTarget() === obj);
    if (allKeys) {
      covered = shape.fields.map((f) => f.type);
      if (shape.indexValue) covered.push(shape.indexValue);
    }
  }
  if (!covered || covered.length === 0) return null;
  const first = covered[0]!;
  return covered.every((t) => typeEquals(t, first)) ? first : null;
}

function mapGenericUtilityAlias(widened: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const { resolveTypeParam, shapes, unions } = ctx;
  if (!resolveTypeParam) return null;
  const alias = widened.getAliasSymbol();
  if (!alias || (alias.name !== "Partial" && alias.name !== "Readonly")) return null;
  const aliasArgs = widened.getAliasTypeArguments();
  const arg = aliasArgs[0];
  if (aliasArgs.length !== 1 || !arg) return null;
  if (!(arg.flags & ts.TypeFlags.TypeParameter)) return null;
  // Provenance: the STANDARD LIBRARY's alias, not a user's shadowing one.
  const isLibAlias = ctx.checker.declarationsOf(alias).some(
    (d) => ts.isTypeAliasDeclaration(d) && ctx.isStdlibFile(d.getSourceFile()),
  );
  if (!isLibAlias) return null;
  const bound = resolveTypeParam(arg);
  if (!bound || bound.kind !== "record") return null;
  if (alias.name === "Readonly") return bound;
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

/** The IteratorResult record of a generator's value channels: `{ done:
 * boolean, value: V }` where V is dyn (an any/unknown channel) or the
 * canonical union of the yield arms, the return arms (when the return
 * channel carries a value), and `undefined` (an exhausted `.next()`
 * answers undefined). ONE shape per channel pair — `g.next()`'s lowering,
 * `.return()`, `.throw()`, the for-of desugar, and mapType's
 * IteratorResult alias mapping all intern through here, so reads agree.
 * Null when the combined union would be illegal (a func/set arm beside
 * data arms, a map/regex/Date arm — kinds with no narrowing test): such
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
      if (
        t.kind === "map" || t.kind === "regex" || t.kind === "date" ||
        t.kind === "jsval" || t.kind === "generator"
      ) {
        return false; // no legal union arm exists for these kinds
      }
      byKey.set(typeKey(t), t);
      return true;
    };
    if (!add(yieldT) || !add(retT)) return null;
    byKey.set(typeKey(UNDEFINED_T), UNDEFINED_T);
    const arms = [...byKey.values()];
    // func/set arms are legal only beside unit arms (no narrowing test
    // against data siblings — the union rule).
    if (
      arms.some(
        (a) => (a.kind === "func" || a.kind === "set") && !arms.every((b) => b === a || isUnitType(b)),
      )
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
    shapeId: shapes.intern([
      { name: "done", type: BOOL },
      { name: "value", type: valueT },
    ]),
  };
}

/** True when a checker type is inhabited ONLY by the unit values —
 * undefined (or `void`, whose runtime inhabitant is undefined) and null,
 * or a union of just those. The positions that today fence VOID (record
 * fields, tuple/array elements, variable slots) substitute unitOnlyUnion
 * for these; RETURN positions keep the VOID mapping (a void return is not
 * a value). */
export function isUnitOnlyTsType(t: ts.Type): boolean {
  const UNIT = ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null;
  const parts: readonly ts.Type[] = t.isUnionType() ? ts.constituentTypes(t) : [t];
  return parts.every((p) => (p.flags & UNIT) !== 0);
}

/** IR-level `t | undefined`, canonicalized and fenced exactly like the
 * ts-union branch of mapType (typeKey-sorted arms, deduplicated; map/
 * regex/Date/dyn/void arms unrepresentable; a func arm IS representable — the
 * result is exactly the nullable-callback shape mapType's union branch
 * admits, `(() => void) | undefined`) so the interned union is IDENTICAL
 * to what mapping the checker's own `T | undefined` produces. */
export function withUndefinedArm(t: IrType, unions: UnionRegistry): IrType | null {
  if (t.kind === "union") {
    const def = unions.get(t.unionId);
    if (!def) return null;
    if (def.arms.some((a) => a.kind === "date")) return null;
    if (def.arms.some((a) => a.kind === "undefinedT")) return t;
    const arms = [...def.arms, UNDEFINED_T];
    arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
    return { kind: "union", unionId: unions.intern(arms) };
  }
  if (
    t.kind === "void" || t.kind === "map" || t.kind === "date" || t.kind === "dyn" ||
    // A bare unit field type cannot occur (units live only inside unions),
    // but guard against constructing a single-arm union from one.
    isUnitType(t)
  ) {
    return null;
  }
  const arms = [t, UNDEFINED_T];
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
    // No jsval absorb here: an island-entangled hybrid is not this shape.
    if (!pt || pt.kind === "void" || pt.kind === "jsval") return null;
    fields.push({ name: p.name, type: pt });
    declaredOrder.push(p.name);
  }
  if (fields.length === 1) return null; // no properties — it is just F
  fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { kind: "record", shapeId: shapes.intern(fields, false, undefined, declaredOrder) };
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
    return ts.constituentTypes(t).every(
      (part) => {
        const partSym = part.getSymbol();
        return (part.flags & ts.TypeFlags.Object) !== 0 &&
          !(partSym && partSym.flags & ts.SymbolFlags.Class) &&
          checker.getCallSignatures(part).length === 0 &&
          checker.getConstructSignatures(part).length === 0 &&
          recordProvenanceOk(part, ctx);
      },
    );
  }
  if (isMappedShape(t)) return true;
  const tSym = t.getSymbol();
  const decls = tSym ? checker.declarationsOf(tSym) : undefined;
  if (!decls || decls.length === 0) return false;
  return !decls.some((d) => {
    const sf = d.getSourceFile();
    return sf.isDeclarationFile && !ctx.isExternalTypeFile(sf);
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

/** The computed pieces of a record shape mapRecordTypeInner hands back for
 * the OUTER frame to intern — or, when a back-reference minted a recursive
 * placeholder for the type mid-construction, to finalize INTO that
 * placeholder (the named-recursive-shape knot). */
interface RecordShapeParts {
  fields: { name: string; type: IrType }[];
  indexValue?: IrType;
  declaredOrder?: string[];
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
    return { kind: "record", shapeId: shapes.recursiveRef(widened) };
  }
  shapes.inProgress.add(widened);
  const sensitivityAtEntry = contextResolutions;
  try {
    const inner = mapRecordTypeInner(widened, ctx);
    if (inner === null) return null; // a pending placeholder, if minted, stays unfinalized (prunes as unreachable)
    if (!("fields" in inner)) {
      // A whole-type answer (the jsval/dyn absorbs, the header-family
      // canonical shape). If a back-reference minted a placeholder for
      // this very type meanwhile, the two answers disagree — fence rather
      // than leave references to a shape that is not this type's mapping.
      if (shapes.recursivePending(widened) && inner.kind !== "jsval" && inner.kind !== "dyn") return null;
      return inner;
    }
    if (shapes.recursivePending(widened)) {
      // The knot closed through this shape. Context-sensitive frames
      // (generic type parameters, mixin instantiations) cannot intern by
      // checker-type identity — fence recursive generic-open shapes.
      if (contextResolutions !== sensitivityAtEntry) return null;
      return {
        kind: "record",
        shapeId: shapes.finalizeRecursive(widened, inner.fields, inner.indexValue, inner.declaredOrder),
      };
    }
    return { kind: "record", shapeId: shapes.intern(inner.fields, false, inner.indexValue, inner.declaredOrder) };
  } finally {
    shapes.inProgress.delete(widened);
  }
}

function mapRecordTypeInner(widened: ts.Type, ctx: TypeMapperCtx): IrType | RecordShapeParts | null {
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
        ts.constituentTypes(k).every(
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
      const iv = mapType(info.valueType, ctx);
      // A jsval-valued signature absorbs the shape: `Record<string,
      // JSONValue>` (a package's own JSON alias) and `Record<string, any>`
      // are one island object — the overflow map has no handle slot, and
      // island objects hold arbitrary engine values natively.
      if (iv?.kind === "jsval") return JSVAL;
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
      a.kind === "f64" || a.kind === "string" || a.kind === "undefinedT" ||
      (a.kind === "array" && a.elem.kind === "string");
    if (
      slotDef !== undefined &&
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
      if (checker.getPropertiesOfType(widened).every((p) => fits(mapType(checker.getTypeOfSymbol(p), ctx)))) {
        return { kind: "record", shapeId: shapes.intern([], false, canonical, []) };
      }
    }
  }
  // Provenance keeps LIB type worlds out — but a PURE string index
  // signature with no declared members is structurally Record<string, V>
  // wherever it is declared (the lib's Object.fromEntries return type
  // `{ [k: string]: T }` — a data shape, not an API surface). Members, if
  // any, still walk the per-member provenance below.
  const pureIndexShape = indexValue !== undefined && checker.getPropertiesOfType(widened).length === 0;
  // The ANONYMOUS empty object type (`var v: {}` — the checker's shared
  // `{}` intrinsic carries a declaration-less `__type` symbol, so
  // declaration provenance has nothing to inspect): structurally the empty
  // record. tsc admits ANY non-nullish assignment into a `{}` slot;
  // non-record values fence at their assignment site (the exact-shape
  // stance), records of other shapes at theirs — the declaration itself is
  // representable.
  const anonSym = widened.getSymbol();
  const anonymousEmpty =
    (anonSym === undefined || checker.declarationsOf(anonSym).length === 0) &&
    !widened.isIntersectionType() &&
    indexValue === undefined &&
    checker.getPropertiesOfType(widened).length === 0;
  if (!recordProvenanceOk(widened, ctx) && !pureIndexShape && !anonymousEmpty) return null;
  // Checker-computed shapes (no user declaration) need two extra fences in
  // the member walk below; see the comments there.
  const computed = widened.isIntersectionType() || isMappedShape(widened);
  {
    const props = checker.getPropertiesOfType(widened);
    // A computed shape with NO members is not a real empty record: inside a
    // generic body `Partial<T>` resolves to no members at all (keyof T is
    // still unknown there) — interning `{}` would be silently wrong. The
    // degenerate empties (`Partial<{}>`, `Omit<C, keyof C>`) go with it.
    // An INDEX-SIGNATURE shape is exempt: `Record<string, T>` legitimately
    // has zero declared members — the signature is the shape.
    if (computed && props.length === 0 && !indexValue) return null;
    // A DECLARED empty object type — `{}` (spelled or the checker's shared
    // intrinsic), `interface Empty {}` — is tsc's TOP type over non-nullish
    // values: every number, string, record, array, function, or class
    // instance is assignable into the slot, so the exact-record stance
    // cannot hold it. It lowers like `unknown` (the dyn), the same rule
    // as `object` and the lib's `Object`: assignments convert at the site
    // (sources outside the checked-dynamic tree fence there, exactly as unknown does), reads
    // narrow back out through the same checked casts. The type INFERRED
    // from an empty object literal (`const o = {}`) stays the empty record
    // — it describes a value the program built, not an annotation that
    // admits everything — and computed empties (`Partial<T>` in a generic
    // body) returned null above. Empty shapes WITH an index signature
    // (`Record<string, T>`) are not empty: the signature is the shape.
    if (
      props.length === 0 &&
      indexValue === undefined &&
      checker.getCallSignatures(widened).length === 0 &&
      checker.getConstructSignatures(widened).length === 0 &&
      !(anonSym !== undefined && checker.declarationsOf(anonSym).some((d) => ts.isObjectLiteralExpression(d)))
    ) {
      return DYN;
    }
    const fields: { name: string; type: IrType }[] = [];
    for (const p of props) {
      if (p.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) {
        // OBJECT-LITERAL get/set accessors (TS sources): the property has
        // no data slot — the shape carries reserved closure fields instead
        // (`%get:x` invoked per read, `%set:x` per write; see
        // accessorSlotProp in ir/ir.ts). Type-literal and interface
        // accessor MEMBERS map the same way so accessor records cross
        // annotated boundaries (`function f(p: { get x(): number })`) —
        // tsc lets a plain DATA property satisfy such a member, but the
        // exact-shape stance turns that into a loud shape-mismatch fence
        // at the literal, never a silent split. JS-file literals keep
        // their existing paths (the CJS export-table narrowing and the
        // checked-dynamic fallback), and .d.ts declarations stay out with
        // the rest of the lib's type worlds.
        const decls = checker.declarationsOf(p);
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
              !d.getSourceFile().isDeclarationFile &&
              !isJsSourceFile(d.getSourceFile()),
          );
        if (!accessorOwned || (!getDecl && !setDecl)) return null;
        // Symbol-keyed accessors have no foldable literal name to fill at
        // the literal — no slot to make.
        if (p.name.startsWith("__@")) return null;
        // An index-signature shape stores accessor NAMES nowhere the keyed
        // read/walk machinery can answer (the overflow would miss where
        // Node dispatches the getter) — those shapes stay unmapped.
        if (indexValue !== undefined) return null;
        let readT: IrType | null = null;
        if (getDecl) {
          readT = mapType(checker.getTypeOfSymbol(p), ctx);
          if (readT === null || readT.kind === "jsval") return null;
        }
        let writeT: IrType | null = null;
        if (setDecl) {
          const param = (setDecl as ts.SetAccessorDeclaration).parameters[0];
          if (!param) return null;
          writeT = mapType(checker.getTypeAtLocation(param), ctx);
          // A void/unit-typed write slot has no value form; DIVERGENT
          // getter/setter types stay out too (one property, one type —
          // the class-accessor stance).
          if (writeT === null || writeT.kind === "void" || writeT.kind === "jsval" || isUnitType(writeT)) return null;
          if (readT !== null && typeKey(readT) !== typeKey(writeT)) return null;
        }
        if (readT !== null || getDecl) fields.push({ name: `%get:${p.name}`, type: funcOf([], readT ?? VOID) });
        if (writeT !== null) fields.push({ name: `%set:${p.name}`, type: funcOf([writeT], VOID) });
        continue;
      }
      // Computed shapes carry provenance per MEMBER: a utility type over a
      // lib interface (`Readonly<Date>`) is still the lib's type world, not
      // a data shape. Synthesized members (a literal-key Record's) have no
      // declarations and pass.
      if (
        computed &&
        checker.declarationsOf(p).some((d) => {
          const sf = d.getSourceFile();
          return sf.isDeclarationFile && !ctx.isExternalTypeFile(sf);
        })
      ) {
        return null;
      }
      const fieldTs = checker.getTypeOfSymbol(p);
      // GENERIC-callable members leave the shape (no single closure slot
      // can hold them — see isGenericCallableMemberType): the shape keeps
      // its data fields, and calls of the member monomorphize per call
      // site against the defining object literal's declaration.
      if (isGenericCallableMemberType(fieldTs, checker)) continue;
      let pt = mapType(fieldTs, ctx);
      // tsgo PANICS computing `readonly []` through the symbol-type query
      // (the TupleType conversion — the facade's panic fence answers
      // `any`), which would absorb the whole shape into the dynamic tier.
      // The declaration pins the truth syntactically: a property whose
      // initializer is an EMPTY array literal inside a const assertion IS
      // the empty tuple — map it exactly as the tuple branch does (the
      // unit-element array; see the `[] as const` rule there).
      if ((pt === null || pt.kind === "jsval") && (fieldTs.flags & ts.TypeFlags.Any) !== 0 && constAssertedEmptyArrayProp(p, ctx)) {
        pt = arrayOf(unitOnlyUnion(ctx.unions));
      }
      // Unit-only FIELDS (`{ msg?: undefined }` — the discriminated-union
      // absent-field idiom — and `{ p: undefined }` spellings): the
      // unit-only union. The runtime value is the interned unit, JSON
      // omits the undefined arm exactly like an omitted optional.
      if (pt?.kind === "void" && isUnitOnlyTsType(fieldTs)) pt = unitOnlyUnion(ctx.unions);
      // dyn FIELDS map now (`{ v: unknown }`, `[string, unknown]` tuples):
      // the slot carries a dyn value exactly like an `unknown`-valued
      // overflow entry — same RC adapters, same dynFrom conversion on the
      // way in, same checked casts on the way out. (JSON.stringify of a
      // dyn-field-bearing shape keeps its fence: jsonSafe stays false.)
      if (!pt || pt.kind === "void") return null;
      // A DATA property spelled like a reserved accessor slot (`{ "%get:x":
      // v }` — a string-literal key): mapping it would collide with the
      // accessor dispatch, so the shape stays unmapped.
      if (accessorSlotProp(p.name) !== null) return null;
      // A bare jsval FIELD absorbs the record: shapes have no handle slot
      // (the IR forbids jsval fields — no JSON story), while an island
      // OBJECT holds engine values natively — `{ model: gateway(id),
      // prompt }` is one island object, built field by field (jsval
      // members as the same handle, static members marshaled). jsval-
      // BEARING composite fields (`content: any[]`) keep their static
      // shape — the lift covers them.
      if (pt.kind === "jsval") return JSVAL;
      fields.push({ name: p.name, type: pt });
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
    const declaredOrder = esOwnKeyOrder(fields.filter((f) => accessorSlotProp(f.name) === null).map((f) => f.name));
    fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { fields, ...(indexValue ? { indexValue } : {}), declaredOrder };
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
    case "record":
    case "array":
      return canConvertToDyn(arm, (id) => ctx.shapes.get(id), (id) => ctx.unions.get(id));
    default:
      return false;
  }
}

/** Arm kinds with no home in a compiled union (mapTypeInner's union rule):
 * no runtime narrowing test exists against sibling data arms. */
function armHasUnionHome(arm: IrType, siblingCount: number): boolean {
  switch (arm.kind) {
    case "void":
    case "union":
    case "generator":
    case "dyn":
      return false;
    case "map":
    case "set":
    case "regex":
    case "date":
    case "promise":
      return siblingCount === 0;
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
    Object.prototype.hasOwnProperty.call(STDLIB_CONTAINERS, psym.name) &&
    checker.declarationsOf(psym).some(
      (d) => ts.isInterfaceDeclaration(d) && ctx.isStdlibFile(d.getSourceFile()),
    )
      ? psym.name
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
      if ((container === "Map" || container === "ReadonlyMap") && i === 0 && !isSupportedMapKey(mapped)) {
        return `the ${container} shape is supported, but keys are limited to numbers and strings — '${text(arg)}' is outside that domain`;
      }
      if ((container === "Map" || container === "ReadonlyMap") && i === 1 && !isSupportedMapValue(mapped)) {
        return `the ${container} shape is supported, but '${text(arg)}' values have no Map slot yet (functions, promises, and nested Maps stay out)`;
      }
      if ((container === "Set" || container === "ReadonlySet") && !isSupportedSetElem(mapped)) {
        return `the ${container} shape is supported, but elements are limited to numbers and strings — '${text(arg)}' is outside that domain`;
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
      if (et?.kind === "void" && isUnitOnlyTsType(arg)) continue;
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
      if (!armHasUnionHome(mapped, dataArms.length - 1)) {
        return `the union shape is supported, but '${text(part)}' arms have no home in a compiled union yet (no runtime narrowing test exists against sibling arms)`;
      }
    }
    return null;
  }

  // Single-signature, non-generic function types: rest parameters, a
  // parameter type, or the return type carries the failure. (Generic and
  // overloaded signatures have their own fences — SC2005/SC2007 — and
  // badType runs those first.)
  const callSigs = checker.getCallSignatures(widened);
  if (callSigs.length === 1) {
    const sig = callSigs[0]!;
    if (sig.getTypeParameters().length > 0) return null;
    const sigDecl = checker.signatureDeclaration(sig);
    if (
      sigDecl !== undefined &&
      ts.isFunctionLike(sigDecl) &&
      (sigDecl.parameters.length !== sig.getParameters().length ||
        bodyReadsArgumentsLocal(sigDecl as { body?: ts.Node }))
    ) {
      return `the function shape is supported, but its signature is variadic ('arguments'-reading), and a compiled signature is fixed-arity`;
    }
    for (const p of sig.getParameters()) {
      const decl = checker.valueDeclarationOf(p);
      if (decl !== undefined && ts.isParameter(decl) && decl.dotDotDotToken !== undefined) {
        return `the function shape is supported, but its rest parameter '${p.name}' has no compiled calling convention yet (a compiled signature is fixed-arity)`;
      }
      const pTs = checker.getTypeOfSymbol(p);
      if (!mapType(pTs, ctx)) {
        return `the function shape is supported, but its parameter '${p.name}' has type '${text(pTs)}', which does not compile`;
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
    if (p.name.startsWith("__@")) continue;
    // Computed shapes over LIBRARY members (`Readonly<Date>`): the record
    // fence there is per-member PROVENANCE (mapRecordTypeInner's rule), not
    // any one member's type — that story stays with the residual fence.
    if (
      computed &&
      checker.declarationsOf(p).some((d) => {
        const sf = d.getSourceFile();
        return sf.isDeclarationFile && !ctx.isExternalTypeFile(sf);
      })
    ) {
      return null;
    }
    const fieldTs = checker.getTypeOfSymbol(p);
    if (isGenericCallableMemberType(fieldTs, checker)) continue;
    let pt = mapType(fieldTs, ctx);
    if (pt?.kind === "void" && isUnitOnlyTsType(fieldTs)) pt = unitOnlyUnion(ctx.unions);
    if (!pt || pt.kind === "void") {
      return `the record shape is supported, but its member '${p.name}' has type '${checker.typeToString(fieldTs)}', which does not compile`;
    }
  }
  return null;
}
