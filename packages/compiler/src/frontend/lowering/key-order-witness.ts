/* Record enumeration order chosen from the orders values are built in.
 *
 * Node enumerates an object's string keys as canonical array indices
 * ascending, then every other key in creation order. A record stores its
 * fields name-sorted and enumerates them through one per-shape table,
 * `IrRecordShape.declaredOrder`, which the type mapper fills with the
 * checker's property order of the first type interned to the shape. That
 * table is exact only while every value of the shape is created in that
 * order. This pass replaces it, after lowering, with the order the
 * program's construction sites actually create, when that order is one
 * order. It changes the table's contents only: storage layout, shape
 * identity and every helper's structure stay as they are, so the generated
 * code differs only in the constant order the enumeration surfaces walk.
 *
 * Witnesses, per shape:
 *  - an object literal contributes the order it writes its keys in. Spread
 *    segments contribute their source shape's order (an inheritance edge,
 *    never the desugar's field list), and a key keeps the position of its
 *    first occurrence, so an override inside a spread stays where the
 *    spread put it. A key whose earlier occurrence may be absent at run
 *    time contributes every position it can take;
 *  - a width copy or a rest binding contributes its source shape's order;
 *  - any other construction (synthesized builtin results, opaque runtime
 *    producers) pins today's table;
 *  - checked conversions from dynamic values (typed JSON.parse, values
 *    from JavaScript) contribute nothing: the record-source table keeps
 *    their own key order relative to the chosen table. A shape only they
 *    build keeps today's table, since another table would make values
 *    parsed in today's order keep a source view; a shape object literals
 *    also build takes the literals' order. A value in another order than
 *    the table's keeps its own key list, and a copy, a spread or a clone
 *    of it hands that list on when it runs (carried orders, below); a copy
 *    that cannot read its source again leaves the order unknown. A
 *    conversion builds only the records it can create from a JavaScript
 *    value: none for a boxed primitive or a class instance (a native
 *    instance whose fields its own writes fill), none for a checked
 *    function's record parameters, and none for the checked result of a
 *    typed call of a method the program may replace on its instance.
 *    Without a replacement
 *    that result is the method's own native value, boxed and checked back
 *    unchanged; a replacement's result keeps its own order in its record
 *    source, and only copies out of it follow the chosen table, as they
 *    followed today's;
 *  - a literal that starts by spreading a value of its own shape copies
 *    that value's order. While no checked conversion builds the shape,
 *    every value has the one chosen order, so the copy adds no witness;
 *  - a literal that starts by spreading a value of a shape checked
 *    conversions build (an ordered spread) gives the record it builds the
 *    value's record source, when the value has one (record.sourceSpread).
 *    Every value of a shape enumerates in its table or in the order its
 *    record source holds, so the copy has the value's order either way,
 *    and the literal resolves as if the value were in its table's order;
 *  - a write to an optional key that may be absent appends it in Node. A
 *    key no construction creates ("late-only") goes after every key a
 *    construction can create; any other moving write goes after every key.
 *    Two late-only keys are ordered only by a straight-line sequence of
 *    writes through one binding.
 *
 * The orders merge into a precedence graph per shape, topologically sorted
 * with ties broken by today's table, so a shape whose witnesses agree with
 * the table keeps it untouched. A cycle means the order depends on the
 * value. Each value then carries its order, in one of two ways:
 *  - an order index (KEY_ORDER_FIELD), when the orders its values take are
 *    a small set known statically (per-instance orders, below);
 *  - its own key list, the kept source checked conversions already use
 *    (record-sources.ts), for every other shape: a construction notes the
 *    order it created its keys in and a write that creates a key moves it
 *    last (trackOrders). The table stays today's, and a value in the
 *    table's order keeps nothing.
 * Every decision made per value rests on one invariant: a record that keeps
 * no source holds exactly its declared keys in its shape's table order (or
 * the order its index names), and every record in another order keeps one.
 * A shape neither covers (a spread of a value with no binding or no checked
 * view to read its keys from) keeps today's table for every value and is
 * reported where the program observes it (KeyOrderNotes.unordered, SC6002).
 * Shapes that no order surface observes keep today's table too. */
import type { IrExpr, IrFunction, IrRecordShape, IrStmt, IrType, SrcLoc } from "../../ir/ir.js";
import { dynUndefinedExpr, strLit } from "../../ir/build.js";
import {
  BOOL,
  DYN,
  F64,
  KEY_ORDER_FIELD,
  shapeHasAccessorSlots,
  typeEquals,
  UNDEFINED_T,
  VOID,
} from "../../ir/ir.js";
import {
  everyExprChild,
  everyStmtChild,
  everyTypeChild,
  transformStmtList,
} from "../../ir/traverse.js";
import type { Lowerer } from "./lowerer.js";
import * as ts from "../ts7/adapter.js";
import { ALWAYS_THROW_LIB_FNS } from "../../ir/builtin-effects.js";
import { replaceChildExpr } from "../../ir/fields.generated.js";
import { InternalCompilerError } from "../../errors.js";
import { recordMayKeepSource, recordSourceTest } from "./record-sources.js";
import { recordHasOwnHelper } from "./lower-calls.js";

/** The statements a key-order helper runs for record `ref`: `walks[0]`,
 * its walk over the shape's table, or, for a shape with orderVariants, a
 * branch per order (walks[i] for order i) on the value's KEY_ORDER_FIELD.
 * `walks` follows shapeKeyOrders. */
export function perKeyOrder(
  shape: IrRecordShape,
  ref: IrExpr,
  walks: readonly IrStmt[][],
  loc: SrcLoc,
): IrStmt[] {
  let tail = walks[0]!;
  for (let i = walks.length - 1; i >= 1; i--) {
    const index: IrExpr = {
      kind: "recordGet",
      obj: ref,
      shapeId: shape.id,
      field: KEY_ORDER_FIELD,
      type: F64,
      loc,
    };
    const cond: IrExpr = {
      kind: "bin",
      op: "===",
      left: index,
      right: { kind: "numLit", value: i, type: F64, loc },
      type: BOOL,
      loc,
    };
    tail = [{ kind: "if", cond, then: walks[i]!, else_: tail, loc }];
  }
  return tail;
}

/** One property of an object literal, in source order. */
export type KeyOrderSegment =
  /** An explicit key (`definite`), or a conditional spread's key, which
   * exists only when its condition holds. */
  | { kind: "key"; name: string; definite: boolean }
  /** `...source` of a record shape; `maybeAbsent` when the whole source
   * can be undefined (`...options` of `T | undefined`). `value` is the
   * binding the literal evaluated the source into, when it has one. */
  | { kind: "spread"; shapeId: string; maybeAbsent: boolean; value?: IrExpr & { kind: "varRef" } }
  /** A spread whose keys are only known at run time; `value` is the
   * binding the literal evaluated the source into, when it has one. */
  | { kind: "opaque"; value?: IrExpr & { kind: "varRef" } };

/** Why a shape's values cannot keep their own key lists: the shape has no
 * checked view to keep one beside (`shape`), a literal spreads a value the
 * pass has no binding or view to read the keys of (`spread`), or a copy
 * reads its fields from a value it cannot name (`copy`). */
export type UntrackedCause = "shape" | "spread" | "copy";

/** How a program creates the keys of an index-signature record with
 * declared fields in an order the record cannot hold: a write that can
 * create a declared key after other keys (`write`), a literal that lists a
 * declared key after a key the type does not declare (`literal`), or an
 * integer-like key, which Node lists before every other key (`index`). */
export type HybridOrderCause = "write" | "literal" | "index";

/** One contributor of a width literal, in source order: a spread source's
 * binding (whose own keys the copy takes when the spread runs), or an
 * explicit key the literal creates at that position. */
export type WidthSegment =
  | { kind: "spread"; value: IrExpr & { kind: "varRef" } }
  | { kind: "key"; name: string };

/** A width literal's contributors and whether its static copy drops source
 * keys the target does not declare. */
export interface WidthNote {
  segments: readonly WidthSegment[];
  drops: boolean;
}

/** Witness notes the lowering attaches to the IR nodes it builds. Keyed by
 * node identity, so nodes a speculative lowering discards are never walked.
 * Literals the IR rewriters rebuild (traverse.ts mapExprChildren) carry
 * their notes over (follow); a node rebuilt any other way falls back to
 * pinning. */
export class KeyOrderNotes {
  private readonly literals = new Map<IrExpr, KeyOrderSegment[]>();
  private readonly copies = new Map<IrExpr, string>();
  private readonly methodResults = new Map<IrExpr, string>();
  /** Literals whose spreads copy source keys the target does not declare
   * (a width spread), with their contributors (keepWidthSpreads), and
   * every spread literal over a shape that can keep a source (same-shape
   * copies, which keep the source's undeclared keys when it has any). */
  private readonly widths = new Map<IrExpr, WidthNote>();
  /** `"k" in r` answers over a closed record whose literal key the shape
   * does not declare, with the receiver the static form evaluated
   * (keepSourceProbes). */
  private readonly sourceProbes = new Map<IrExpr, { receiver: IrExpr; key: string }>();
  /** Same-shape `{ ...r, k: v }` clones (lowerObjectLiteral's recordClone
   * fast path), which copy the source's own keys too (keepRecordClones). */
  private readonly clones = new Set<IrExpr>();
  /** Shapes a frontend order surface (keys, values/entries, inspect,
   * index-signature merges) walks. */
  readonly observed = new Set<string>();
  /** Shapes whose table this pass replaced. */
  readonly changed = new Set<string>();
  /** Width-spread literals this pass kept as a record's source
   * (keepWidthSpreads). A kept copy holds undeclared keys, so the
   * index-signature capture must consult it (lowerer.ts). */
  keptWidthSpreads = 0;
  /** The shapes those kept copies build. A width spread or clone only
   * keeps a source on a shape in here, so the reflective helpers
   * (lower-calls.ts) stay static for every other shape, and the pass reads
   * it back as a spread source that can already hold one. */
  readonly keptSourceShapes = new Set<string>();
  /** Shapes whose values keep their own creation order (trackOrders): no
   * one table and no countable set of orders describes them, so each
   * record notes its order when it is built and when a write creates a
   * key. */
  readonly tracked = new Set<string>();
  /** Per-field copy helpers (`%obj.assign`, `%rec.declmerge`) whose writes
   * create two or more keys of an observed target, which Node creates in
   * the source's key order (lower-calls.ts orderCopiedWrites). */
  readonly orderedAssigns = new Set<string>();
  /** Shapes a checked conversion builds, whose values keep their source's
   * own key order when it is not the table's. */
  readonly converted = new Set<string>();
  /** Observed shapes whose values are created in orders this pass could
   * neither fix nor track: every value keeps today's table, with where one
   * of them is built or written (SC6002, divergences.ts). */
  readonly unordered = new Map<string, { loc: SrcLoc; cause: UntrackedCause }>();
  /** Where the program creates a key of an index-signature record with
   * declared fields out of the order such a record enumerates in (its
   * declared fields, then its other keys), for a type an order surface
   * walks (SC6002, divergences.ts). */
  readonly hybridOrders: { loc: SrcLoc; key: string; cause: HybridOrderCause }[] = [];

  /** The sizes of the notes' tables (unit-journal.ts). */
  journalSizes(): number[] {
    return [
      this.literals.size,
      this.copies.size,
      this.methodResults.size,
      this.widths.size,
      this.sourceProbes.size,
      this.clones.size,
      this.observed.size,
      this.changed.size,
      this.keptSourceShapes.size,
      this.tracked.size,
      this.orderedAssigns.size,
      this.converted.size,
      this.unordered.size,
      this.hybridOrders.length,
    ];
  }

  literal(node: IrExpr, segments: KeyOrderSegment[]): IrExpr {
    this.literals.set(node, segments);
    return node;
  }

  /** A record literal whose spreads copy source keys the target does not
   * declare (`drops`), with its contributors. */
  width(node: IrExpr, segments: WidthSegment[], drops: boolean): IrExpr {
    this.widths.set(node, { segments, drops });
    return node;
  }

  widthOf(node: IrExpr): WidthNote | undefined {
    return this.widths.get(node);
  }

  /** A statically-false `"k" in r` over a closed record, which a kept
   * source can make true. */
  sourceProbe(node: IrExpr, receiver: IrExpr, key: string): IrExpr {
    this.sourceProbes.set(node, { receiver, key });
    return node;
  }

  sourceProbeOf(node: IrExpr): { receiver: IrExpr; key: string } | undefined {
    return this.sourceProbes.get(node);
  }

  /** A same-shape `{ ...r, k: v }` clone, which copies the source's own
   * keys as Node does. */
  clone(node: IrExpr): IrExpr {
    this.clones.add(node);
    return node;
  }

  isClone(node: IrExpr): boolean {
    return this.clones.has(node);
  }

  copy(node: IrExpr, sourceShapeId: string): IrExpr {
    this.copies.set(node, sourceShapeId);
    return node;
  }

  /** The checked result of a typed call of method `name`, which the program
   * may replace on its instance (class-callbacks.ts classCallbackCall). */
  methodResult(node: IrExpr, name: string): IrExpr {
    this.methodResults.set(node, name);
    return node;
  }

  /** A pass rebuilt `from` as `to` (traverse.ts mapExprChildren): the
   * rebuilt node is the same construction, so it keeps the witness. */
  follow(from: IrExpr, to: IrExpr): void {
    const segments = this.literals.get(from);
    if (segments !== undefined) this.literals.set(to, segments);
    const source = this.copies.get(from);
    if (source !== undefined) this.copies.set(to, source);
    const method = this.methodResults.get(from);
    if (method !== undefined) this.methodResults.set(to, method);
    const width = this.widths.get(from);
    if (width !== undefined) this.widths.set(to, width);
    const probe = this.sourceProbes.get(from);
    if (probe !== undefined) this.sourceProbes.set(to, probe);
    if (this.clones.has(from)) this.clones.add(to);
  }

  observe(type: IrType): void {
    if (type.kind === "record") this.observed.add(type.shapeId);
  }

  literalOf(node: IrExpr): KeyOrderSegment[] | undefined {
    return this.literals.get(node);
  }

  copyOf(node: IrExpr): string | undefined {
    return this.copies.get(node);
  }

  /** The method whose checked result `node` is, if it is one. */
  methodResultOf(node: IrExpr): string | undefined {
    return this.methodResults.get(node);
  }
}

const isArrayIndex = (name: string): boolean => {
  const n = Number(name);
  return Number.isInteger(n) && n >= 0 && n < 4294967295 && String(n) === name;
};

interface WriteSite {
  field: string;
  kind: "write" | "delete" | "clone";
  fn: string;
  binding: string | null;
  loop: string;
  pos: number;
  loc: SrcLoc;
}

interface BindingInit {
  count: number;
  fn: string;
  loop: string;
  pos: number;
  fresh: boolean;
}

interface ShapeFacts {
  literals: KeyOrderSegment[][];
  copies: { source: string; keys: Set<string>; node: IrExpr }[];
  /** A construction in today's order (synthesized literal). */
  pinned: boolean;
  /** An opaque runtime producer: today's order, any key may be absent. */
  opaque: boolean;
  /** A checked conversion from a dynamic value. */
  runtime: boolean;
  clones: boolean;
  /** A keyed write (`r[k] = v`) whose key is only known at run time. */
  keyed: boolean;
  present: Set<string>;
  absent: Set<string>;
  deleted: Set<string>;
  writes: WriteSite[];
  /** Where the program first builds a value of the shape itself (a literal,
   * a copy or a clone), if it does. */
  loc: SrcLoc | null;
}

type Resolved = { order: string[] } | "unknown";

/** A literal that starts with `...value`: the sequence that evaluates the
 * value into its binding and then builds the literal, and its function. */
interface LeadingSpread {
  wrapper: IrExpr & { kind: "seqExpr" };
  literal: IrExpr & { kind: "recordLit" };
  fn: IrFunction;
}

/** `structuredClone(v)` checked back into v's own type: the copy is built
 * from v's dyn view, so it creates exactly v's keys in v's order. */
function orderPreservingClone(node: IrExpr & { kind: "dynCheck" }): boolean {
  const value = node.value;
  if (value.kind !== "libCall" || value.fn !== "dyn.structuredClone") return false;
  const source = value.args[0];
  return (
    source !== undefined && source.kind === "dynFrom" && typeEquals(source.value.type, node.type)
  );
}

const PRIMITIVE_KINDS = new Set([
  "f64",
  "bigint",
  "string",
  "bool",
  "undefinedT",
  "nullT",
  "symbol",
]);

/** A checked conversion of a boxed primitive (the `undefined` a dynamic
 * construction passes for a missing argument) answers that primitive or
 * throws: it builds no record. */
function primitiveSource(node: IrExpr & { kind: "dynCheck" }): boolean {
  return node.value.kind === "dynFrom" && PRIMITIVE_KINDS.has(node.value.value.type.kind);
}

/** Whether a census site for a method name can only read the method or
 * install a replacement whose result holds no object: a read
 * (`C.prototype.m`, `obj.m`) outside an assignment target, or an assignment
 * of a function expression whose return type is primitive. Other sites (a
 * computed write of another value, a reflection call, a property bag) may
 * install a replacement that returns a record. */
function replacesWithoutRecords(lowerer: Lowerer, site: ts.Node): boolean {
  const parent = site.parent;
  if (ts.isPropertyAccessExpression(site) || ts.isElementAccessExpression(site))
    return !(
      parent !== undefined &&
      ts.isBinaryExpression(parent) &&
      parent.left === site &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    );
  if (!ts.isBinaryExpression(site) || site.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
    return false;
  let value = site.right;
  while (ts.isParenthesizedExpression(value)) value = value.expression;
  if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) return false;
  const signatures = lowerer.checker.getCallSignatures(lowerer.typeOf(value));
  return (
    signatures.length > 0 &&
    signatures.every((signature) =>
      primitiveOnly(lowerer.checker.getReturnTypeOfSignature(signature)),
    )
  );
}

/** A compiler helper that boxes a class's own state for JavaScript's reads:
 * its prototype data and the property and method dispatch over boxed
 * instances. */
function boxesOwnState(fnName: string): boolean {
  return (
    fnName.startsWith("%prototype.data.") ||
    fnName.startsWith("%dyn.class.") ||
    fnName.startsWith("%class.")
  );
}

/** A type whose values are primitives (or void): it holds no record. */
function primitiveOnly(type: ts.Type): boolean {
  if (type.isUnionType()) return ts.constituentTypes(type).every(primitiveOnly);
  return (
    (type.flags &
      (ts.TypeFlags.StringLike |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.ESSymbolLike |
        ts.TypeFlags.Null |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Void |
        ts.TypeFlags.Never)) !==
    0
  );
}

/** Chooses each in-scope record shape's enumeration table from its
 * witnesses. Runs once retained reachability has settled the historical
 * tables and derived metadata, before the order-snapshotting helper bodies
 * rebuild. */
export function applyKeyOrderWitnesses(lowerer: Lowerer, fns: readonly IrFunction[]): void {
  const notes = lowerer.keyOrder;
  const shapes = lowerer.shapes;
  const facts = new Map<string, ShapeFacts>();
  const factsOf = (shapeId: string): ShapeFacts => {
    let f = facts.get(shapeId);
    if (f === undefined) {
      f = {
        literals: [],
        copies: [],
        pinned: false,
        opaque: false,
        runtime: false,
        clones: false,
        keyed: false,
        present: new Set(),
        absent: new Set(),
        deleted: new Set(),
        writes: [],
        loc: null,
      };
      facts.set(shapeId, f);
    }
    return f;
  };
  const observedRoots: IrType[] = [];
  /** The receivers of keyed reads, which walk no keys in order. */
  const keyedRoots = new Set<IrType>();
  /** The receivers of the key, value and entry walks (Object.keys and
   * for...in, Object.values, Object.entries). */
  const walkRoots: IrType[] = [];
  const walks = (callee: string): boolean =>
    callee.startsWith("%obj.keys.") ||
    callee.startsWith("%obj.values.") ||
    callee.startsWith("%obj.entries.");
  /** Index-signature records with declared fields: where a key is created
   * out of the order such a record enumerates in. */
  const hybridSites: { shapeId: string; loc: SrcLoc; key: string; cause: HybridOrderCause }[] = [];
  /** Index-signature record types a value of which can hold a key its type
   * does not declare, and the calls that hand a record of one such type on
   * as a record of another (rest and conversion helpers). */
  const overflowing = new Set<string>();
  const handedOn: { from: IrType; to: string }[] = [];
  const indexed = (shapeId: string): boolean => {
    const shape = shapes.get(shapeId);
    return shape !== undefined && !shape.tuple && shape.indexValue !== undefined;
  };
  const hybrid = (shapeId: string): boolean => {
    const shape = shapes.get(shapeId);
    return (
      shape !== undefined &&
      !shape.tuple &&
      shape.indexValue !== undefined &&
      shape.fields.some((field) => !field.name.startsWith("%"))
    );
  };
  /** The receivers of the program's own-key presence tests. */
  const presenceRoots: IrType[] = [];
  const inits = new Map<string, BindingInit>();
  const undefinedArmed = (t: IrType): boolean =>
    t.kind === "union" && lowerer.armTag(t.unionId, UNDEFINED_T) >= 0;
  const containsAbsent = (value: IrExpr): boolean =>
    value.kind === "fieldAbsent" ||
    (value.kind === "ternary" && (containsAbsent(value.then) || containsAbsent(value.else_)));

  /** Every record shape a type can hold, through fields, arms, elements,
   * callables, promises and class fields. */
  /** Each walk shares one `seen` set per result set, so every type graph
   * is walked once however many roots reach it.
   *
   * `produced` walks only what a checked conversion into the type can
   * build. It answers an existing native instance for a class type (a plain
   * object cannot acquire a class brand; only %Error rebuilds), so the
   * records the instance's fields hold come from the class's own writes and
   * its checked field setters, each a witness of its own. A checked
   * function's parameters receive native values: a record parameter is
   * passed out, never built, though a callback among them receives values
   * built from JavaScript again. `built` false starts the walk at a value
   * passed out (a native value boxed for JavaScript); `writes` false leaves
   * out what JavaScript could write into the containers passed out, so the
   * walk counts only what the functions among them receive. */
  const shapesIn = (
    type: IrType,
    out: Set<string>,
    seen: Set<string>,
    produced = false,
    built = true,
    writes = true,
  ): void => {
    const visit = (t: IrType, built: boolean): boolean => {
      const mark = built ? "" : "-";
      // A container JavaScript builds converts into fresh native storage, so
      // its children are built too. One passed out stays shared: JavaScript
      // writes into it (built children) and reads native values out of it,
      // such as callbacks whose parameters it then builds (children passed
      // out). Those children count in both directions.
      const child = (type: IrType): boolean => {
        if (built || writes) visit(type, true);
        if (!built) visit(type, false);
        return true;
      };
      if (t.kind === "record") {
        if (seen.has(mark + "r:" + t.shapeId)) return true;
        seen.add(mark + "r:" + t.shapeId);
        if (built) out.add(t.shapeId);
        const shape = shapes.get(t.shapeId);
        if (shape) {
          for (const f of shape.fields) child(f.type);
          if (shape.indexValue) child(shape.indexValue);
        }
        return true;
      }
      if (t.kind === "union") {
        if (seen.has(mark + "u:" + t.unionId)) return true;
        seen.add(mark + "u:" + t.unionId);
        for (const arm of lowerer.unions.get(t.unionId)?.arms ?? []) visit(arm, built);
        return true;
      }
      if (t.kind === "object") {
        if (produced && t.className !== "%Error") return true;
        if (seen.has(mark + "c:" + t.className)) return true;
        seen.add(mark + "c:" + t.className);
        for (const f of lowerer.classes.get(t.className)?.def.fields ?? []) child(f.type);
        return true;
      }
      if (produced && t.kind === "func") {
        for (const param of t.params) visit(param, !built);
        return visit(t.ret, built);
      }
      return everyTypeChild(t, child);
    };
    visit(type, built);
  };
  const opaqueShapes = new Set<string>();
  const opaqueSeen = new Set<string>();
  const runtimeShapes = new Set<string>();
  const runtimeSeen = new Set<string>();
  /** Shapes the declaration-typed boundary converts into (adopting casts):
   * their values come from package code that builds them in the
   * declaration's order, the order their table holds. */
  const declaredShapes = new Set<string>();
  const declaredSeen = new Set<string>();
  const boxedSeen = new Set<string>();
  /** The checked result of a replaceable method call while every site that
   * can replace the method installs functions that return no record. */
  const unchangedMethodResult = (node: IrExpr): boolean => {
    const name = notes.methodResultOf(node);
    if (name === undefined) return false;
    const sites = lowerer.methodAccessSites.get(name) ?? [];
    return sites.every((site) => replacesWithoutRecords(lowerer, site));
  };
  const producedBy = (type: IrType, opaque: boolean): void => {
    if (opaque) shapesIn(type, opaqueShapes, opaqueSeen);
    else shapesIn(type, runtimeShapes, runtimeSeen, true);
  };
  /** The shapes a checked conversion in this program builds, which are the
   * only values that already hold a source when this pass runs (the ones
   * this pass keeps join keptSourceShapes as it decides). Collected by the
   * walk below, which already meets every conversion. */
  const convertedShapes = new Set<string>();
  const convertedSeen = new Set<string>();

  // ── collection ──────────────────────────────────────────────────────
  let pos = 0;
  let fnName = "";
  let currentFn: IrFunction | null = null;
  /** Literals that start by spreading a binding, by their witness: where
   * each one is built. A literal's notes are shared by its rebuilt copies,
   * so `literalSites` counts every literal of each witness. */
  const leadingSpreads = new Map<KeyOrderSegment[], LeadingSpread[]>();
  /** Width literals (KeyOrderNotes.width), where each is built. */
  const widthSites: (LeadingSpread & { note: WidthNote })[] = [];
  /** `"k" in r` sites a kept source can answer true (keepSourceProbes). */
  const probeSites: { node: IrExpr; fn: IrFunction }[] = [];
  /** Same-shape `{ ...r, k: v }` clones that copy the source's own keys
   * (keepRecordClones). */
  const cloneSites: { node: IrExpr; fn: IrFunction }[] = [];
  const literalSites = new Map<KeyOrderSegment[], number>();
  /** Literals that spread a value, by their witness: where each one is
   * built, when its sequence evaluates the spread values into bindings. */
  const spreadSites = new Map<KeyOrderSegment[], LeadingSpread[]>();
  /** Per-field copies into an existing record (lower-calls.ts
   * orderCopiedWrites): Object.assign's, and a spread into a record a
   * literal builds source by source. The helper, its target shape and its
   * source shape. */
  const assignCalls = new Map<string, { target: string; source: string }>();
  const loops: number[] = [];
  let loopIds = 0;
  const loopKey = (): string => loops.join("/");
  /** Bindings initialized by another binding's reference (`const view =
   * value`, the snapshot a union-receiver write takes), so writes through
   * either count as writes through the one object. */
  const aliases = new Map<string, { target: string; fn: string }>();
  const bindingOf = (obj: IrExpr): string | null => {
    let o = obj;
    while (o.kind === "unionNarrow" || o.kind === "downcast") o = o.value;
    if (o.kind !== "varRef") return null;
    let id = o.localId;
    const seen = new Set<string>();
    for (;;) {
      const alias = aliases.get(id);
      if (!alias || alias.fn !== fnName || inits.get(id)?.count !== 1 || seen.has(id)) return id;
      seen.add(id);
      id = alias.target;
    }
  };
  const noteInit = (id: string, init: IrExpr): void => {
    const previous = inits.get(id);
    if (previous !== undefined) {
      previous.count++;
      return;
    }
    if (init.kind === "varRef") aliases.set(id, { target: init.localId, fn: fnName });
    const fresh =
      init.kind === "recordLit" ||
      init.kind === "recordClone" ||
      (init.kind === "seqExpr" && init.result.kind === "recordLit");
    inits.set(id, { count: 1, fn: fnName, loop: loopKey(), pos, fresh });
  };
  const visitExpr = (e: IrExpr): void => {
    const probe = notes.sourceProbeOf(e);
    if (probe !== undefined && currentFn !== null) {
      probeSites.push({ node: e, fn: currentFn });
      presenceRoots.push(probe.receiver.type);
    }
    if (e.kind === "call" && e.callee.startsWith("%obj.hasOwn") && e.args[0] !== undefined)
      presenceRoots.push(e.args[0].type);
    if (e.kind === "call" && walks(e.callee) && e.args[0] !== undefined)
      walkRoots.push(e.args[0].type);
    if (e.kind === "call" && e.type.kind === "record" && indexed(e.type.shapeId))
      for (const arg of e.args) handedOn.push({ from: arg.type, to: e.type.shapeId });
    if (
      e.kind === "call" &&
      (e.callee.startsWith("%obj.assign.") || e.callee.startsWith("%rec.declmerge."))
    ) {
      const target = e.args[0]?.type;
      const source = e.args[1]?.type;
      if (target?.kind === "record" && source?.kind === "record")
        assignCalls.set(e.callee, { target: target.shapeId, source: source.shapeId });
    }
    switch (e.kind) {
      case "recordLit": {
        if (e.type.kind !== "record") return;
        if (indexed(e.type.shapeId) && notes.literalOf(e)?.some((s) => s.kind !== "key"))
          overflowing.add(e.type.shapeId);
        if (hybrid(e.type.shapeId)) {
          let undeclared = false;
          for (const field of e.fields) {
            if (field.overflow) {
              overflowing.add(e.type.shapeId);
              if (isArrayIndex(field.name))
                hybridSites.push({
                  shapeId: e.type.shapeId,
                  loc: e.loc,
                  key: field.name,
                  cause: "index",
                });
              undeclared = true;
            } else if (
              undeclared &&
              field.value.kind !== "fieldAbsent" &&
              !field.name.startsWith("%")
            ) {
              hybridSites.push({
                shapeId: e.type.shapeId,
                loc: e.loc,
                key: field.name,
                cause: "literal",
              });
              break;
            }
          }
        }
        const f = factsOf(e.type.shapeId);
        const presentKeys = new Set<string>();
        for (const field of e.fields) {
          if (field.overflow) continue;
          if (field.value.kind === "fieldAbsent") {
            f.absent.add(field.name);
            continue;
          }
          presentKeys.add(field.name);
          f.present.add(field.name);
          if (containsAbsent(field.value)) f.absent.add(field.name);
        }
        const segments = notes.literalOf(e);
        const copy = notes.copyOf(e);
        if (segments !== undefined) {
          f.literals.push(segments);
          literalSites.set(segments, (literalSites.get(segments) ?? 0) + 1);
        } else if (copy !== undefined) f.copies.push({ source: copy, keys: presentKeys, node: e });
        else f.pinned = true;
        if (segments !== undefined || copy !== undefined) f.loc ??= e.loc;
        return;
      }
      case "recordClone": {
        if (e.type.kind !== "record") return;
        if (notes.isClone(e) && currentFn !== null) cloneSites.push({ node: e, fn: currentFn });
        const f = factsOf(e.type.shapeId);
        f.clones = true;
        f.loc ??= e.loc;
        for (const o of e.overrides)
          f.writes.push({
            field: o.name,
            kind: "clone",
            fn: fnName,
            binding: null,
            loop: "",
            pos,
            loc: e.loc,
          });
        return;
      }
      case "assignExpr":
        noteInit(e.localId, e.value);
        return;
      case "seqExpr": {
        // A spread literal evaluates its sources into bindings first.
        const literal = e.result;
        if (literal.kind !== "recordLit" || currentFn === null) return;
        const width = notes.widthOf(literal);
        if (width !== undefined)
          widthSites.push({ wrapper: e, literal, fn: currentFn, note: width });
        const segments = notes.literalOf(literal);
        if (segments !== undefined && segments.some((s) => s.kind !== "key")) {
          const sites = spreadSites.get(segments) ?? [];
          sites.push({ wrapper: e, literal, fn: currentFn });
          spreadSites.set(segments, sites);
        }
        const first = segments?.[0];
        if (segments === undefined || first?.kind !== "spread" || first.value === undefined) return;
        const list = leadingSpreads.get(segments) ?? [];
        list.push({ wrapper: e, literal, fn: currentFn });
        leadingSpreads.set(segments, list);
        return;
      }
      case "jsonStringify":
      case "dynFrom":
        observedRoots.push(e.value.type);
        // A native value the program hands to JavaScript: the callbacks it
        // holds (itself, a field, an element) receive records JavaScript
        // builds. The helpers that box the program's own state for
        // JavaScript's reads (a class's prototype slots and property
        // dispatch) hand out the class's methods, whose arguments the
        // program's own calls pass as native values, as a replaceable
        // method's result above. Writes through the boxed value are left
        // out: reading a boxed value creates no record.
        if (!boxesOwnState(fnName))
          shapesIn(e.value.type, runtimeShapes, boxedSeen, true, false, false);
        return;
      case "recordKeyGet":
        observedRoots.push(e.obj.type);
        keyedRoots.add(e.obj.type);
        return;
      case "libCall":
        // Runtime surfaces (console, util.format, workers) that take a
        // record may walk its keys; runtime builders make new records.
        for (const arg of e.args) observedRoots.push(arg.type);
        // An always-throwing call stands in for a value (`error.nodeThrow`
        // in a narrowing ternary) and never produces one. Other calls
        // whose signature result is VOID are typed by their use site and
        // build the record at run time (`server.address()`).
        if (!ALWAYS_THROW_LIB_FNS.has(e.fn)) producedBy(e.type, true);
        return;
      case "intrinsic":
        // Intrinsics hand back values built elsewhere, except allSettled's
        // result records; console output renders through the inspect
        // helpers, which note their shapes.
        if (e.name === "promise.allSettled") producedBy(e.type, true);
        return;
      case "ffiCall":
      case "strIntrinsic":
      case "regexIntrinsic":
      case "bytesIntrinsic":
      // Promise.withResolvers records are built by the backend in a fixed
      // layout.
      case "promiseWithResolvers":
        producedBy(e.type, true);
        return;
      case "genResume": {
        // A resume builds at most its IteratorResult record ({ done, value }
        // in a fixed layout; an async generator's settles a promise of it).
        // The value it carries is the generator's own yielded or returned
        // value, which the generator's body constructs. The record-free
        // drives build nothing: `value` moves that value out, and step,
        // close and a record-free delegate answer a boolean or nothing.
        if (e.mode === "step" || e.mode === "value" || e.mode === "close") return;
        const result = e.type.kind === "promise" ? e.type.inner : e.type;
        if (result.kind === "record") opaqueShapes.add(result.shapeId);
        return;
      }
      case "dynCheck":
        conversionShapes(lowerer, e.type, convertedShapes, convertedSeen);
        if (e.adopt === true) shapesIn(e.type, declaredShapes, declaredSeen);
        // Conversions that build no record: a boxed primitive, and a
        // replaceable method's result while no replacement the program can
        // install returns a record: then it is the method's own value,
        // boxed and checked back unchanged.
        else if (!orderPreservingClone(e) && !primitiveSource(e) && !unchangedMethodResult(e))
          producedBy(e.type, false);
        return;
      case "dynDestrCheck":
      case "caughtCheck":
      case "caughtNarrow":
        producedBy(e.type, false);
        return;
      default:
        return;
    }
  };
  const visitStmt = (st: IrStmt): void => {
    switch (st.kind) {
      case "recordKeySet":
        if (
          st.key.kind === "strLit" &&
          isArrayIndex(st.key.value) &&
          st.overflowOnly === true &&
          hybrid(st.shapeId)
        )
          hybridSites.push({ shapeId: st.shapeId, loc: st.loc, key: st.key.value, cause: "index" });
        // A key that is no declared field, or a run-time name that may be
        // none. The record copy helpers write the keys their source holds,
        // which their calls hand on (below).
        if (
          indexed(st.shapeId) &&
          (st.overflowOnly === true || st.key.kind !== "strLit") &&
          !fnName.startsWith("%rec.")
        )
          overflowing.add(st.shapeId);
        {
          // A keyed write of a closed record creates the key it names when
          // the record lacks it: any key, when the name is a run-time value.
          const shape = shapes.get(st.shapeId);
          if (shape === undefined || shape.tuple || shape.indexValue !== undefined) return;
          const named = st.key.kind === "strLit" ? st.key.value : null;
          for (const field of shape.fields) {
            if (field.name.startsWith("%") || (named !== null && field.name !== named)) continue;
            // A key every value has is written in place.
            const present = lowerer.recordFieldPresent(st.obj, st.shapeId, field.name, st.loc);
            if (present.kind === "boolLit") continue;
            const f = factsOf(st.shapeId);
            if (named === null) f.keyed = true;
            f.writes.push({
              field: field.name,
              kind: "write",
              fn: fnName,
              binding: named === null ? null : bindingOf(st.obj),
              loop: loopKey(),
              pos,
              loc: st.loc,
            });
          }
        }
        return;
      case "recordSet":
        if (
          st.value.kind !== "fieldAbsent" &&
          hybrid(st.shapeId) &&
          lowerer.recordFieldPresent(st.obj, st.shapeId, st.field, st.loc).kind !== "boolLit"
        )
          hybridSites.push({ shapeId: st.shapeId, loc: st.loc, key: st.field, cause: "write" });
        if (st.value.kind === "fieldAbsent") factsOf(st.shapeId).deleted.add(st.field);
        factsOf(st.shapeId).writes.push({
          field: st.field,
          kind: st.value.kind === "fieldAbsent" ? "delete" : "write",
          fn: fnName,
          binding: bindingOf(st.obj),
          loop: loopKey(),
          pos,
          loc: st.loc,
        });
        return;
      case "varDecl":
        if (st.init !== null) noteInit(st.localId, st.init);
        return;
      case "assign":
        noteInit(st.localId, st.value);
        return;
      default:
        return;
    }
  };
  const expr = (e: IrExpr): boolean => {
    pos++;
    visitExpr(e);
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (st: IrStmt): boolean => {
    pos++;
    visitStmt(st);
    if (st.kind === "while" || st.kind === "doWhile" || st.kind === "for" || st.kind === "forOf") {
      loops.push(++loopIds);
      everyStmtChild(st, expr, stmt);
      loops.pop();
      return true;
    }
    return everyStmtChild(st, expr, stmt);
  };
  for (const fn of fns) {
    fnName = fn.name;
    currentFn = fn;
    for (const st of fn.body) stmt(st);
  }
  for (const id of convertedShapes) notes.converted.add(id);
  // An index-signature record with declared fields lists the declared ones
  // first, whatever order its keys were created in. Where the program can
  // create them in another order and walks the type's keys, the difference
  // from Node shows: reported, since no table or key list holds that order.
  if (hybridSites.length > 0) {
    const walked = new Set<string>();
    const walkedSeen = new Set<string>();
    for (const id of notes.observed) shapesIn({ kind: "record", shapeId: id }, walked, walkedSeen);
    for (const root of observedRoots) if (!keyedRoots.has(root)) shapesIn(root, walked, walkedSeen);
    for (const root of walkRoots) shapesIn(root, walked, walkedSeen);
    // A declared key written late shows only on a record that holds another
    // key: one a literal or a keyed write of the type creates, one a value
    // built outside the program's literals brings (a checked conversion, a
    // runtime producer), or one a record handed on from such a type brings.
    for (const id of runtimeShapes) if (indexed(id)) overflowing.add(id);
    for (const id of opaqueShapes) if (indexed(id)) overflowing.add(id);
    // The record a call hands on is its argument itself, or the record arm
    // of a union argument.
    const handed = (type: IrType): string[] => {
      if (type.kind === "record") return [type.shapeId];
      if (type.kind !== "union") return [];
      const arms: string[] = [];
      for (const arm of lowerer.unions.get(type.unionId)?.arms ?? [])
        if (arm.kind === "record") arms.push(arm.shapeId);
      return arms;
    };
    for (let grew = true; grew;) {
      grew = false;
      for (const { from, to } of handedOn) {
        if (overflowing.has(to)) continue;
        for (const id of handed(from)) {
          // A dictionary holds nothing but keys its type does not declare.
          if (!indexed(id) || !(overflowing.has(id) || shapes.get(id)!.fields.length === 0))
            continue;
          overflowing.add(to);
          grew = true;
          break;
        }
      }
    }
    for (const { shapeId, loc, key, cause } of hybridSites)
      if (walked.has(shapeId) && (cause === "index" || overflowing.has(shapeId)))
        notes.hybridOrders.push({ loc, key, cause });
  }
  for (const id of opaqueShapes) {
    const f = factsOf(id);
    f.pinned = true;
    f.opaque = true;
  }
  for (const id of runtimeShapes) factsOf(id).runtime = true;
  for (const id of declaredShapes) if (!runtimeShapes.has(id)) factsOf(id).pinned = true;

  // ── width spreads ───────────────────────────────────────────────────
  // A width spread keeps the copy's own keys when an order surface can
  // observe its target (keepWidthSpreads). The observation is the one the
  // tables use below, before ordered spreads join it. A source can be
  // another width spread's target, so this runs until no site joins.
  const keptWidths = new Set<IrExpr>();
  const keptClones = new Set<IrExpr>();
  /** The statements each kept site's literal evaluates in (the wrapper's
   * prologue), which the per-instance order plan reads a spread's source
   * binding from after keepWidthSpreads moved the literal into a
   * declaration of its own. */
  const keptLiteralStmts = new Map<IrExpr, readonly IrStmt[]>();
  /** Shapes a kept dropping copy builds: the copy holds keys the shape has
   * no slot for, so its order is its kept source's, and the shape keeps
   * today's table (as a literal with a dropped field does without the
   * kept source). */
  const keptDropShapes = new Set<string>();
  {
    const early = new Set<string>();
    const earlySeen = new Set<string>();
    for (const id of notes.observed) shapesIn({ kind: "record", shapeId: id }, early, earlySeen);
    for (const root of observedRoots) shapesIn(root, early, earlySeen);
    // A presence test (`"k" in r`, Object.hasOwn) observes a record's own
    // keys as an order surface does.
    for (const root of presenceRoots) shapesIn(root, early, earlySeen);
    // An observed copy shows the own keys of each record it spreads, so a
    // spread source is observed through it, transitively.
    for (let grew = true; grew;) {
      grew = false;
      for (const { literal, note } of widthSites) {
        if (literal.type.kind !== "record" || !early.has(literal.type.shapeId)) continue;
        for (const segment of note.segments) {
          if (segment.kind !== "spread") continue;
          const before = early.size;
          shapesIn(segment.value.type, early, earlySeen);
          if (early.size !== before) grew = true;
        }
      }
      // A copy narrowed from a record links to it (record-links.ts) and
      // shows the record's own keys, so the record is observed through it.
      for (const link of lowerer.recordLinks.values()) {
        if (!early.has(link.to)) continue;
        const before = early.size;
        shapesIn({ kind: "record", shapeId: link.from }, early, earlySeen);
        if (early.size !== before) grew = true;
      }
    }
    for (let grew = true; grew;) {
      grew = false;
      for (const { wrapper, literal, note } of widthSites) {
        if (!note.drops || keptWidths.has(wrapper) || literal.type.kind !== "record") continue;
        if (!early.has(literal.type.shapeId) || !widthKeepable(lowerer, wrapper, note.segments))
          continue;
        keptWidths.add(wrapper);
        notes.keptSourceShapes.add(literal.type.shapeId);
        grew = true;
        for (const segment of note.segments)
          if (segment.kind === "spread") shapesIn(segment.value.type, early, earlySeen);
      }
    }
    // A same-shape copy (`{ ...r }`, `{ ...r, ...s }`) of a record that
    // kept undeclared keys copies them too. A copy keeps its source's own
    // keys, so a source can itself be such a copy; admit a non-dropping
    // site only when a spread source of it can actually hold a source (a
    // shape a checked conversion builds or an earlier kept copy's), so a
    // program — or a copy of a shape no conversion ever produces — stays
    // byte-identical.
    if (lowerer.recordSourcesPossible || keptWidths.size > 0) {
      for (let grew = true; grew;) {
        grew = false;
        for (const { wrapper, literal, note } of widthSites) {
          if (note.drops || keptWidths.has(wrapper) || literal.type.kind !== "record") continue;
          if (!early.has(literal.type.shapeId) || !widthKeepable(lowerer, wrapper, note.segments))
            continue;
          if (
            !note.segments.some(
              (segment) =>
                segment.kind === "spread" &&
                reachesKeptSource(lowerer, segment.value.type, convertedShapes),
            )
          )
            continue;
          keptWidths.add(wrapper);
          notes.keptSourceShapes.add(literal.type.shapeId);
          grew = true;
          for (const segment of note.segments)
            if (segment.kind === "spread") shapesIn(segment.value.type, early, earlySeen);
        }
      }
    }
    for (const { wrapper, literal, note } of widthSites) {
      if (!keptWidths.has(wrapper) || literal.type.kind !== "record") continue;
      const shapeId = literal.type.shapeId;
      notes.keptSourceShapes.add(shapeId);
      if (!note.drops) {
        // A same-shape copy keeps its own order (a spread of the literal's
        // own shape reads its source's index): its witness stays, and the
        // plan finds the source binding through the wrapper's prologue.
        keptLiteralStmts.set(literal, wrapper.stmts);
        continue;
      }
      // A kept copy that drops keys enumerates through its own kept source,
      // so like a checked conversion it contributes no order to its shape's
      // table, and the shape keeps today's table.
      const segments = notes.literalOf(literal);
      const literals = facts.get(shapeId)?.literals;
      const at = segments === undefined || literals === undefined ? -1 : literals.indexOf(segments);
      if (at >= 0) literals!.splice(at, 1);
      keptDropShapes.add(shapeId);
    }
    // Same-shape clones of a record that can keep keys copy them too, when
    // the program converts checked values or keeps a width spread and the
    // shape is observed. The source, not the clone, decides: a clone of a
    // shape no conversion produces finds no keys to keep.
    if (lowerer.recordSourcesPossible || keptWidths.size > 0) {
      for (const { node } of cloneSites) {
        if (node.kind !== "recordClone") continue;
        const cloneT = node.type;
        if (cloneT.kind !== "record" || !early.has(cloneT.shapeId)) continue;
        if (!recordMayKeepSource(lowerer, cloneT)) continue;
        if (!reachesKeptSource(lowerer, node.source.type, convertedShapes)) continue;
        keptClones.add(node);
        notes.keptSourceShapes.add(cloneT.shapeId);
      }
    }
  }
  // A program that keeps no width spread is byte-identical to main: the
  // reflective surfaces below (and the two helper finalizers in
  // lower-calls.ts, which consult keptSourceShapes) stay static there, as
  // they did before this pass.
  keepSourceProbes(lowerer, notes, probeSites, keptWidths.size > 0 || keptClones.size > 0);
  /** The records the kept sites build, which already note their own keys
   * (trackOrders leaves them as they are). */
  const noted = new Set<IrExpr>();
  keepRecordClones(lowerer, cloneSites, keptClones, 0, noted);
  for (const { wrapper, literal } of widthSites) if (keptWidths.has(wrapper)) noted.add(literal);

  // ── scope ───────────────────────────────────────────────────────────
  // Only plain declared-field shapes with a table take part.
  const inScope = (shape: IrRecordShape | undefined): shape is IrRecordShape =>
    shape !== undefined &&
    !shape.tuple &&
    shape.indexValue === undefined &&
    shape.declaredOrder !== undefined &&
    !shapeHasAccessorSlots(shape);
  const tableOf = (shape: IrRecordShape): string[] =>
    shape.declaredOrder!.filter((k) => !k.startsWith("%") && !isArrayIndex(k));
  // A checked conversion builds values in their source's own order, which
  // the record-source table reproduces relative to the shape's table. A new
  // table would make every value parsed in today's order keep a source
  // view, so a shape only checked conversions build keeps today's table.
  // A shape the program also builds with object literals takes their order:
  // the literal's values have no other way to enumerate in it, and values
  // parsed from JSON those literals wrote (a message sent to a child or
  // another service of the program) arrive in it too. Parsed values in any
  // other order keep a source view, exactly as before.
  for (const f of facts.values()) if (f.runtime && f.literals.length === 0) f.pinned = true;

  // Nothing to choose: every witness agrees with today's table and no
  // optional key is written late.
  const interesting = [...facts].some(([id, f]) => {
    const shape = shapes.get(id);
    if (!inScope(shape)) return false;
    if (f.writes.some((w) => w.kind !== "delete") || f.copies.length > 0) return true;
    const table = tableOf(shape).join("\0");
    return f.literals.some((segments) => {
      const keys: string[] = [];
      for (const segment of segments) {
        if (segment.kind !== "key") return true;
        if (!isArrayIndex(segment.name)) keys.push(segment.name);
      }
      return keys.join("\0") !== table;
    });
  });
  if (!interesting) {
    keepWidthSpreads(notes, widthSites, keptWidths, new Set());
    return;
  }

  // ── presence classes and late-write constraints ─────────────────────
  const maybeAbsent = (id: string, key: string): boolean => {
    const shape = shapes.get(id);
    const field = shape?.fields.find((x) => x.name === key);
    if (!field || !undefinedArmed(field.type)) return false;
    const f = facts.get(id);
    if (f === undefined) return true;
    return f.absent.has(key) || f.runtime || f.opaque || f.deleted.has(key);
  };
  /** Edges every value of the shape satisfies whatever its sources'
   * orders are, or "unknown" when late writes make the order depend on
   * the value. */
  const lateEdges = (id: string, keys: readonly string[]): [string, string][] | "unknown" => {
    const f = facts.get(id);
    if (f === undefined) return [];
    const edges: [string, string][] = [];
    const keySet = new Set(keys);
    const createdKeys = (k: string): boolean => f.present.has(k) || f.runtime || f.opaque;
    const required = keys.filter((k) => !maybeAbsent(id, k));
    const created = keys.filter((k) => maybeAbsent(id, k) && createdKeys(k));
    const lateOnly = new Set(keys.filter((k) => maybeAbsent(id, k) && !createdKeys(k)));
    // The constraint depends on the written key only, not on the site.
    const moving = new Set<string>();
    for (const w of f.writes)
      if (w.kind !== "delete" && keySet.has(w.field) && maybeAbsent(id, w.field))
        moving.add(w.field);
    for (const field of moving) {
      const before = lateOnly.has(field) ? [...required, ...created] : keys;
      for (const k of before) if (k !== field) edges.push([k, field]);
    }
    const lateSites = f.writes.filter((w) => lateOnly.has(w.field));
    const lateWritten = new Set(lateSites.filter((w) => w.kind !== "delete").map((w) => w.field));
    if (lateWritten.size < 2) return edges;
    // Two or more late-only keys: each value gains them in the order its
    // writes run, so every write must belong to one straight-line
    // sequence through one binding initialized once, in the same function
    // and loop body as its writes.
    const groups = new Map<string, WriteSite[]>();
    for (const w of lateSites) {
      if (w.kind === "clone" || w.binding === null) return "unknown";
      const init = inits.get(w.binding);
      if (
        init === undefined ||
        init.count !== 1 ||
        init.fn !== w.fn ||
        init.loop !== w.loop ||
        init.pos > w.pos
      )
        return "unknown";
      const group = groups.get(w.binding) ?? [];
      group.push(w);
      groups.set(w.binding, group);
    }
    if (groups.size > 1 && [...groups.keys()].some((b) => !inits.get(b)!.fresh)) return "unknown";
    for (const group of groups.values()) {
      const seen = new Set<string>();
      for (const w of group) {
        if (seen.has(w.field)) return "unknown";
        seen.add(w.field);
      }
      const writes = group.filter((w) => w.kind === "write").sort((a, b) => a.pos - b.pos);
      for (let i = 0; i + 1 < writes.length; i++)
        edges.push([writes[i]!.field, writes[i + 1]!.field]);
    }
    return edges;
  };

  // ── ordered spreads ─────────────────────────────────────────────────
  // A value a checked conversion builds keeps its source's key order in
  // its record source when that order is not the table's (record-
  // sources.ts), so every value of a shape enumerates in the table's order
  // or in the order its record source holds. A literal that starts with
  // `...value` creates the value's keys first, in the value's order. When
  // the value's shape is one checked conversions build, the literal
  // carries that order over: after it builds the record it gives the
  // record a source holding the value's order (record.sourceSpread), and
  // the keys the value lacks follow in the table's order, which every
  // literal sequence of the shape agrees with. Such a literal resolves as
  // if its source were in the source's table order, and its own shape
  // counts as built at run time too, since its values may now carry a
  // source. It qualifies when every value of the source has all of the
  // source's keys, both shapes can keep a source, and every later spread
  // whose values may carry a source only overwrites the source's keys
  // (its own order cannot move them).
  const orderedSpreads = new Set<readonly KeyOrderSegment[]>();
  const keepers = new Map<string, boolean>();
  const keepsSource = (shapeId: string): boolean => {
    let keeps = keepers.get(shapeId);
    if (keeps === undefined) {
      keeps = recordMayKeepSource(lowerer, { kind: "record", shapeId });
      keepers.set(shapeId, keeps);
    }
    return keeps;
  };
  const userKeys = (shapeId: string): string[] =>
    (shapes.get(shapeId)?.fields ?? []).map((x) => x.name).filter((k) => !k.startsWith("%"));
  const ordersSpread = (segments: KeyOrderSegment[], sites: readonly LeadingSpread[]): boolean => {
    const first = segments[0];
    if (first?.kind !== "spread" || first.maybeAbsent || first.value === undefined) return false;
    const sourceId = first.shapeId;
    if (facts.get(sourceId)?.runtime !== true || sites.length !== literalSites.get(segments))
      return false;
    const target = sites[0]!.literal.type;
    if (target.kind !== "record" || !keepsSource(sourceId) || !keepsSource(target.shapeId))
      return false;
    const localId = first.value.localId;
    const bound = ({ wrapper, literal }: LeadingSpread): boolean =>
      typeEquals(literal.type, target) &&
      wrapper.stmts.some(
        (st) =>
          st.kind === "varDecl" &&
          st.localId === localId &&
          st.init !== null &&
          st.init.type.kind === "record" &&
          st.init.type.shapeId === sourceId,
      );
    if (!sites.every(bound)) return false;
    const sourceKeys = new Set(userKeys(sourceId));
    if ([...sourceKeys].some((k) => maybeAbsent(sourceId, k))) return false;
    return segments
      .slice(1)
      .every(
        (s) =>
          s.kind === "key" ||
          (s.kind === "spread" &&
            (facts.get(s.shapeId)?.runtime !== true ||
              userKeys(s.shapeId).every((k) => sourceKeys.has(k)))),
      );
  };
  // ── carried orders ──────────────────────────────────────────────────
  // The invariant the per-value decisions rest on: a record that keeps no
  // source holds exactly its declared keys in its shape's table order (or
  // the order its index names); every record in another order keeps one.
  // So a construction that derives a record from another one (a copy of
  // its fields, a spread of it, a clone) has two cases, told apart when it
  // runs. A source that keeps none is in its table's order, which is a
  // static witness like a literal's. A source that keeps one hands its key
  // list on (trackOrders: record.orderCarry for a copy, a snapshot under
  // record.sourceHas for a spread, keepRecordClones for a clone), and the
  // record built keeps a source of its own. A shape derived that way from
  // a shape checked conversions build therefore still has one table; only
  // a derivation that cannot read its source again leaves the order
  // unknown.
  /** Shapes with a derivation that hands a source's kept key list on:
   * their values can keep a source too. */
  const derived = new Set<string>();
  /** Record types whose values can be copies linked to their sources. */
  const linked = linkTargets(lowerer);
  const viewable = (type: IrType): boolean => type.kind === "dyn" || lowerer.dynConvertible(type);
  /** Whether a copy into shape `id` hands its source's order on: it has
   * none to keep (one key, or a link that answers from the source record),
   * or it reads its fields from a value it can name again. */
  const copyCarriers = new Map<ShapeFacts["copies"][number], boolean>();
  const copyCarries = (id: string, c: ShapeFacts["copies"][number]): boolean => {
    const known = copyCarriers.get(c);
    if (known !== undefined) return known;
    let carries = false;
    if (keepsSource(id)) {
      if (c.keys.size < 2 || lowerer.recordLinks.has(`${c.source}:${id}`)) carries = true;
      else {
        const binding = copyBinding(c.node, c.source);
        // A linked source's keys are read through its checked view.
        carries = binding !== null && (!linked.has(c.source) || viewable(binding.type));
      }
    }
    copyCarriers.set(c, carries);
    return carries;
  };
  const spreadCarriers = new Map<readonly KeyOrderSegment[], boolean>();
  /** Whether every site of a literal of shape `id` can read each value it
   * spreads when the spread runs: the site already keeps its own keys (a
   * kept width spread), or its sequence declares the value's binding and
   * the value has a checked view. */
  const spreadsCarry = (id: string, segments: readonly KeyOrderSegment[]): boolean => {
    const known = spreadCarriers.get(segments);
    if (known !== undefined) return known;
    const sites = spreadSites.get(segments as KeyOrderSegment[]) ?? [];
    const carries =
      keepsSource(id) &&
      sites.length > 0 &&
      sites.length === literalSites.get(segments as KeyOrderSegment[]) &&
      segments.every((s) => {
        if (s.kind === "key") return true;
        const value = s.value;
        return (
          s.kind === "spread" &&
          value !== undefined &&
          viewable(value.type) &&
          sites.every(
            ({ wrapper }) =>
              keptWidths.has(wrapper) ||
              wrapper.stmts.some((st) => st.kind === "varDecl" && st.localId === value.localId),
          )
        );
      });
    spreadCarriers.set(segments, carries);
    return carries;
  };
  /** Whether a value of the shape can keep a source when a derivation
   * reads it: a checked conversion builds the shape, a kept copy does, or
   * a derivation hands one on. */
  const sourced = (id: string): boolean =>
    facts.get(id)?.runtime === true ||
    convertedShapes.has(id) ||
    notes.keptSourceShapes.has(id) ||
    linked.has(id) ||
    derived.has(id);

  // ── witness sequences ───────────────────────────────────────────────
  /** The key sequences one literal can create, or null when a spread
   * source's order is unknown. A key sits at its first occurrence that
   * certainly defines it; each earlier occurrence that may define it is
   * another possible position. */
  const literalSequences = (
    segments: readonly KeyOrderSegment[],
    keySet: ReadonlySet<string>,
    resolved: (id: string) => Resolved,
    raw: (id: string) => Resolved,
    /** The literal hands each spread value's kept key list on. */
    carries = false,
  ): string[][] | null => {
    const occurrences: { key: string; definite: boolean }[] = [];
    const ordered = orderedSpreads.has(segments);
    for (const s of segments) {
      if (s.kind === "opaque") return null;
      if (s.kind === "key") {
        if (keySet.has(s.name)) occurrences.push({ key: s.name, definite: s.definite });
        continue;
      }
      // An ordered spread's values without a source enumerate in the
      // source's table; the others carry their order over. So do the
      // values a carrying literal spreads.
      const source =
        carries || (ordered && s === segments[0]) ? raw(s.shapeId) : resolved(s.shapeId);
      if (source === "unknown") return null;
      for (const k of source.order) {
        if (keySet.has(k))
          occurrences.push({ key: k, definite: !s.maybeAbsent && !maybeAbsent(s.shapeId, k) });
      }
    }
    // Per key, the occurrences that can create it: every one up to and
    // including the first definite occurrence. The first such position is
    // the base; each other one is an alternative.
    const positions = new Map<string, number[]>();
    const settled = new Set<string>();
    occurrences.forEach((o, i) => {
      if (settled.has(o.key)) return;
      const list = positions.get(o.key) ?? [];
      list.push(i);
      positions.set(o.key, list);
      if (o.definite) settled.add(o.key);
    });
    const base = new Map<string, number>();
    for (const [key, list] of positions) base.set(key, list[0]!);
    const sequenceWith = (at: Map<string, number>): string[] =>
      [...at].sort((a, b) => a[1] - b[1]).map(([k]) => k);
    const out = [sequenceWith(base)];
    for (const [key, list] of positions) {
      for (const alternative of list.slice(1)) {
        const moved = new Map(base);
        moved.set(key, alternative);
        out.push(sequenceWith(moved));
      }
    }
    return out;
  };

  /** Today's table with every witness edge applied, or "unknown".
   *
   * Kahn's algorithm takes the ready key the table holds first, which is
   * the order the tables have always used. Ranks are unique, so a scan for
   * the smallest ready rank settles each step exactly as reordering the
   * whole ready set did. */
  const merge = (table: readonly string[], edges: readonly [string, string][]): Resolved => {
    const rank = new Map(table.map((k, i) => [k, i]));
    const succ = new Map<string, Set<string>>(table.map((k) => [k, new Set<string>()]));
    const indeg = new Map<string, number>(table.map((k) => [k, 0]));
    for (const [a, b] of edges) {
      if (a === b || !rank.has(a) || !rank.has(b)) continue;
      const s = succ.get(a)!;
      if (s.has(b)) continue;
      s.add(b);
      indeg.set(b, indeg.get(b)! + 1);
    }
    const order: string[] = [];
    const ready = table.filter((k) => indeg.get(k) === 0);
    while (ready.length > 0) {
      let at = 0;
      let best = rank.get(ready[0]!)!;
      for (let i = 1; i < ready.length; i++) {
        const r = rank.get(ready[i]!)!;
        if (r < best) {
          best = r;
          at = i;
        }
      }
      const k = ready[at]!;
      ready[at] = ready[ready.length - 1]!;
      ready.pop();
      order.push(k);
      for (const next of succ.get(k)!) {
        indeg.set(next, indeg.get(next)! - 1);
        if (indeg.get(next) === 0) ready.push(next);
      }
    }
    return order.length === table.length ? { order } : "unknown";
  };

  const chain = (seq: readonly string[], out: [string, string][]): void => {
    for (let i = 0; i + 1 < seq.length; i++) out.push([seq[i]!, seq[i + 1]!]);
  };

  // ── resolution over inheritance edges ───────────────────────────────
  const result = new Map<string, Resolved>();
  /** Set while the tracked shapes' own tables are chosen (below): the
   * orders the resolution above settled, which stay as they are. */
  let basing: ReadonlyMap<string, Resolved> | null = null;
  /** A shape's late-write edges: they read that shape's facts only, so they
   * stay valid until the facts change (a shape becomes built at run time,
   * below). */
  const late = new Map<string, [string, string][] | "unknown">();
  const dependencies = (id: string): string[] => {
    const f = facts.get(id);
    if (f === undefined) return [];
    const deps = new Set<string>();
    for (const segments of f.literals)
      for (const s of segments) if (s.kind === "spread") deps.add(s.shapeId);
    for (const c of f.copies) deps.add(c.source);
    return [...deps];
  };
  /** `{ ...value, ...rest }` that starts with a spread of a value of the
   * literal's own shape holding every key: it creates its keys in the
   * value's order, and the later segments only overwrite them. With no
   * checked conversion building the shape, every value enumerates in the
   * one table this pass chooses, so the copy agrees with any choice and
   * adds no edge. */
  const copiesItself = (
    id: string,
    f: ShapeFacts,
    table: readonly string[],
    segments: readonly KeyOrderSegment[],
  ): boolean => {
    const first = segments[0];
    return (
      first !== undefined &&
      first.kind === "spread" &&
      first.shapeId === id &&
      !first.maybeAbsent &&
      (!(f.runtime || derived.has(id)) ||
        orderedSpreads.has(segments) ||
        spreadsCarry(id, segments)) &&
      segments.every((s) => s.kind !== "opaque") &&
      table.every((k) => !maybeAbsent(id, k))
    );
  };
  /** One shape's order given its sources' current orders. */
  const resolveOne = (
    id: string,
    current: (source: string) => Resolved,
    raw: (source: string) => Resolved,
  ): Resolved => {
    const shape = shapes.get(id);
    if (!inScope(shape)) return "unknown";
    const table = tableOf(shape);
    const f = facts.get(id);
    // A shape the program never constructs natively gets its values from
    // somewhere this pass cannot see.
    if (f === undefined || !(f.literals.length > 0 || f.copies.length > 0 || f.pinned || f.runtime))
      return "unknown";
    if (basing !== null) {
      const settledOrder = basing.get(id);
      if (settledOrder !== undefined && settledOrder !== "unknown") return settledOrder;
      if (!notes.tracked.has(id)) return "unknown";
    }
    // A clone copies its source's own key order. A clone of a shape that
    // can keep a source hands the source's key list on (keepRecordClones);
    // one of a shape that cannot leaves the order a checked conversion
    // built its source in unknown.
    if (f.runtime && f.clones && !keepsSource(id)) return "unknown";
    const keySet = new Set(table);
    const edges: [string, string][] = [];
    if (f.pinned) chain(table, edges);
    /** A tracked shape's constructions, each with the orders it creates
     * and the number of places that build it (below). */
    const witnesses: { sequences: string[][]; sites: number }[] = [];
    for (const segments of f.literals) {
      if (copiesItself(id, f, table, segments)) continue;
      const sequences = literalSequences(
        segments,
        keySet,
        current,
        raw,
        spreadsCarry(id, segments),
      );
      if (basing !== null) {
        if (sequences !== null)
          witnesses.push({ sequences, sites: literalSites.get(segments) ?? 1 });
        continue;
      }
      if (sequences === null) return "unknown";
      for (const seq of sequences) chain(seq, edges);
    }
    for (const c of f.copies) {
      const source = copyCarries(id, c) ? raw(c.source) : current(c.source);
      const sequence =
        source === "unknown" ? null : source.order.filter((k) => keySet.has(k) && c.keys.has(k));
      if (basing !== null) {
        if (sequence !== null) witnesses.push({ sequences: [sequence], sites: 1 });
        continue;
      }
      if (sequence === null) return "unknown";
      chain(sequence, edges);
    }
    if (basing !== null) {
      // A tracked shape's writes and clones move the key they create in the
      // value's own key list, so its table answers for its constructions
      // first. A construction in the table's order keeps nothing and every
      // other one notes its own order, so the table is the order the most
      // places build: each order joins in turn, the one built in the most
      // places first (today's order first among equals), unless it
      // contradicts the ones before it.
      let chosen = merge(table, edges);
      if (chosen === "unknown") return "unknown";
      const rank = new Map(table.map((key, at) => [key, at]));
      const inTable = (seq: readonly string[]): boolean =>
        seq.every((key, at) => at === 0 || rank.get(seq[at - 1]!)! < rank.get(key)!);
      const orders = new Map<string, { sequences: string[][]; sites: number; at: number }>();
      for (const witness of witnesses) {
        const key = witness.sequences.map((seq) => seq.join("\0")).join("\n");
        const known = orders.get(key);
        if (known !== undefined) known.sites += witness.sites;
        else orders.set(key, { ...witness, at: orders.size });
      }
      const bySites = [...orders.values()]
        .map((witness) => ({ witness, kept: witness.sequences.every(inTable) }))
        .sort(
          (x, y) =>
            y.witness.sites - x.witness.sites ||
            Number(y.kept) - Number(x.kept) ||
            x.witness.at - y.witness.at,
        );
      for (const { witness } of bySites) {
        const next = [...edges];
        for (const seq of witness.sequences) chain(seq, next);
        const merged = merge(table, next);
        if (merged === "unknown") continue;
        chosen = merged;
        for (const seq of witness.sequences) chain(seq, edges);
      }
      // A write that creates a key puts it after the keys the record has.
      // The write moves it in the record's own list only when the table
      // lists a key the record has after it, so the table lists the keys
      // writes create last, in the order the program first writes them,
      // wherever the constructions allow: a record built by a literal and
      // then filled in that order keeps no list.
      const created: string[] = [];
      for (const w of [...f.writes].sort((x, y) => x.pos - y.pos)) {
        if (w.kind === "delete" || !keySet.has(w.field) || created.includes(w.field)) continue;
        if (maybeAbsent(id, w.field)) created.push(w.field);
      }
      if (created.length === 0) return chosen;
      // All of them at once, after the keys no write creates.
      const writes = new Set(created);
      const last = [...edges];
      chain([...chosen.order.filter((key) => !writes.has(key)), ...created], last);
      const ordered = merge(table, last);
      if (ordered !== "unknown") return ordered;
      // A construction contradicts that: each key in turn, where it can,
      // for a type with few such keys (each try sorts the table again).
      if (created.length > 16) return chosen;
      created.forEach((field, at) => {
        const later = new Set(created.slice(at));
        const next = [...edges];
        for (const key of table) if (!later.has(key)) next.push([key, field]);
        const merged = merge(table, next);
        if (merged === "unknown") return;
        chosen = merged;
        for (const key of table) if (!later.has(key)) edges.push([key, field]);
      });
      return chosen;
    }
    const cached = late.get(id);
    const lateFor = cached !== undefined ? cached : lateEdges(id, table);
    if (cached === undefined) late.set(id, lateFor);
    if (lateFor === "unknown") return "unknown";
    for (const edge of lateFor) edges.push(edge);
    return merge(table, edges);
  };
  /** A source's order as a derivation that cannot hand a kept key list on
   * sees it: values of a shape built by a checked conversion, or derived
   * from one, keep their source's own order. */
  const asSource = (id: string, resolved: Resolved): Resolved =>
    facts.get(id)?.runtime === true || derived.has(id) || notes.tracked.has(id)
      ? "unknown"
      : resolved;

  // Tarjan's SCCs over "depends on" edges: sources finish first.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let counter = 0;
  const sccs: string[][] = [];
  const strong = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of dependencies(v)) {
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  };
  for (const id of facts.keys()) if (!index.has(id)) strong(id);
  const external = (id: string): Resolved => {
    const known = result.get(id);
    return known === undefined ? "unknown" : asSource(id, known);
  };
  const resolveAll = (): void => {
    result.clear();
    for (const scc of sccs) {
      const members = new Set(scc);
      const guess = new Map<string, Resolved>();
      for (const id of scc) {
        const shape = shapes.get(id);
        guess.set(id, inScope(shape) ? { order: tableOf(shape) } : "unknown");
      }
      const lookup = (id: string): Resolved =>
        members.has(id) ? asSource(id, guess.get(id)!) : external(id);
      const rawLookup = (id: string): Resolved =>
        members.has(id) ? guess.get(id)! : (result.get(id) ?? "unknown");
      let stable = false;
      for (let round = 0; round < scc.length + 3 && !stable; round++) {
        stable = true;
        for (const id of scc) {
          const next = resolveOne(id, lookup, rawLookup);
          const prev = guess.get(id)!;
          const same =
            next === "unknown"
              ? prev === "unknown"
              : prev !== "unknown" && prev.order.join("\0") === next.order.join("\0");
          if (!same) {
            stable = false;
            guess.set(id, next);
          }
        }
      }
      for (const id of scc) result.set(id, stable ? guess.get(id)! : "unknown");
    }
  };
  /** Whether the shape has a derivation that hands on the kept key list of
   * a source that can keep one. A kept width spread and an ordered spread
   * already do, by their own means. */
  const derives = (id: string, f: ShapeFacts): boolean =>
    f.copies.some(
      (c) =>
        c.keys.size >= 2 &&
        sourced(c.source) &&
        !lowerer.recordLinks.has(`${c.source}:${id}`) &&
        copyCarries(id, c),
    ) ||
    f.literals.some(
      (segments) =>
        !orderedSpreads.has(segments) &&
        spreadsCarry(id, segments) &&
        segments.some((s) => s.kind === "spread" && sourced(s.shapeId)),
    );
  // Ordered spreads join once their source resolves; each one can let its
  // own shape resolve, which a later spread of it needs. A shape that
  // derives its values from one that can keep a source can keep one too,
  // which its own derivations then hand on in turn.
  /** Marks the shapes that derive from one that can keep a source, through
   * each other in turn. The answer rests on what the constructions are, not
   * on the orders resolved so far. */
  const deriveAll = (): void => {
    for (let grew = true; grew;) {
      grew = false;
      for (const [id, f] of facts) {
        if (derived.has(id) || !inScope(shapes.get(id)) || !derives(id, f)) continue;
        derived.add(id);
        grew = true;
      }
    }
  };
  deriveAll();
  resolveAll();
  for (let grew = true; grew;) {
    grew = false;
    for (const [segments, sites] of leadingSpreads) {
      const first = segments[0];
      if (first?.kind !== "spread" || orderedSpreads.has(segments)) continue;
      // A self copy resolves with its own shape.
      const target = sites[0]!.literal.type;
      const source = result.get(first.shapeId) ?? "unknown";
      const self = target.kind === "record" && target.shapeId === first.shapeId;
      if ((source === "unknown" && !self) || !ordersSpread(segments, sites)) continue;
      orderedSpreads.add(segments);
      if (target.kind === "record") {
        factsOf(target.shapeId).runtime = true;
        // Its presence answers and late-write edges just changed.
        late.delete(target.shapeId);
      }
      grew = true;
    }
    // An ordered spread's target can keep a source now.
    if (grew) {
      deriveAll();
      resolveAll();
    }
  }

  // ── observation ─────────────────────────────────────────────────────
  const observed = new Set<string>();
  const observedSeen = new Set<string>();
  for (const id of notes.observed)
    shapesIn({ kind: "record", shapeId: id }, observed, observedSeen);
  for (const root of observedRoots) shapesIn(root, observed, observedSeen);
  // A kept width spread snapshots its sources' own keys, an order surface
  // over each source.
  for (const { wrapper, note } of widthSites) {
    if (!keptWidths.has(wrapper)) continue;
    for (const segment of note.segments)
      if (segment.kind === "spread") shapesIn(segment.value.type, observed, observedSeen);
  }
  // A copy narrowed from a record links to it (record-links.ts) and shows
  // the record's own keys in the record's order: an order surface over the
  // record's type.
  for (let grew = true; grew;) {
    grew = false;
    for (const link of lowerer.recordLinks.values()) {
      if (!observed.has(link.to) || observed.has(link.from)) continue;
      shapesIn({ kind: "record", shapeId: link.from }, observed, observedSeen);
      observed.add(link.from);
      grew = true;
    }
  }
  // Object.assign creates the keys its target lacks in the source's key
  // order, so a copy that can create two or more keys of an observed target
  // walks the source in that order: an order surface over the source.
  for (const [helper, { target, source }] of assignCalls) {
    if (!observed.has(target)) continue;
    const created = userKeys(source).filter((k) => maybeAbsent(target, k));
    if (created.length < 2) continue;
    notes.orderedAssigns.add(helper);
    observed.add(source);
  }
  // An ordered spread's copies of values without a source take the source's
  // order from its table, which must then hold the resolved order.
  const orderedTarget = (sites: readonly LeadingSpread[]): string | null => {
    const target = sites[0]!.literal.type;
    return target.kind === "record" && (result.get(target.shapeId) ?? "unknown") !== "unknown"
      ? target.shapeId
      : null;
  };
  for (const [segments, sites] of leadingSpreads) {
    const first = segments[0];
    if (orderedSpreads.has(segments) && first?.kind === "spread" && orderedTarget(sites) !== null)
      observed.add(first.shapeId);
  }
  // A shape with no one resolved order may be tracked, and a tracked
  // construction snapshots the own keys of each value it spreads or copies
  // (trackOrders): an order surface over each source, whose table must then
  // hold the order its values are created in. The walk follows the shapes
  // the observed ones copy their orders from, as `wanted` does below.
  {
    const reached = new Set(observed);
    const pending = [...observed];
    while (pending.length > 0) {
      const id = pending.pop()!;
      const f = facts.get(id);
      if (f === undefined) continue;
      const tracks = result.get(id) === "unknown";
      const sources = [
        ...f.copies.map((c) => c.source),
        ...f.literals.flatMap((segments) =>
          segments.flatMap((s) => (s.kind === "spread" ? [s.shapeId] : [])),
        ),
      ];
      for (const source of sources) {
        if (tracks) observed.add(source);
        if (reached.has(source)) continue;
        reached.add(source);
        pending.push(source);
      }
    }
  }

  // Observed shapes, and the shapes their values copy their orders from.
  const wanted = new Set(observed);
  const pending = [...observed];
  while (pending.length > 0) {
    const f = facts.get(pending.pop()!);
    if (f === undefined) continue;
    const sources = [
      ...f.copies.map((c) => c.source),
      ...f.literals.flatMap((segments) =>
        segments.flatMap((s) => (s.kind === "spread" ? [s.shapeId] : [])),
      ),
    ];
    for (const source of sources) {
      if (wanted.has(source)) continue;
      wanted.add(source);
      pending.push(source);
    }
  }
  /** The shapes a shape's values are derived from. */
  const sourcesOf = (f: ShapeFacts): string[] => [
    ...f.copies.map((c) => c.source),
    ...f.literals.flatMap((segments) =>
      segments.flatMap((s) => (s.kind === "spread" ? [s.shapeId] : [])),
    ),
  ];
  // Shapes with one table whose derivations hand kept key lists on, where
  // an order surface can tell: their copies and spread literals carry the
  // source's list (trackOrders), and so do the clones of a shape whose
  // values can keep one.
  const carried = new Set<string>();
  for (const id of wanted) {
    const f = facts.get(id);
    if (f === undefined || (result.get(id) ?? "unknown") === "unknown") continue;
    if (!inScope(shapes.get(id)) || !keepsSource(id)) continue;
    if (derived.has(id) || (f.clones && sourced(id))) carried.add(id);
  }

  // ── apply ───────────────────────────────────────────────────────────
  /** The shape's table becomes its resolved order. */
  const applyOrder = (id: string): void => {
    const resolved = result.get(id);
    if (resolved === undefined || resolved === "unknown") return;
    const shape = shapes.get(id);
    if (!inScope(shape)) return;
    const table = tableOf(shape);
    if (resolved.order.join("\0") === table.join("\0")) return;
    shape.declaredOrder = [...shape.declaredOrder!.filter(isArrayIndex), ...resolved.order];
    notes.changed.add(id);
  };
  for (const id of result.keys()) if (observed.has(id)) applyOrder(id);
  // A record that keeps no source is in its table's order: the derivations
  // that carry rely on it for the record they build and for the one they
  // read, so both tables hold the resolved order whether or not an order
  // surface walks them directly.
  for (const id of carried) {
    applyOrder(id);
    for (const source of sourcesOf(facts.get(id)!)) applyOrder(source);
  }

  // Ordered spreads carry their source's order over (see above).
  let orderedResults = 0;
  const rewritten = new Set<IrExpr>();
  keepWidthSpreads(notes, widthSites, keptWidths, rewritten);
  for (const [segments, sites] of leadingSpreads) {
    const first = segments[0];
    if (!orderedSpreads.has(segments) || first?.kind !== "spread" || first.value === undefined)
      continue;
    // A shape that did not resolve keeps today's table for every value.
    if (orderedTarget(sites) === null) continue;
    for (const { wrapper, literal, fn } of sites) {
      if (rewritten.has(wrapper)) continue;
      rewritten.add(wrapper);
      noted.add(literal);
      const loc = literal.loc;
      const localId = `%orderedSpread.${orderedResults++}`;
      fn.locals.push({ id: localId, name: "%orderedSpread", type: literal.type, mutable: false });
      const built: IrExpr = { kind: "varRef", localId, type: literal.type, loc };
      const source: IrExpr = {
        kind: "varRef",
        localId: first.value.localId,
        type: { kind: "record", shapeId: first.shapeId },
        loc,
      };
      wrapper.stmts.push(
        { kind: "varDecl", localId, init: literal, loc },
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "record.sourceSpread",
            args: [built, source],
            type: VOID,
            loc,
          },
          loc,
        },
      );
      wrapper.result = { kind: "varRef", localId, type: literal.type, loc };
    }
  }

  // ── per-instance orders ─────────────────────────────────────────────
  // A shape whose literals write its keys in more than one order has no
  // one table. Each value then records which of the orders it was written
  // in (KEY_ORDER_FIELD), when every construction's order is known
  // statically or copied from a value that records its own:
  //  - a literal of explicit keys writes its order;
  //  - a copy from a shape with one resolved order writes that order;
  //  - a copy from a value of a shape with orders writes the source's
  //    order, filtered to the copy's keys (rest bindings, width copies);
  //  - clones copy the field, and every other construction (synthesized
  //    literals, checked conversions, runtime producers) leaves 0, today's
  //    table, as before.
  // A write of an optional key a value lacks moves the key to the end of
  // the value's order, as in Node: the orders include every order such
  // writes reach, and each write site updates the index after it evaluates
  // the value and before it writes the key.
  const MAX_ORDERS = 16;
  const unresolved = (id: string): boolean => result.get(id) === "unknown";
  /** `order` over every key of `table`: keys the order lacks follow it. */
  const complete = (order: readonly string[], table: readonly string[]): string[] => {
    const keys = new Set(table);
    const out = order.filter((k) => keys.has(k));
    const seen = new Set(out);
    return [...out, ...table.filter((k) => !seen.has(k))];
  };
  const literalOrder = (segments: readonly KeyOrderSegment[]): string[] | null => {
    const out: string[] = [];
    for (const segment of segments) {
      if (segment.kind !== "key" || !segment.definite) return null;
      if (!isArrayIndex(segment.name)) out.push(segment.name);
    }
    return out;
  };
  /** `{ ...value }` of a value of the literal's own shape: a copy of the
   * value's order. */
  const selfSpread = (segments: readonly KeyOrderSegment[], id: string): boolean =>
    segments.length === 1 &&
    segments[0]!.kind === "spread" &&
    segments[0]!.shapeId === id &&
    !segments[0]!.maybeAbsent;
  const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
    a.join("\0") === b.join("\0");
  const indexOfOrder = (orders: readonly string[][], order: readonly string[]): number =>
    orders.findIndex((o) => sameOrder(o, order));
  /** The keys writes can add to a value of the shape, or null when a
   * clone override can (the clone's order is its source's). */
  const movingKeys = (id: string, f: ShapeFacts, table: readonly string[]): string[] | null => {
    // A write whose key is a run-time value cannot name the order it leads to.
    if (f.keyed) return null;
    const keys = new Set(table);
    const moving = new Set<string>();
    for (const w of f.writes) {
      if (w.kind === "delete" || !keys.has(w.field) || !maybeAbsent(id, w.field)) continue;
      if (w.kind === "clone") return null;
      moving.add(w.field);
    }
    return [...moving];
  };
  /** `values[i]` for the order index `current` holds, as a chain of
   * tests. */
  const indexChain = (current: IrExpr, values: readonly number[], loc: SrcLoc): IrExpr => {
    let out: IrExpr = { kind: "numLit", value: values[values.length - 1]!, type: F64, loc };
    for (let i = values.length - 2; i >= 0; i--) {
      if (out.kind === "numLit" && out.value === values[i]) continue;
      out = {
        kind: "ternary",
        cond: {
          kind: "bin",
          op: "===",
          left: current,
          right: { kind: "numLit", value: i, type: F64, loc },
          type: BOOL,
          loc,
        },
        then: { kind: "numLit", value: values[i]!, type: F64, loc },
        else_: out,
        type: F64,
        loc,
      };
    }
    return out;
  };
  const moves = new Map<string, Map<string, number[]>>();
  /** Adds to `orders` every order writes of `moving` keys reach from them
   * and records each key's transitions; false past MAX_ORDERS. */
  const closeUnderMoves = (id: string, orders: string[][], moving: readonly string[]): boolean => {
    const transitions = new Map<string, number[]>(moving.map((k) => [k, []]));
    for (let i = 0; i < orders.length; i++) {
      for (const key of moving) {
        const moved = [...orders[i]!.filter((k) => k !== key), key];
        let index = indexOfOrder(orders, moved);
        if (index < 0) {
          if (orders.length === MAX_ORDERS) return false;
          index = orders.push(moved) - 1;
        }
        transitions.get(key)![i] = index;
      }
    }
    if (moving.length > 0) moves.set(id, transitions);
    return true;
  };
  const orderable = (
    id: string,
    f: ShapeFacts,
  ): { shape: IrRecordShape; moving: string[] } | null => {
    const shape = shapes.get(id);
    if (!wanted.has(id) || !unresolved(id) || !inScope(shape)) return null;
    const moving = movingKeys(id, f, tableOf(shape));
    return moving === null ? null : { shape, moving };
  };
  const variants = new Map<string, string[][]>();
  for (const [id, f] of facts) {
    const candidate = orderable(id, f);
    // A runtime producer builds the shape's values in its fixed layout,
    // which has no KEY_ORDER_FIELD.
    if (candidate === null || f.literals.length === 0 || f.opaque) continue;
    const table = tableOf(candidate.shape);
    const orders: string[][] = [table];
    let ok = true;
    const add = (order: readonly string[]): void => {
      const full = complete(order, table);
      if (indexOfOrder(orders, full) < 0) orders.push(full);
    };
    for (const segments of f.literals) {
      if (selfSpread(segments, id)) continue;
      const order = literalOrder(segments);
      if (order === null) ok = false;
      else add(order);
    }
    for (const c of f.copies) {
      if (c.source === id) continue;
      const source = result.get(c.source);
      // A copy of a value that can keep its own key list takes that list
      // when it runs: no index names it.
      if (source === undefined || source === "unknown" || sourced(c.source)) ok = false;
      else add(source.order.filter((k) => c.keys.has(k)));
    }
    if (!ok || orders.length > MAX_ORDERS || !closeUnderMoves(id, orders, candidate.moving))
      continue;
    if (orders.length > 1) variants.set(id, orders);
    else moves.delete(id);
  }
  // Shapes built only from values of one shape with orders, all in one
  // way: copies (rest bindings, width copies), or literals spreading the
  // value between the same explicit keys. Order i is the source's order i
  // over the shape's keys, after the keys before the spread and before
  // the keys after it. A key after the spread that the source value may
  // lack goes where the source has it, or after the source's keys when it
  // has not: such a literal's orders are one per source order and set of
  // those keys the source has, and `select.index[present][i]` is the order
  // for source order i with the keys of bit set `present`.
  type Template = {
    source: string;
    prefix: string[];
    suffix: string[];
    select?: { keys: string[]; index: number[][] };
  };
  const templateOf = (segments: readonly KeyOrderSegment[], id: string): Template | null => {
    const prefix: string[] = [];
    const suffix: string[] = [];
    let source: string | null = null;
    for (const segment of segments) {
      if (segment.kind === "opaque") return null;
      if (segment.kind === "spread") {
        if (source !== null || segment.maybeAbsent || segment.shapeId === id) return null;
        source = segment.shapeId;
        continue;
      }
      if (!segment.definite) return null;
      (source === null ? prefix : suffix).push(segment.name);
    }
    return source === null ? null : { source, prefix, suffix };
  };
  const templateKey = (t: Template): string => JSON.stringify([t.source, t.prefix, t.suffix]);
  const copyTemplate = (source: string): Template => ({ source, prefix: [], suffix: [] });
  const mirrors = new Map<string, Template>();
  /** Shapes whose copies of a source with orders all agree on one order,
   * which became their table. */
  const settled = new Set<string>();
  for (const [id, f] of facts) {
    if (variants.has(id) || f.pinned || f.runtime || f.opaque) continue;
    const candidate = orderable(id, f);
    if (candidate === null || f.literals.length + f.copies.length === 0) continue;
    const templates: (Template | null)[] = f.literals.map((segments) => templateOf(segments, id));
    for (const c of f.copies) templates.push(copyTemplate(c.source));
    const first = templates[0];
    if (
      first === null ||
      first === undefined ||
      templates.some((t) => t === null || templateKey(t) !== templateKey(first))
    )
      continue;
    const orders = variants.get(first.source);
    if (orders === undefined || mirrors.has(first.source)) continue;
    const table = tableOf(candidate.shape);
    const tested = first.suffix.filter((k) => maybeAbsent(first.source, k));
    if (tested.length > 4) continue;
    const mirrorOf = (o: readonly string[], lacks: ReadonlySet<string>): string[] => {
      const order = [...first.prefix];
      for (const k of o) if (!lacks.has(k) && !order.includes(k)) order.push(k);
      for (const k of first.suffix) if (!order.includes(k)) order.push(k);
      return complete(order, table);
    };
    let mirrored: string[][];
    let template: Template = first;
    if (tested.length === 0) mirrored = orders.map((o) => mirrorOf(o, new Set()));
    else {
      mirrored = [];
      const index: number[][] = [];
      for (let present = 0; present < 1 << tested.length; present++) {
        const lacks = new Set(tested.filter((_, j) => (present & (1 << j)) === 0));
        const row: number[] = [];
        for (const o of orders) {
          const order = mirrorOf(o, lacks);
          let i = indexOfOrder(mirrored, order);
          if (i < 0) i = mirrored.push(order) - 1;
          row.push(i);
        }
        index.push(row);
      }
      if (mirrored.length > MAX_ORDERS) continue;
      template = {
        source: first.source,
        prefix: first.prefix,
        suffix: first.suffix,
        select: { keys: tested, index },
      };
    }
    if (!closeUnderMoves(id, mirrored, candidate.moving)) continue;
    if (mirrored.every((o) => sameOrder(o, mirrored[0]!))) {
      // Every order of the source agrees over these keys: one table.
      moves.delete(id);
      const shape = candidate.shape;
      const only: string[] = mirrored[0] ?? table;
      if (!sameOrder(only, table))
        shape.declaredOrder = [...shape.declaredOrder!.filter(isArrayIndex), ...only];
      settled.add(id);
      continue;
    }
    variants.set(id, mirrored);
    mirrors.set(id, template);
  }
  // Every construction of those shapes, to give each its order index. A
  // copy reads its source's index, so its source must be a plain binding.
  const sites = new Map<string, (IrExpr & { kind: "recordLit" })[]>();
  /** The statements a spread literal's sequence evaluates first: the
   * spread value's binding, then its fields. */
  const prologues = new Map<IrExpr, readonly IrStmt[]>();
  const siteOf = (e: IrExpr): boolean => {
    if (e.kind === "seqExpr" && e.result.kind === "recordLit") prologues.set(e.result, e.stmts);
    // A kept width spread's literal now initializes its own declaration, but
    // it still evaluates the spread's source binding in the wrapper's
    // prologue (keepWidthSpreads).
    const host = keptLiteralStmts.get(e);
    if (host !== undefined && e.kind === "recordLit") prologues.set(e, host);
    if (e.kind === "recordLit" && e.type.kind === "record" && variants.has(e.type.shapeId)) {
      const list = sites.get(e.type.shapeId) ?? [];
      list.push(e);
      sites.set(e.type.shapeId, list);
    }
    return everyExprChild(e, siteOf, siteStmt);
  };
  const siteStmt = (st: IrStmt): boolean => everyStmtChild(st, siteOf, siteStmt);
  /** The function each literal with a prologue is built in. */
  const owners = new Map<IrExpr, IrFunction>();
  if (variants.size > 0) {
    for (const fn of fns) {
      const before = new Set(prologues.keys());
      for (const st of fn.body) siteStmt(st);
      for (const lit of prologues.keys()) if (!before.has(lit)) owners.set(lit, fn);
    }
  }
  /** Where a literal evaluated its spread of `source`: the declaration the
   * spread segment names, in the literal's own prologue. */
  const spreadBinding = (
    lit: IrExpr & { kind: "recordLit" },
    source: string,
  ): { stmts: IrStmt[]; at: number; value: IrExpr } | null => {
    const stmts = prologues.get(lit) as IrStmt[] | undefined;
    if (stmts === undefined) return null;
    for (const segment of notes.literalOf(lit) ?? []) {
      if (segment.kind !== "spread" || segment.shapeId !== source || !segment.value) continue;
      const localId = segment.value.localId;
      const at = stmts.findIndex((st) => st.kind === "varDecl" && st.localId === localId);
      const decl = stmts[at];
      if (decl?.kind !== "varDecl" || decl.init === null) return null;
      return { stmts, at, value: { kind: "varRef", localId, type: decl.init.type, loc: lit.loc } };
    }
    return null;
  };
  /** The binding a copy or spread reads its fields from. A literal's spread
   * names it; every field of a copy reads it. */
  const copySource = (lit: IrExpr & { kind: "recordLit" }, source: string): IrExpr | null => {
    if (notes.literalOf(lit) !== undefined) return spreadBinding(lit, source)?.value ?? null;
    for (const field of lit.fields) {
      const value = field.value;
      if (value.kind === "recordGet" && value.shapeId === source && value.obj.kind === "varRef")
        return value.obj;
    }
    for (const st of prologues.get(lit) ?? []) {
      if (st.kind !== "varDecl" || st.init === null) continue;
      const t = st.init.type;
      if (t.kind === "record" && t.shapeId === source)
        return { kind: "varRef", localId: st.localId, type: t, loc: lit.loc };
    }
    return null;
  };
  const orderIndex = (id: string, lit: IrExpr & { kind: "recordLit" }): IrExpr | number | null => {
    const orders = variants.get(id)!;
    const segments = notes.literalOf(lit);
    if (segments !== undefined && selfSpread(segments, id)) {
      const obj = copySource(lit, id);
      if (obj === null) return null;
      return {
        kind: "recordGet",
        obj,
        shapeId: id,
        field: KEY_ORDER_FIELD,
        type: F64,
        loc: lit.loc,
      };
    }
    const mirror = mirrors.get(id);
    if (segments !== undefined && mirror !== undefined) {
      const obj = copySource(lit, mirror.source);
      if (obj === null) return null;
      const sourceIndex: IrExpr = {
        kind: "recordGet",
        obj,
        shapeId: mirror.source,
        field: KEY_ORDER_FIELD,
        type: F64,
        loc: lit.loc,
      };
      const select = mirror.select;
      if (select === undefined) return sourceIndex;
      // Tests the source for each key in turn, then picks by its index.
      const pick = (j: number, present: number): IrExpr => {
        if (j === select.keys.length)
          return indexChain(sourceIndex, select.index[present]!, lit.loc);
        return {
          kind: "ternary",
          cond: lowerer.recordFieldPresent(obj, mirror.source, select.keys[j]!, lit.loc),
          then: pick(j + 1, present | (1 << j)),
          else_: pick(j + 1, present),
          type: F64,
          loc: lit.loc,
        };
      };
      return pick(0, 0);
    }
    if (segments !== undefined) {
      const order = literalOrder(segments);
      return order === null ? null : indexOfOrder(orders, complete(order, orders[0]!));
    }
    const source = notes.copyOf(lit);
    if (source === undefined) return 0;
    if (variants.has(source) && (source === id || mirrors.get(id)?.source === source)) {
      const obj = copySource(lit, source);
      if (obj === null) return null;
      return {
        kind: "recordGet",
        obj,
        shapeId: source,
        field: KEY_ORDER_FIELD,
        type: F64,
        loc: lit.loc,
      };
    }
    const resolved = result.get(source);
    if (resolved === undefined || resolved === "unknown") return null;
    const keys = new Set(
      lit.fields.filter((x) => x.value.kind !== "fieldAbsent").map((x) => x.name),
    );
    return indexOfOrder(
      orders,
      complete(
        resolved.order.filter((k) => keys.has(k)),
        orders[0]!,
      ),
    );
  };
  const plan = new Map<IrExpr & { kind: "recordLit" }, IrExpr | number>();
  const dropped = new Set<string>(keptDropShapes);
  for (const [id, list] of sites) {
    for (const lit of list) {
      const index = orderIndex(id, lit);
      if (index === null || (typeof index === "number" && index < 0)) dropped.add(id);
      else plan.set(lit, index);
    }
  }
  // A shape whose copies cannot read their source keeps today's table, and
  // so do the shapes that mirror it.
  for (const [id, mirror] of mirrors) if (dropped.has(mirror.source)) dropped.add(id);

  // ── tracked orders ──────────────────────────────────────────────────
  // What is left has no one table and no countable set of orders: spreads
  // at different positions, spreads of values whose own order is a run-time
  // fact, more orders than an index holds, keys several writes can create
  // in any sequence. Each value of such a shape keeps its own key list, the
  // kept source a checked conversion's records already enumerate through
  // (record-sources.ts): a construction notes the order it created its keys
  // in, and a write that creates a key moves it last (trackOrders). The
  // runtime keeps nothing for a value in the table's order, so the table
  // stays today's.
  /** Whether the shape's values can differ in order at all, and the
   * program builds or grows them where this pass can see: two keys or more,
   * and a literal, a copy, a clone or a write that creates a key. */
  const orders = (id: string): boolean => {
    const shape = shapes.get(id);
    const f = facts.get(id);
    if (f === undefined || !inScope(shape) || tableOf(shape).length < 2) return false;
    return f.loc !== null || f.writes.some((w) => w.kind === "write" && maybeAbsent(id, w.field));
  };
  for (const id of wanted) {
    if (result.get(id) !== "unknown" || settled.has(id)) continue;
    if (variants.has(id) && !dropped.has(id)) continue;
    if (orders(id) && keepsSource(id)) notes.tracked.add(id);
  }
  // A tracked shape's table is chosen from its constructions: the order of
  // its literals and of the records it copies and spreads, as for any
  // shape, without the writes and clones that create a key afterwards,
  // which move the key in the value's own list when they run. Where the
  // constructions disagree it is the order the most places build
  // (resolveOne). A value built in the table's order keeps nothing, and
  // each other construction notes its own order.
  const tablesBefore = new Map<string, string[]>();
  if (notes.tracked.size > 0) {
    const settledOrders = new Map(result);
    basing = settledOrders;
    resolveAll();
    basing = null;
    for (const id of notes.tracked) {
      const order = result.get(id);
      const shape = shapes.get(id);
      if (order === undefined || order === "unknown" || !inScope(shape)) continue;
      if (order.order.join("\0") === tableOf(shape).join("\0")) continue;
      tablesBefore.set(id, shape.declaredOrder!);
      shape.declaredOrder = [...shape.declaredOrder!.filter(isArrayIndex), ...order.order];
      notes.changed.add(id);
    }
    result.clear();
    for (const [id, order] of settledOrders) result.set(id, order);
  }
  const untracked =
    notes.tracked.size > 0 || carried.size > 0
      ? trackOrders(lowerer, fns, noted, keptClones.size, {
          tableOf: (id) => {
            const shape = shapes.get(id);
            return inScope(shape) ? tableOf(shape) : null;
          },
          carried,
          // A shape with no one order may keep each value's own.
          sourced: (id) => sourced(id) || (result.get(id) ?? "unknown") === "unknown",
          indexed: (id) => variants.has(id) && !dropped.has(id),
          absent: maybeAbsent,
          linked: (id) => linked.has(id),
        })
      : new Map<string, { loc: SrcLoc; cause: UntrackedCause }>();
  // A shape left out of the tracked set keeps today's table.
  for (const [id, table] of tablesBefore) {
    if (notes.tracked.has(id)) continue;
    shapes.get(id)!.declaredOrder = table;
    notes.changed.delete(id);
  }
  for (const id of notes.tracked) notes.keptSourceShapes.add(id);
  for (const id of carried) notes.keptSourceShapes.add(id);
  // What neither a table, an index nor tracking covers keeps today's table
  // for every value, where the program observes it: reported (SC6002).
  for (const id of observed) {
    if (result.get(id) !== "unknown" || settled.has(id) || notes.tracked.has(id)) continue;
    if ((variants.has(id) && !dropped.has(id)) || !orders(id)) continue;
    const f = facts.get(id)!;
    const where =
      f.loc ?? f.writes.find((w) => w.kind === "write" && maybeAbsent(id, w.field))?.loc;
    const site = untracked.get(id);
    if (site !== undefined) notes.unordered.set(id, site);
    else if (where !== undefined) notes.unordered.set(id, { loc: where, cause: "shape" });
  }
  /** The keys a write creates in a record's own key list: every key of a
   * tracked shape a write can create, and a key the program deletes from a
   * shape whose values may already keep a source (a checked conversion's,
   * a kept copy's), where writing it again moves it last. */
  const appended = new Map<string, Set<string>>();
  for (const [id, f] of facts) {
    const shape = shapes.get(id);
    if (!wanted.has(id) || !inScope(shape) || !keepsSource(id)) continue;
    // A derivation hands on a key list that can hold a place for a key the
    // record lacks, which a write then creates.
    const tracks = notes.tracked.has(id) || (carried.has(id) && derived.has(id));
    if (!tracks && !f.runtime && !notes.keptSourceShapes.has(id)) continue;
    const keys = new Set<string>();
    for (const w of f.writes) {
      if (w.kind !== "write" || isArrayIndex(w.field) || !maybeAbsent(id, w.field)) continue;
      if (tracks || f.deleted.has(w.field)) keys.add(w.field);
    }
    if (keys.size > 0) appended.set(id, keys);
  }
  if (variants.size === 0 && appended.size === 0) return;

  // Write sites of keys that move: each reads and updates the value's
  // index, or moves the key last in the value's own key list, before the
  // write.
  const writeSites: { st: IrStmt & { kind: "recordSet" }; fn: IrFunction }[] = [];
  const keyedSites: { st: IrStmt & { kind: "recordKeySet" }; fn: IrFunction }[] = [];
  let writeFn: IrFunction | null = null;
  const writeExpr = (e: IrExpr): boolean => everyExprChild(e, writeExpr, writeOf);
  const writeOf = (st: IrStmt): boolean => {
    if (st.kind === "recordKeySet" && st.overflowOnly !== true && appended.has(st.shapeId))
      keyedSites.push({ st, fn: writeFn! });
    if (
      st.kind === "recordSet" &&
      st.value.kind !== "fieldAbsent" &&
      ((!dropped.has(st.shapeId) && moves.get(st.shapeId)?.has(st.field)) ||
        appended.get(st.shapeId)?.has(st.field))
    )
      writeSites.push({ st, fn: writeFn! });
    return everyStmtChild(st, writeExpr, writeOf);
  };
  for (const fn of fns) {
    writeFn = fn;
    for (const st of fn.body) writeOf(st);
  }
  let temporaries = 0;
  for (const [lit, index] of plan) {
    const id = (lit.type as IrType & { kind: "record" }).shapeId;
    if (dropped.has(id)) continue;
    let value: IrExpr =
      typeof index === "number" ? { kind: "numLit", value: index, type: F64, loc: lit.loc } : index;
    // A spread's order is the source's order at the spread: a later
    // property may move the source's keys. Read it right after the literal
    // evaluates the source.
    const source = mirrors.get(id)?.source;
    const binding = typeof index === "number" || !source ? null : spreadBinding(lit, source);
    const fn = owners.get(lit);
    if (binding && fn) {
      const localId = `%keyOrderSource.${temporaries++}`;
      fn.locals.push({ id: localId, name: "%keyOrderSource", type: F64, mutable: false });
      binding.stmts.splice(binding.at + 1, 0, {
        kind: "varDecl",
        localId,
        init: value,
        loc: lit.loc,
      });
      value = { kind: "varRef", localId, type: F64, loc: lit.loc };
    }
    lit.fields.push({ name: KEY_ORDER_FIELD, value });
  }
  const replacements = new Map<IrFunction, Map<IrStmt, IrStmt>>();
  for (const { st, fn } of writeSites) {
    const transitions = dropped.has(st.shapeId) ? undefined : moves.get(st.shapeId)?.get(st.field);
    const loc = st.loc;
    // A receiver other than a binding evaluates once, into a local. So does
    // a binding when the value evaluates first (below): the value may
    // assign the binding, and the write still goes to the object the
    // binding held before.
    const pure =
      st.value.kind === "numLit" ||
      st.value.kind === "strLit" ||
      st.value.kind === "boolLit" ||
      st.value.kind === "varRef";
    let plain = st.obj;
    while (plain.kind === "unionNarrow" || plain.kind === "downcast") plain = plain.value;
    const prologue: IrStmt[] = [];
    let obj = st.obj;
    if (plain.kind !== "varRef" || !pure) {
      const localId = `%keyOrderReceiver.${temporaries++}`;
      fn.locals.push({ id: localId, name: "%keyOrderReceiver", type: st.obj.type, mutable: false });
      prologue.push({ kind: "varDecl", localId, init: st.obj, loc });
      obj = { kind: "varRef", localId, type: st.obj.type, loc };
    }
    const current: IrExpr = {
      kind: "recordGet",
      obj,
      shapeId: st.shapeId,
      field: KEY_ORDER_FIELD,
      type: F64,
      loc,
    };
    // The value evaluates before the key is tested and moved: it may add
    // other keys to the same value, which then come first.
    let value = st.value;
    if (!pure) {
      const localId = `%keyOrderValue.${temporaries++}`;
      fn.locals.push({ id: localId, name: "%keyOrderValue", type: value.type, mutable: false });
      prologue.push({ kind: "varDecl", localId, init: value, loc });
      value = { kind: "varRef", localId, type: value.type, loc };
    }
    const absent: IrExpr = {
      kind: "unary",
      op: "!",
      operand: lowerer.recordFieldPresent(obj, st.shapeId, st.field, loc),
      type: BOOL,
      loc,
    };
    const created: IrStmt[] = [];
    if (transitions !== undefined)
      created.push({
        kind: "recordSet",
        obj,
        shapeId: st.shapeId,
        field: KEY_ORDER_FIELD,
        value: indexChain(current, transitions, loc),
        loc,
      });
    if (appended.get(st.shapeId)?.has(st.field)) {
      // A record that keeps a source moves the key last in it. Without one
      // the record is in its table's order, which the new key leaves only
      // when a key the table lists later is there.
      const table = tableOf(shapes.get(st.shapeId)!);
      let outOfPlace: IrExpr = recordSourceTest(obj, loc);
      const later = table.slice(table.indexOf(st.field) + 1);
      // The tests are emitted at every such write: a type with many keys
      // after this one asks the runtime instead, which keeps a list for the
      // record unless the key is the table's last.
      if (notes.tracked.has(st.shapeId) && later.length > 64)
        outOfPlace = { kind: "boolLit", value: true, type: BOOL, loc };
      else if (notes.tracked.has(st.shapeId)) {
        for (const key of later) {
          const present = lowerer.recordFieldPresent(obj, st.shapeId, key, loc);
          outOfPlace = {
            kind: "logical",
            op: "||",
            left: outOfPlace,
            right: present,
            type: BOOL,
            loc,
          };
          // A required key is always there.
          if (present.kind === "boolLit") break;
        }
      }
      const append: IrStmt = {
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "record.orderAppend",
          args: [
            obj,
            { kind: "dynFrom", value: obj, liveRef: true, type: DYN, loc },
            strLit(st.field, loc),
          ],
          type: VOID,
          loc,
        },
        loc,
      };
      created.push({ kind: "if", cond: outOfPlace, then: [append], else_: null, loc });
    }
    // The write becomes a block that moves the key first.
    const write: IrStmt = {
      kind: "recordSet",
      obj,
      shapeId: st.shapeId,
      field: st.field,
      value,
      loc,
    };
    const guard: IrStmt = { kind: "if", cond: absent, then: created, else_: null, loc };
    const block: IrStmt = { kind: "block", body: [...prologue, guard, write], loc };
    let replaced = replacements.get(fn);
    if (replaced === undefined) {
      replaced = new Map();
      replacements.set(fn, replaced);
    }
    replaced.set(st, block);
  }
  // A keyed write creates the key it names when the record lacks it, and
  // the key then moves last in the record's own key list. The key is a
  // value, so the runtime finds its place (record.orderAppendKey): a record
  // that keeps no list gets one unless the key is its table's last.
  for (const { st, fn } of keyedSites) {
    const loc = st.loc;
    const prologue: IrStmt[] = [];
    const bind = (name: string, init: IrExpr): (() => IrExpr) => {
      const localId = `%${name}.${temporaries++}`;
      fn.locals.push({ id: localId, name: `%${name}`, type: init.type, mutable: false });
      prologue.push({ kind: "varDecl", localId, init, loc });
      return () => ({ kind: "varRef", localId, type: init.type, loc });
    };
    // Receiver, key and value evaluate in the write's order, before the key
    // is tested: the value may add other keys to the same record.
    const obj = bind("keyOrderReceiver", st.obj);
    const key = bind("keyOrderKey", st.key);
    const value = bind("keyOrderValue", st.value);
    const has: IrExpr = {
      kind: "call",
      callee: recordHasOwnHelper(lowerer, st.shapeId, loc),
      args: [obj(), key()],
      type: BOOL,
      loc,
    };
    const append: IrStmt = {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "record.orderAppendKey",
        args: [obj(), { kind: "dynFrom", value: obj(), liveRef: true, type: DYN, loc }, key()],
        type: VOID,
        loc,
      },
      loc,
    };
    const write: IrStmt = {
      kind: "recordKeySet",
      obj: obj(),
      shapeId: st.shapeId,
      key: key(),
      value: value(),
      loc,
    };
    const block: IrStmt = {
      kind: "block",
      body: [
        ...prologue,
        {
          kind: "if",
          cond: { kind: "unary", op: "!", operand: has, type: BOOL, loc },
          then: [append],
          else_: null,
          loc,
        },
        write,
      ],
      loc,
    };
    let replaced = replacements.get(fn);
    if (replaced === undefined) {
      replaced = new Map();
      replacements.set(fn, replaced);
    }
    replaced.set(st, block);
  }
  for (const [fn, replaced] of replacements) {
    fn.body = transformStmtList(fn.body, {
      expr: (e) => e,
      stmt: (st) => replaced.get(st) ?? st,
    });
  }
  for (const [id, orders] of variants) {
    if (dropped.has(id)) continue;
    const shape = shapes.get(id)!;
    const indexKeys: string[] = (shape.declaredOrder ?? []).filter(isArrayIndex);
    shapes.addKeyOrderField(id);
    const tables: string[][] = [];
    for (const order of orders) {
      const table: string[] = [...indexKeys];
      for (const key of order) table.push(key);
      tables.push(table);
    }
    shape.orderVariants = tables;
  }
}

/** The replacements recorded for `fn`. */
function replacementsIn(
  byFn: Map<IrFunction, Map<IrExpr, IrExpr>>,
  fn: IrFunction,
): Map<IrExpr, IrExpr> {
  let replacements = byFn.get(fn);
  if (replacements === undefined) byFn.set(fn, (replacements = new Map()));
  return replacements;
}

/** Replaces each node of `replacements` in `fn` through the node that holds
 * it (replaceChildExpr), and the nodes under a replacement in turn. A node
 * is never rewritten into another kind in place: the compiler compiles this
 * file too, and a node it builds keeps its kind's fields. */
function replaceThroughParents(fn: IrFunction, replacements: ReadonlyMap<IrExpr, IrExpr>): void {
  if (replacements.size === 0) return;
  let replaced = 0;
  const children = (parent: IrExpr | IrStmt) => ({
    expr: (child: IrExpr): boolean => {
      const to = replacements.get(child);
      if (to !== undefined && replaceChildExpr(parent, child, to)) replaced++;
      visitExpr(to ?? child);
      return true;
    },
    stmt: (child: IrStmt): boolean => {
      visitStmt(child);
      return true;
    },
  });
  function visitExpr(node: IrExpr): void {
    const { expr, stmt } = children(node);
    everyExprChild(node, expr, stmt);
  }
  function visitStmt(node: IrStmt): void {
    const { expr, stmt } = children(node);
    everyStmtChild(node, expr, stmt);
  }
  for (const stmt of fn.body) visitStmt(stmt);
  if (replaced !== replacements.size)
    throw new InternalCompilerError(
      `key-order-witness: ${replacements.size - replaced} kept site(s) not found in ${fn.name}`,
    );
}

/** Width spreads: `{ ...wide }` into a narrower declared record. Node's copy
 * holds every own key of the source; the static copy holds the declared
 * ones. When an order surface can observe the target shape (the same
 * observation the order tables use), the literal keeps the copy's whole
 * own-key list as the record's kept source (scr_record_source_note): each
 * spread source's own keys are snapshot as the spread runs, explicit keys
 * hold placeholders at their position, and the record stays the source of
 * truth for every declared key. Programs no surface observes keep the
 * static copy byte for byte. */
function widthKeepable(
  lowerer: Lowerer,
  wrapper: IrExpr & { kind: "seqExpr" },
  width: readonly WidthSegment[],
): boolean {
  return width.every(
    (segment) =>
      segment.kind === "key" ||
      ((segment.value.type.kind === "dyn" || lowerer.dynConvertible(segment.value.type)) &&
        wrapper.stmts.some(
          (stmt) => stmt.kind === "varDecl" && stmt.localId === segment.value.localId,
        )),
  );
}

function keepWidthSpreads(
  notes: KeyOrderNotes,
  sites: readonly (LeadingSpread & { note: WidthNote })[],
  kept: ReadonlySet<IrExpr>,
  rewritten: Set<IrExpr>,
): void {
  let index = 0;
  for (const { wrapper, literal, fn, note } of sites) {
    if (!kept.has(wrapper) || rewritten.has(wrapper)) continue;
    rewritten.add(wrapper);
    notes.keptWidthSpreads++;
    const width = note.segments;
    const loc = literal.loc;
    const site = index++;
    const empty = (): IrExpr => ({ kind: "dynObjLit", fields: [], type: DYN, loc });
    const assign = (target: IrExpr, from: IrExpr): IrExpr => ({
      kind: "libCall",
      fn: "dyn.assign",
      args: [target, from],
      type: DYN,
      loc,
    });
    let mirror: IrExpr = empty();
    let spreadIndex = 0;
    for (const segment of width) {
      if (segment.kind === "key") {
        mirror = assign(mirror, {
          kind: "dynObjLit",
          fields: [{ key: strLit(segment.name, loc), value: dynUndefinedExpr(loc) }],
          type: DYN,
          loc,
        });
        continue;
      }
      // The spread copies the source's own keys when it runs: snapshot them
      // right after the literal evaluated the source.
      const localId = `%widthKeys.${site}.${spreadIndex++}`;
      fn.locals.push({ id: localId, name: "%widthKeys", type: DYN, mutable: false });
      const boxed: IrExpr =
        segment.value.type.kind === "dyn"
          ? segment.value
          : { kind: "dynFrom", value: segment.value, liveRef: true, type: DYN, loc };
      const at = wrapper.stmts.findIndex(
        (stmt) => stmt.kind === "varDecl" && stmt.localId === segment.value.localId,
      );
      wrapper.stmts.splice(at + 1, 0, {
        kind: "varDecl",
        localId,
        init: assign(empty(), boxed),
        loc,
      });
      mirror = assign(mirror, { kind: "varRef", localId, type: DYN, loc });
    }
    const builtId = `%widthKept.${site}`;
    fn.locals.push({ id: builtId, name: "%widthKept", type: literal.type, mutable: false });
    const built: IrExpr = { kind: "varRef", localId: builtId, type: literal.type, loc };
    wrapper.stmts.push(
      { kind: "varDecl", localId: builtId, init: literal, loc },
      {
        kind: "exprStmt",
        expr: { kind: "libCall", fn: "record.sourceNote", args: [built, mirror], type: VOID, loc },
        loc,
      },
    );
    wrapper.result = built;
  }
}

/** A read with no effect that answers the same value again right after
 * the copy: a binding, or a field or narrowed arm of one. */
function repeatable(e: IrExpr): boolean {
  return (
    e.kind === "varRef" ||
    ((e.kind === "unionNarrow" || e.kind === "downcast") && repeatable(e.value)) ||
    ((e.kind === "recordGet" || e.kind === "fieldGet") && repeatable(e.obj))
  );
}

/** The record a copy reads its source's fields from, when it can be read
 * again. */
function copyBinding(node: IrExpr, source: string): IrExpr | null {
  let found: IrExpr | null = null;
  const find = (e: IrExpr): boolean => {
    if (e.kind === "recordGet" && e.shapeId === source && repeatable(e.obj)) {
      found = e.obj;
      return false;
    }
    return everyExprChild(e, find, () => true);
  };
  find(node);
  return found;
}

/** The record types narrowed copies link to their sources into
 * (record-links.ts): a linked copy's own keys are its source's. */
function linkTargets(lowerer: Lowerer): Set<string> {
  const targets = new Set<string>();
  for (const link of lowerer.recordLinks.values()) targets.add(link.to);
  return targets;
}

/** `record.linked(value)`: whether the record links to the record it was
 * narrowed from. */
function recordLinkedTest(value: IrExpr, loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn: "record.linked", args: [value], type: BOOL, loc };
}

/** Whether the record `value` holds other own keys than its declared ones
 * in its table's order: it keeps a source, or, for a type narrowed copies
 * link into (`linked`), it links to the record it was narrowed from.
 * `value` builds the read anew for each use. */
function ownKeysTest(value: () => IrExpr, linked: boolean, loc: SrcLoc): IrExpr {
  const kept = recordSourceTest(value(), loc);
  if (!linked) return kept;
  return {
    kind: "logical",
    op: "||",
    left: kept,
    right: recordLinkedTest(value(), loc),
    type: BOOL,
    loc,
  };
}

/** A repeatable read again, as nodes of its own. */
function reread(e: IrExpr): IrExpr {
  if (e.kind === "unionNarrow") return { ...e, value: reread(e.value) };
  if (e.kind === "downcast") return { ...e, value: reread(e.value) };
  if (e.kind === "recordGet") return { ...e, obj: reread(e.obj) };
  if (e.kind === "fieldGet") return { ...e, obj: reread(e.obj) };
  if (e.kind === "varRef") return { ...e };
  return e;
}

/** What trackOrders reads from the pass that decided the tables. */
interface OrderFacts {
  /** A shape's table as the enumeration surfaces walk it, or null for a
   * shape without one (a tuple, an index signature, accessor slots). */
  tableOf: (shapeId: string) => string[] | null;
  /** Shapes with one table whose derivations hand kept key lists on. */
  carried: ReadonlySet<string>;
  /** Whether a value of the shape can keep a source. */
  sourced: (shapeId: string) => boolean;
  /** Whether the shape's values name their order by an index. */
  indexed: (shapeId: string) => boolean;
  /** Whether a value of the shape can lack the key. */
  absent: (shapeId: string, key: string) => boolean;
  /** Whether a value of the shape can be a copy linked to its source. */
  linked: (shapeId: string) => boolean;
}

/** Key orders kept per value. A record keeps the order its keys were
 * created in as its kept source when that is not its table's order (the
 * runtime decides, scr_record_source_note). Two kinds of shape note it:
 *
 *  - a tracked shape, whose constructions disagree on the order: every
 *    construction notes the order it created its keys in;
 *  - a carried shape, which has one table and derives values from records
 *    that can keep a source: only those derivations hand the list on.
 *
 * Per construction:
 *  - an object literal of explicit keys notes a placeholder per key, when
 *    its order is not the table's (tracked shapes only; a carried shape's
 *    table is its literals' order);
 *  - a literal that spreads values decides per value, when the spread runs.
 *    A value that keeps a source (record.sourceHas) has its own keys
 *    snapshot. One that keeps none holds its declared keys in its table's
 *    order, so the literal's order is known here: nothing is noted when
 *    that order is the table's whichever optional keys are present, and
 *    otherwise the list is built from placeholders, with a presence test
 *    for a key a later property can also create. A key that only this
 *    spread can create holds its place when the value lacks it: the record
 *    lacks it too, so it is no key until a write creates it, which moves it
 *    last;
 *  - a copy of another record's fields (a rest binding, a record
 *    conversion) takes its source's kept key list over the keys it declares
 *    (record.orderCarry), and a source that keeps none leaves it in the
 *    table's order. Only where the two tables disagree over the copy's keys
 *    does such a copy note the source's table;
 *  - a clone keeps its source's keys, then its overrides (keepRecordClones).
 * A source whose order is an index, or whose type has no table, is read
 * through its checked view instead.
 *
 * A tracked shape with a construction that cannot note its order (a spread
 * whose value has no binding or no checked view) is left out of the tracked
 * set and keeps today's table for every value. */
function trackOrders(
  lowerer: Lowerer,
  fns: readonly IrFunction[],
  noted: ReadonlySet<IrExpr>,
  firstClone: number,
  orders: OrderFacts,
): Map<string, { loc: SrcLoc; cause: UntrackedCause }> {
  const notes = lowerer.keyOrder;
  const tracked = notes.tracked;
  const { carried, sourced, indexed } = orders;
  /** The shapes left out, with the construction that cannot note its
   * order. */
  const untracked = new Map<string, { loc: SrcLoc; cause: UntrackedCause }>();
  type Wrapper = IrExpr & { kind: "seqExpr" };
  interface Site {
    node: IrExpr & { kind: "recordLit" };
    fn: IrFunction;
    wrapper: Wrapper | null;
  }
  const sites: Site[] = [];
  const clones: { node: IrExpr; fn: IrFunction }[] = [];
  const wrappers = new Map<IrExpr, Wrapper>();
  let current: IrFunction | null = null;
  const visit = (e: IrExpr): boolean => {
    if (e.kind === "seqExpr" && e.result.kind === "recordLit") wrappers.set(e.result, e);
    if (
      (e.kind === "recordLit" || e.kind === "recordClone") &&
      e.type.kind === "record" &&
      (tracked.has(e.type.shapeId) || carried.has(e.type.shapeId)) &&
      !noted.has(e)
    ) {
      if (e.kind === "recordClone") clones.push({ node: e, fn: current! });
      else sites.push({ node: e, fn: current!, wrapper: wrappers.get(e) ?? null });
    }
    return everyExprChild(e, visit, visitStmt);
  };
  const visitStmt = (st: IrStmt): boolean => everyStmtChild(st, visit, visitStmt);
  for (const fn of fns) {
    current = fn;
    for (const st of fn.body) visitStmt(st);
  }
  const shapeOf = (site: Site): string => (site.node.type as IrType & { kind: "record" }).shapeId;
  const viewable = (type: IrType): boolean => type.kind === "dyn" || lowerer.dynConvertible(type);
  const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
    a.join("\0") === b.join("\0");

  /** One value a literal spreads, as its order is read. */
  interface SpreadPlan {
    value: IrExpr & { kind: "varRef" };
    /** Read through a snapshot of its checked view whatever it holds: its
     * keys are a run-time fact (a dictionary, a dynamic value), or its
     * order is an index. Otherwise the fields below describe a record of
     * shape `shapeId`. */
    dynamic: boolean;
    shapeId: string;
    /** Whether the value is that record, when its type is a union that
     * also holds other arms (`...options` of `T | undefined`); null when
     * it always is. */
    isRecord: (() => IrExpr) | null;
    record: () => IrExpr;
    /** Whether the record can keep a source. */
    sourced: boolean;
    /** Whether the record can be a copy linked to its source. */
    linked: boolean;
    /** The keys the literal can take from a record that keeps no source,
     * in the record's table order. */
    occurrences: Occurrence[];
  }
  /** One key a spread can create. */
  interface Occurrence {
    key: string;
    /** The value has the key: null when it always does. */
    present: (() => IrExpr) | null;
    /** Whether a later property can create the key when this one does
     * not. */
    later: boolean;
  }
  /** One property of a literal: the key it writes, or the spread of
   * `spreads[spread]` when `key` is null. */
  interface Item {
    key: string | null;
    spread: number;
  }
  type Plan =
    /** A literal of explicit keys in another order than the table's. */
    | { kind: "explicit"; names: string[] }
    /** A literal that spreads values. `inTable`: every order it can create
     * from values that keep no source is the table's. `items` lists its
     * properties in order. */
    | { kind: "spreads"; spreads: SpreadPlan[]; items: Item[]; inTable: boolean }
    /** A copy of the record `binding`. `view`: read through a snapshot of
     * the source's checked view. `mirror`: the source's table over the
     * copy's keys, where it is not the copy's table. */
    | {
        kind: "copy";
        binding: IrExpr | null;
        view: boolean;
        carry: boolean;
        linked: boolean;
        mirror: string[] | null;
      };

  /** A spread segment's plan, or null when the value cannot be read when
   * the spread runs. */
  const spreadPlan = (
    site: Site,
    segment: KeyOrderSegment & { kind: "spread" | "opaque" },
  ): SpreadPlan | null => {
    const value = segment.value;
    if (value === undefined || site.wrapper === null) return null;
    if (!site.wrapper.stmts.some((st) => st.kind === "varDecl" && st.localId === value.localId))
      return null;
    const loc = site.node.loc;
    const dynamic: SpreadPlan = {
      value,
      dynamic: true,
      shapeId: "",
      isRecord: null,
      record: () => ({ ...value }),
      sourced: true,
      linked: false,
      occurrences: [],
    };
    if (segment.kind === "opaque") return viewable(value.type) ? dynamic : null;
    const shapeId = segment.shapeId;
    const type = value.type;
    if (indexed(shapeId) || orders.tableOf(shapeId) === null)
      return viewable(type) ? dynamic : null;
    const keeps = sourced(shapeId);
    // A snapshot is taken of a value that keeps a source.
    if (keeps && !viewable(type)) return null;
    if (type.kind === "record" && type.shapeId === shapeId)
      return {
        value,
        dynamic: false,
        shapeId,
        isRecord: null,
        record: () => ({ ...value }),
        sourced: keeps,
        linked: orders.linked(shapeId),
        occurrences: [],
      };
    if (type.kind === "union") {
      const unionId = type.unionId;
      const arm: IrType = { kind: "record", shapeId };
      const tag = lowerer.armTag(unionId, arm);
      if (tag >= 0)
        return {
          value,
          dynamic: false,
          shapeId,
          isRecord: () => ({
            kind: "unionIsTag",
            unionId,
            tag,
            negated: false,
            value: { ...value },
            type: BOOL,
            loc,
          }),
          record: () => ({
            kind: "unionNarrow",
            unionId,
            tag,
            value: { ...value },
            type: arm,
            loc,
          }),
          sourced: keeps,
          linked: orders.linked(shapeId),
          occurrences: [],
        };
    }
    return viewable(type) ? dynamic : null;
  };

  /** What the site notes: null when it cannot, false when it has nothing
   * to note. */
  const planOf = (site: Site): Plan | false | null => {
    const id = shapeOf(site);
    const table = orders.tableOf(id) ?? [];
    const segments = notes.literalOf(site.node);
    if (segments !== undefined) {
      const loc = site.node.loc;
      const spreads: SpreadPlan[] = [];
      const items: Item[] = [];
      const declared = new Set(table);
      /** Keys an earlier property certainly created. */
      const settled = new Set<string>();
      // The positions a key can be created at, counted over the literal's
      // properties and the keys of each spread value in its table's order:
      // the first and the last, and the last spread occurrence so far.
      let position = 0;
      const first = new Map<string, number>();
      const last = new Map<string, number>();
      const open = new Map<string, Occurrence>();
      const place = (key: string): void => {
        const before = open.get(key);
        if (before !== undefined) before.later = true;
        if (!first.has(key)) first.set(key, position);
        last.set(key, position++);
      };
      for (const segment of segments) {
        if (segment.kind === "key") {
          if (!declared.has(segment.name) || settled.has(segment.name)) continue;
          // A key a conditional spread may leave out holds its place.
          settled.add(segment.name);
          place(segment.name);
          items.push({ key: segment.name, spread: -1 });
          continue;
        }
        const plan = spreadPlan(site, segment);
        if (plan === null) return null;
        items.push({ key: null, spread: spreads.push(plan) - 1 });
        if (plan.dynamic) continue;
        const isRecord = plan.isRecord;
        for (const key of orders.tableOf(plan.shapeId)!) {
          if (!declared.has(key) || settled.has(key)) continue;
          const has = lowerer.recordFieldPresent(plan.record(), plan.shapeId, key, loc);
          // A key no construction leaves out is always there.
          const always = (has.kind === "boolLit" && has.value) || !orders.absent(plan.shapeId, key);
          place(key);
          if (always && isRecord === null) {
            settled.add(key);
            plan.occurrences.push({ key, present: null, later: false });
            continue;
          }
          const occurrence: Occurrence = {
            key,
            present: () => {
              const test = lowerer.recordFieldPresent(plan.record(), plan.shapeId, key, loc);
              if (isRecord === null) return test;
              if (always) return isRecord();
              return { kind: "logical", op: "&&", left: isRecord(), right: test, type: BOOL, loc };
            },
            later: false,
          };
          open.set(key, occurrence);
          plan.occurrences.push(occurrence);
        }
      }
      if (spreads.length === 0) {
        if (!tracked.has(id)) return false;
        const names: string[] = [];
        for (const item of items) if (item.key !== null) names.push(item.key);
        const written = new Set(names);
        return sameOrder(
          table.filter((k) => written.has(k)),
          names.filter((k) => declared.has(k)),
        )
          ? false
          : { kind: "explicit", names };
      }
      // A value read through its view: the literal notes what it finds.
      if (spreads.some((spread) => spread.dynamic))
        return { kind: "spreads", spreads, items, inTable: false };
      // The orders values without a source can create. A key takes the
      // position of the first property that creates it, so the literal is
      // in the table's order whichever those are when, walking the table,
      // every position a key can take comes after every position of the
      // keys before it.
      let inTable = true;
      let reached = -1;
      for (const key of table) {
        const from = first.get(key);
        if (from === undefined) continue;
        if (from < reached) inTable = false;
        reached = Math.max(reached, last.get(key)!);
      }
      if (inTable && !spreads.some((spread) => spread.sourced)) return false;
      return { kind: "spreads", spreads, items, inTable };
    }
    const source = notes.copyOf(site.node);
    if (source === undefined) return false;
    // A copy that holds one key or none has no order to keep.
    const held = site.node.fields
      .filter((field) => field.value.kind !== "fieldAbsent")
      .map((field) => field.name);
    if (held.length < 2) return false;
    // A copy linked to its source (record-links.ts) answers its reflective
    // surfaces from the source record, in the source's own order.
    if (lowerer.recordLinks.has(`${source}:${id}`)) return false;
    const binding = copyBinding(site.node, source);
    const from = orders.tableOf(source);
    if (indexed(source) || from === null)
      return binding !== null && viewable(binding.type)
        ? { kind: "copy", binding, view: true, carry: false, linked: false, mirror: null }
        : null;
    const keys = new Set(held);
    const order = from.filter((k) => keys.has(k));
    const mirror = sameOrder(
      order,
      table.filter((k) => keys.has(k)),
    )
      ? null
      : order;
    const carry = sourced(source);
    if (!carry && mirror === null) return false;
    if (carry && binding === null) return null;
    // A linked source's own keys are read through its checked view.
    const viaLink = carry && orders.linked(source);
    if (viaLink && !viewable(binding!.type)) return null;
    return { kind: "copy", binding, view: false, carry, linked: viaLink, mirror };
  };
  const plans = new Map<Site, Plan>();
  for (const site of sites) {
    const plan = planOf(site);
    if (plan === false) continue;
    if (plan !== null) {
      plans.set(site, plan);
      continue;
    }
    // A carried shape resolved because each of its derivations can hand
    // its source's list on, so only a tracked shape gets here.
    tracked.delete(shapeOf(site));
    const cause = notes.literalOf(site.node) !== undefined ? "spread" : "copy";
    if (!untracked.has(shapeOf(site))) untracked.set(shapeOf(site), { loc: site.node.loc, cause });
  }
  let index = 0;
  const byFn = new Map<IrFunction, Map<IrExpr, IrExpr>>();
  type LibFn = (IrExpr & { kind: "libCall" })["fn"];
  const call = (fn: LibFn, args: IrExpr[], type: IrType, loc: SrcLoc): IrExpr => ({
    kind: "libCall",
    fn,
    args,
    type,
    loc,
  });
  const emptyKeys = (loc: SrcLoc): IrExpr => ({ kind: "dynObjLit", fields: [], type: DYN, loc });
  const placeholders = (names: readonly string[], loc: SrcLoc): IrExpr => ({
    kind: "dynObjLit",
    fields: names.map((name) => ({ key: strLit(name, loc), value: dynUndefinedExpr(loc) })),
    type: DYN,
    loc,
  });
  /** A fresh object holding the value's own keys, in its own order. */
  const snapshot = (value: IrExpr, loc: SrcLoc): IrExpr =>
    call(
      "dyn.assign",
      [
        emptyKeys(loc),
        value.type.kind === "dyn"
          ? value
          : { kind: "dynFrom", value, liveRef: true, type: DYN, loc },
      ],
      DYN,
      loc,
    );
  const either = (tests: readonly IrExpr[], loc: SrcLoc): IrExpr =>
    tests.reduce((left, right) => ({ kind: "logical", op: "||", left, right, type: BOOL, loc }));
  for (const [site, plan] of plans) {
    if (!tracked.has(shapeOf(site)) && !carried.has(shapeOf(site))) continue;
    const { node, fn, wrapper } = site;
    const loc = node.loc;
    const n = index++;
    const builtId = `%orderKept.${n}`;
    fn.locals.push({ id: builtId, name: "%orderKept", type: node.type, mutable: false });
    const built: IrExpr = { kind: "varRef", localId: builtId, type: node.type, loc };
    const note = (keys: IrExpr): IrStmt => ({
      kind: "exprStmt",
      expr: call("record.sourceNote", [built, keys], VOID, loc),
      loc,
    });
    let noteStmt: IrStmt;
    if (plan.kind === "copy") {
      const binding = plan.binding;
      if (plan.view) {
        noteStmt = {
          kind: "exprStmt",
          expr: call("record.orderCopy", [built, snapshot(reread(binding!), loc)], VOID, loc),
          loc,
        };
      } else {
        const carry: IrStmt | null = plan.carry
          ? {
              kind: "exprStmt",
              expr: call("record.orderCarry", [built, reread(binding!)], VOID, loc),
              loc,
            }
          : null;
        const mirror = plan.mirror === null ? null : note(placeholders(plan.mirror, loc));
        // A source that keeps a key list hands it on; one that keeps none
        // is in its table's order, which the copy notes where its own
        // table differs.
        let plain: IrStmt =
          carry !== null && mirror !== null
            ? {
                kind: "if",
                cond: recordSourceTest(reread(binding!), loc),
                then: [carry],
                else_: [mirror],
                loc,
              }
            : (carry ?? mirror!);
        // A source that links to the record it was narrowed from holds that
        // record's keys, in its order.
        if (plan.linked)
          plain = {
            kind: "if",
            cond: recordLinkedTest(reread(binding!), loc),
            then: [
              {
                kind: "exprStmt",
                expr: call("record.orderCopy", [built, snapshot(reread(binding!), loc)], VOID, loc),
                loc,
              },
            ],
            else_: [plain],
            loc,
          };
        noteStmt = plain;
      }
    } else if (plan.kind === "explicit") {
      noteStmt = note(placeholders(plan.names, loc));
    } else {
      const { spreads, items } = plan;
      const viewed = spreads.some((spread) => spread.dynamic);
      /** Declares `init` right after the literal evaluated spread `at`'s
       * value: a later property may change the value. */
      const declared = spreads.map(() => 0);
      const declare = (at: number, name: string, type: IrType, init: IrExpr): (() => IrExpr) => {
        const localId = `%${name}.${n}.${at}.${declared[at]!}`;
        fn.locals.push({ id: localId, name: `%${name}`, type, mutable: false });
        const value = spreads[at]!.value;
        const from = wrapper!.stmts.findIndex(
          (st) => st.kind === "varDecl" && st.localId === value.localId,
        );
        const offset = declared[at]! + 1;
        declared[at] = offset;
        wrapper!.stmts.splice(from + offset, 0, { kind: "varDecl", localId, init, loc });
        return () => ({ kind: "varRef", localId, type, loc });
      };
      // The keys in creation order: runs of placeholders, a tested
      // placeholder for a key a later property can also create, and a
      // snapshot in place of a spread value's keys when it keeps a source.
      /** A run of placeholders (`names`), or an expression that answers
       * keys. */
      interface Part {
        names: string[];
        expr: IrExpr | null;
      }
      const fold = (parts: readonly Part[]): IrExpr => {
        let out: IrExpr | null = null;
        for (const part of parts) {
          const keys = part.expr ?? placeholders(part.names, loc);
          out =
            out === null && part.expr === null
              ? keys
              : call("dyn.assign", [out ?? emptyKeys(loc), keys], DYN, loc);
        }
        return out ?? emptyKeys(loc);
      };
      const push = (parts: Part[], name: string): void => {
        const run = parts[parts.length - 1];
        if (run !== undefined && run.expr === null) run.names.push(name);
        else parts.push({ names: [name], expr: null });
      };
      const parts: Part[] = [];
      /** Whether a spread value keeps a source, per value that can. */
      const owns: (() => IrExpr)[] = [];
      for (const { key, spread: at } of items) {
        if (key !== null) {
          push(parts, key);
          continue;
        }
        const spread = spreads[at]!;
        // A value read through its view is snapshot whatever it holds, and
        // so is every other value of such a literal.
        if (viewed) {
          parts.push({
            names: [],
            expr: declare(at, "orderKeys", DYN, snapshot({ ...spread.value }, loc))(),
          });
          continue;
        }
        // A record that keeps no source: its declared keys in its table's
        // order, each tested when the spread runs if a later property can
        // create it too.
        const plain: Part[] = [];
        for (const occurrence of spread.occurrences) {
          if (occurrence.present === null || !occurrence.later) {
            push(plain, occurrence.key);
            continue;
          }
          plain.push({
            names: [],
            expr: {
              kind: "ternary",
              cond: declare(at, "orderHas", BOOL, occurrence.present())(),
              then: placeholders([occurrence.key], loc),
              else_: emptyKeys(loc),
              type: DYN,
              loc,
            },
          });
        }
        if (!spread.sourced) {
          for (const part of plain) {
            if (part.expr === null) for (const name of part.names) push(parts, name);
            else parts.push(part);
          }
          continue;
        }
        // A record that keeps one: its own keys, snapshot as the spread
        // runs.
        const has = ownKeysTest(spread.record, spread.linked, loc);
        const isRecord = spread.isRecord;
        const own = declare(
          at,
          "orderOwn",
          BOOL,
          isRecord === null
            ? has
            : { kind: "logical", op: "&&", left: isRecord(), right: has, type: BOOL, loc },
        );
        owns.push(own);
        const keys = declare(at, "orderKeys", DYN, {
          kind: "ternary",
          cond: own(),
          then: snapshot({ ...spread.value }, loc),
          else_: dynUndefinedExpr(loc),
          type: DYN,
          loc,
        });
        parts.push({
          names: [],
          expr: { kind: "ternary", cond: own(), then: keys(), else_: fold(plain), type: DYN, loc },
        });
      }
      const mirror = fold(parts);
      // In the table's order unless a value keeps a source: noted only
      // then.
      noteStmt =
        plan.inTable && owns.length > 0
          ? {
              kind: "if",
              cond: either(
                owns.map((own) => own()),
                loc,
              ),
              then: [note(mirror)],
              else_: null,
              loc,
            }
          : note(mirror);
    }
    if (wrapper !== null) {
      wrapper.stmts.push({ kind: "varDecl", localId: builtId, init: node, loc }, noteStmt);
      wrapper.result = built;
    } else {
      // The sequence takes the literal's place, so it holds a node of its
      // own for it (the replacement is walked in turn).
      const moved: IrExpr = { ...node };
      notes.follow(node, moved);
      replacementsIn(byFn, fn).set(node, {
        kind: "seqExpr",
        stmts: [{ kind: "varDecl", localId: builtId, init: moved, loc }, noteStmt],
        result: built,
        type: node.type,
        loc,
      });
    }
  }
  for (const [fn, replacements] of byFn) replaceThroughParents(fn, replacements);
  const kept = new Set<IrExpr>();
  for (const { node } of clones)
    if (
      node.type.kind === "record" &&
      (tracked.has(node.type.shapeId) || carried.has(node.type.shapeId))
    )
      kept.add(node);
  keepRecordClones(lowerer, clones, kept, firstClone);
  return untracked;
}

/** Whether a value of this type reaches a record layout that holds a kept
 * source: a plain record a checked conversion builds or an earlier kept
 * copy's shape, or a union with such an arm. */
function reachesKeptSource(
  lowerer: Lowerer,
  type: IrType,
  converted: ReadonlySet<string>,
): boolean {
  if (type.kind === "record")
    return (
      recordMayKeepSource(lowerer, type) &&
      (converted.has(type.shapeId) || lowerer.keyOrder.keptSourceShapes.has(type.shapeId))
    );
  if (type.kind === "union")
    return (lowerer.unions.get(type.unionId)?.arms ?? []).some((arm) =>
      reachesKeptSource(lowerer, arm, converted),
    );
  return false;
}

/** Add the record shapes a checked conversion's target can hold a source
 * in: the target itself when it is a plain record, or the records nested in
 * a union arm, an array element, a promise or an index signature's values
 * (the layouts the checked builder notes sources for). */
function conversionShapes(
  lowerer: Lowerer,
  target: IrType,
  out: Set<string>,
  seen: Set<string>,
): void {
  if (target.kind === "promise") return conversionShapes(lowerer, target.inner, out, seen);
  if (target.kind === "array") return conversionShapes(lowerer, target.elem, out, seen);
  if (target.kind === "record") {
    if (seen.has(target.shapeId)) return;
    seen.add(target.shapeId);
    // A conversion builds the records of its nested fields too, each with
    // its own kept source.
    if (recordMayKeepSource(lowerer, target)) out.add(target.shapeId);
    const shape = lowerer.shapes.get(target.shapeId);
    for (const field of shape?.fields ?? []) conversionShapes(lowerer, field.type, out, seen);
    if (shape?.indexValue !== undefined) conversionShapes(lowerer, shape.indexValue, out, seen);
    return;
  }
  if (target.kind !== "union" || seen.has(target.unionId)) return;
  seen.add(target.unionId);
  for (const arm of lowerer.unions.get(target.unionId)?.arms ?? [])
    conversionShapes(lowerer, arm, out, seen);
}

/** `"k" in r` over a closed record answers statically false for a literal
 * key the shape does not declare. A kept source can hold it (a checked
 * conversion's undeclared keys, a width spread's extras), so when the
 * program keeps record sources the site answers through the record's own
 * kept view instead. The receiver evaluates exactly once, as the static
 * form evaluated it. */
function keepSourceProbes(
  lowerer: Lowerer,
  notes: KeyOrderNotes,
  sites: readonly { node: IrExpr; fn: IrFunction }[],
  possible: boolean,
): void {
  if (!possible) return;
  let index = 0;
  const byFn = new Map<IrFunction, Map<IrExpr, IrExpr>>();
  for (const { node, fn } of sites) {
    const probe = notes.sourceProbeOf(node);
    if (probe === undefined) continue;
    const recT = probe.receiver.type;
    if (recT.kind !== "record") continue;
    if (!recordMayKeepSource(lowerer, recT)) continue;
    const loc = node.loc;
    const id = `%inSource.${index++}`;
    fn.locals.push({ id, name: "%inSource", type: recT, mutable: false });
    const ref: IrExpr = { kind: "varRef", localId: id, type: recT, loc };
    const replacement: IrExpr = {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: id, init: probe.receiver, loc }],
      result: {
        kind: "logical",
        op: "&&",
        left: recordSourceTest(ref, loc),
        right: {
          kind: "dynHasKey",
          key: probe.key,
          value: { kind: "dynFrom", value: ref, liveRef: true, type: DYN, loc },
          type: BOOL,
          loc,
        },
        type: BOOL,
        loc,
      },
      type: BOOL,
      loc,
    };
    replacementsIn(byFn, fn).set(node, replacement);
  }
  for (const [fn, replacements] of byFn) replaceThroughParents(fn, replacements);
}

/** Same-shape `{ ...r, k: v }` clones: Node's copy holds every own key of
 * the source, and the recordClone fast path copies the declared fields
 * only. A clone over a shape that can keep a source, in a program that
 * keeps one, snapshots the source's own keys and notes them on the built
 * record; the overrides keep their source position (a placeholder for an
 * existing key keeps its place, a new one follows the source's keys). The
 * override values still evaluate after the source, as before.
 *
 * The snapshot is taken only for a source whose own keys the plain clone
 * would not reproduce, which the clone tests when it reads the source: a
 * record that keeps a source (record.sourceHas: undeclared keys, another
 * order, a view), a copy linked to the record it was narrowed from, whose
 * keys are that record's, or one that lacks a key an override creates,
 * which Node lists after the source's keys and the shape's table may list
 * earlier. Any other source holds exactly its declared keys in its own
 * order, every override replaces a key in place, and the clone copies
 * both. */
function keepRecordClones(
  lowerer: Lowerer,
  sites: readonly { node: IrExpr; fn: IrFunction }[],
  kept: ReadonlySet<IrExpr>,
  /** Where this call's hidden locals start numbering, and the clones it
   * builds in place of the ones it keeps. */
  first = 0,
  created?: Set<IrExpr>,
): void {
  let index = first;
  const links = linkTargets(lowerer);
  const keepers = new Map<string, boolean>();
  const byFn = new Map<IrFunction, Map<IrExpr, IrExpr>>();
  for (const { node, fn } of sites) {
    if (!kept.has(node) || node.kind !== "recordClone") continue;
    const cloneT = node.type;
    if (cloneT.kind !== "record") continue;
    let keeps = keepers.get(cloneT.shapeId);
    if (keeps === undefined) {
      keeps = recordMayKeepSource(lowerer, cloneT);
      keepers.set(cloneT.shapeId, keeps);
    }
    if (!keeps) continue;
    const loc = node.loc;
    const n = index++;
    const srcId = `%cloneSrc.${n}`;
    const ownId = `%cloneOwn.${n}`;
    const keysId = `%cloneKeys.${n}`;
    const builtId = `%cloneKept.${n}`;
    fn.locals.push({ id: srcId, name: "%cloneSrc", type: node.source.type, mutable: false });
    fn.locals.push({ id: ownId, name: "%cloneOwn", type: BOOL, mutable: false });
    fn.locals.push({ id: keysId, name: "%cloneKeys", type: DYN, mutable: false });
    fn.locals.push({ id: builtId, name: "%cloneKept", type: cloneT, mutable: false });
    const srcRef: IrExpr = { kind: "varRef", localId: srcId, type: node.source.type, loc };
    const assign = (target: IrExpr, from: IrExpr): IrExpr => ({
      kind: "libCall",
      fn: "dyn.assign",
      args: [target, from],
      type: DYN,
      loc,
    });
    const placeholder = (name: string): IrExpr => ({
      kind: "dynObjLit",
      fields: [{ key: strLit(name, loc), value: dynUndefinedExpr(loc) }],
      type: DYN,
      loc,
    });
    let mirror: IrExpr = { kind: "varRef", localId: keysId, type: DYN, loc };
    for (const override of node.overrides) mirror = assign(mirror, placeholder(override.name));
    const built: IrExpr = { kind: "varRef", localId: builtId, type: cloneT, loc };
    const overrides = node.overrides;
    // Whether the source's own keys are more than the plain clone copies.
    // Tested once, when the spread reads the source: an override's value
    // evaluates later and may change the source.
    let own: IrExpr = ownKeysTest(
      () => ({ kind: "varRef", localId: srcId, type: node.source.type, loc }),
      links.has(cloneT.shapeId),
      loc,
    );
    for (const override of overrides) {
      const present = lowerer.recordFieldPresent(srcRef, cloneT.shapeId, override.name, loc);
      if (present.kind === "boolLit" && present.value) continue;
      own = {
        kind: "logical",
        op: "||",
        left: own,
        right: { kind: "unary", op: "!", operand: present, type: BOOL, loc },
        type: BOOL,
        loc,
      };
    }
    const ownRef = (): IrExpr => ({ kind: "varRef", localId: ownId, type: BOOL, loc });
    const clone: IrExpr = { kind: "recordClone", source: srcRef, overrides, type: cloneT, loc };
    created?.add(clone);
    const replacement: IrExpr = {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: srcId, init: node.source, loc },
        { kind: "varDecl", localId: ownId, init: own, loc },
        {
          kind: "varDecl",
          localId: keysId,
          init: {
            kind: "ternary",
            cond: ownRef(),
            then: assign(
              { kind: "dynObjLit", fields: [], type: DYN, loc },
              {
                kind: "dynFrom",
                value: srcRef,
                liveRef: true,
                type: DYN,
                loc,
              },
            ),
            else_: dynUndefinedExpr(loc),
            type: DYN,
            loc,
          },
          loc,
        },
        {
          kind: "varDecl",
          localId: builtId,
          init: clone,
          loc,
        },
        {
          kind: "if",
          cond: ownRef(),
          then: [
            {
              kind: "exprStmt",
              expr: {
                kind: "libCall",
                fn: "record.sourceNote",
                args: [built, mirror],
                type: VOID,
                loc,
              },
              loc,
            },
          ],
          else_: null,
          loc,
        },
      ],
      result: built,
      type: cloneT,
      loc,
    };
    replacementsIn(byFn, fn).set(node, replacement);
  }
  for (const [fn, replacements] of byFn) replaceThroughParents(fn, replacements);
}
