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
 *    also build takes the literals' order. Their order is unknown, so a
 *    copy out of such a shape cannot be ordered statically. A conversion
 *    builds only the records it can create from a JavaScript value: none
 *    for a boxed primitive or a class instance (a native instance whose
 *    fields its own writes fill), none for a checked function's record
 *    parameters, and none for the checked result of a typed call of a
 *    method the program may replace on its instance. Without a replacement
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
 * value: that shape, and every shape copied from it, keeps today's table
 * (and today's SC6002 warnings). Shapes that no order surface observes
 * keep today's table too. */
import type { IrExpr, IrFunction, IrRecordShape, IrStmt, IrType, SrcLoc } from "../../ir/ir.js";
import {
  BOOL,
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
import { recordMayKeepSource } from "./record-sources.js";

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
  /** A spread whose keys are only known at run time. */
  | { kind: "opaque" };

/** Witness notes the lowering attaches to the IR nodes it builds. Keyed by
 * node identity, so nodes a speculative lowering discards are never walked.
 * Literals the IR rewriters rebuild (traverse.ts mapExprChildren) carry
 * their notes over (follow); a node rebuilt any other way falls back to
 * pinning. */
export class KeyOrderNotes {
  private readonly literals = new Map<IrExpr, KeyOrderSegment[]>();
  private readonly copies = new Map<IrExpr, string>();
  private readonly methodResults = new Map<IrExpr, string>();
  /** Shapes a frontend order surface (keys, values/entries, inspect,
   * index-signature merges) walks. */
  readonly observed = new Set<string>();
  /** Shapes whose table this pass replaced. */
  readonly changed = new Set<string>();

  literal(node: IrExpr, segments: KeyOrderSegment[]): IrExpr {
    this.literals.set(node, segments);
    return node;
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
  copies: { source: string; keys: Set<string> }[];
  /** A construction in today's order (synthesized literal). */
  pinned: boolean;
  /** An opaque runtime producer: today's order, any key may be absent. */
  opaque: boolean;
  /** A checked conversion from a dynamic value. */
  runtime: boolean;
  clones: boolean;
  present: Set<string>;
  absent: Set<string>;
  deleted: Set<string>;
  writes: WriteSite[];
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
        present: new Set(),
        absent: new Set(),
        deleted: new Set(),
        writes: [],
      };
      facts.set(shapeId, f);
    }
    return f;
  };
  const observedRoots: IrType[] = [];
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

  // ── collection ──────────────────────────────────────────────────────
  let pos = 0;
  let fnName = "";
  let currentFn: IrFunction | null = null;
  /** Literals that start by spreading a binding, by their witness: where
   * each one is built. A literal's notes are shared by its rebuilt copies,
   * so `literalSites` counts every literal of each witness. */
  const leadingSpreads = new Map<KeyOrderSegment[], LeadingSpread[]>();
  const literalSites = new Map<KeyOrderSegment[], number>();
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
    switch (e.kind) {
      case "recordLit": {
        if (e.type.kind !== "record") return;
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
        } else if (copy !== undefined) f.copies.push({ source: copy, keys: presentKeys });
        else f.pinned = true;
        return;
      }
      case "recordClone": {
        if (e.type.kind !== "record") return;
        const f = factsOf(e.type.shapeId);
        f.clones = true;
        for (const o of e.overrides)
          f.writes.push({ field: o.name, kind: "clone", fn: fnName, binding: null, loop: "", pos });
        return;
      }
      case "assignExpr":
        noteInit(e.localId, e.value);
        return;
      case "seqExpr": {
        // A spread literal evaluates its sources into bindings first.
        const literal = e.result;
        if (literal.kind !== "recordLit" || currentFn === null) return;
        const segments = notes.literalOf(literal);
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
      case "recordSet":
        if (st.value.kind === "fieldAbsent") factsOf(st.shapeId).deleted.add(st.field);
        factsOf(st.shapeId).writes.push({
          field: st.field,
          kind: st.value.kind === "fieldAbsent" ? "delete" : "write",
          fn: fnName,
          binding: bindingOf(st.obj),
          loop: loopKey(),
          pos,
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
  for (const id of opaqueShapes) {
    const f = factsOf(id);
    f.pinned = true;
    f.opaque = true;
  }
  for (const id of runtimeShapes) factsOf(id).runtime = true;
  for (const id of declaredShapes) if (!runtimeShapes.has(id)) factsOf(id).pinned = true;

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
  if (!interesting) return;

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
  const keepsSource = (shapeId: string): boolean =>
    recordMayKeepSource(lowerer, { kind: "record", shapeId });
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
      // source's table; the others carry their order over.
      const source = ordered && s === segments[0] ? raw(s.shapeId) : resolved(s.shapeId);
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

  /** Today's table with every witness edge applied, or "unknown". */
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
      ready.sort((a, b) => rank.get(a)! - rank.get(b)!);
      const k = ready.shift()!;
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
      (!f.runtime || orderedSpreads.has(segments)) &&
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
    // Clones copy their source's own key order, which a checked
    // conversion leaves unknown.
    if (f.runtime && f.clones) return "unknown";
    const keySet = new Set(table);
    const edges: [string, string][] = [];
    if (f.pinned) chain(table, edges);
    for (const segments of f.literals) {
      if (copiesItself(id, f, table, segments)) continue;
      const sequences = literalSequences(segments, keySet, current, raw);
      if (sequences === null) return "unknown";
      for (const seq of sequences) chain(seq, edges);
    }
    for (const c of f.copies) {
      const source = current(c.source);
      if (source === "unknown") return "unknown";
      chain(
        source.order.filter((k) => keySet.has(k) && c.keys.has(k)),
        edges,
      );
    }
    const cached = late.get(id);
    const lateFor = cached !== undefined ? cached : lateEdges(id, table);
    if (cached === undefined) late.set(id, lateFor);
    if (lateFor === "unknown") return "unknown";
    for (const edge of lateFor) edges.push(edge);
    return merge(table, edges);
  };
  /** A source's order as its copies see it: values of a shape built by a
   * checked conversion keep their source's own order. */
  const asSource = (id: string, resolved: Resolved): Resolved =>
    facts.get(id)?.runtime === true ? "unknown" : resolved;

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
    late.clear();
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
  // Ordered spreads join once their source resolves; each one can let its
  // own shape resolve, which a later spread of it needs.
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
      if (target.kind === "record") factsOf(target.shapeId).runtime = true;
      grew = true;
    }
    if (grew) resolveAll();
  }

  // ── observation ─────────────────────────────────────────────────────
  const observed = new Set<string>();
  const observedSeen = new Set<string>();
  for (const id of notes.observed)
    shapesIn({ kind: "record", shapeId: id }, observed, observedSeen);
  for (const root of observedRoots) shapesIn(root, observed, observedSeen);
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

  // ── apply ───────────────────────────────────────────────────────────
  for (const [id, resolved] of result) {
    if (resolved === "unknown" || !observed.has(id)) continue;
    const shape = shapes.get(id);
    if (!inScope(shape)) continue;
    const table = tableOf(shape);
    if (resolved.order.join("\0") === table.join("\0")) continue;
    shape.declaredOrder = [...shape.declaredOrder!.filter(isArrayIndex), ...resolved.order];
    notes.changed.add(id);
  }

  // Ordered spreads carry their source's order over (see above).
  let orderedResults = 0;
  const rewritten = new Set<IrExpr>();
  for (const [segments, sites] of leadingSpreads) {
    const first = segments[0];
    if (!orderedSpreads.has(segments) || first?.kind !== "spread" || first.value === undefined)
      continue;
    // A shape that did not resolve keeps today's table for every value.
    if (orderedTarget(sites) === null) continue;
    for (const { wrapper, literal, fn } of sites) {
      if (rewritten.has(wrapper)) continue;
      rewritten.add(wrapper);
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
      if (source === undefined || source === "unknown") ok = false;
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
      continue;
    }
    variants.set(id, mirrored);
    mirrors.set(id, template);
  }
  if (variants.size === 0) return;

  // Every construction of those shapes, to give each its order index. A
  // copy reads its source's index, so its source must be a plain binding.
  const sites = new Map<string, (IrExpr & { kind: "recordLit" })[]>();
  /** The statements a spread literal's sequence evaluates first: the
   * spread value's binding, then its fields. */
  const prologues = new Map<IrExpr, readonly IrStmt[]>();
  const siteOf = (e: IrExpr): boolean => {
    if (e.kind === "seqExpr" && e.result.kind === "recordLit") prologues.set(e.result, e.stmts);
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
  for (const fn of fns) {
    const before = new Set(prologues.keys());
    for (const st of fn.body) siteStmt(st);
    for (const lit of prologues.keys()) if (!before.has(lit)) owners.set(lit, fn);
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
  const dropped = new Set<string>();
  for (const [id, list] of sites) {
    for (const lit of list) {
      const index = orderIndex(id, lit);
      if (index === null || (typeof index === "number" && index < 0)) dropped.add(id);
      else plan.set(lit, index);
    }
  }
  // Write sites of keys that move: each reads and updates the value's
  // index before the write.
  const writeSites: { st: IrStmt & { kind: "recordSet" }; fn: IrFunction }[] = [];
  let writeFn: IrFunction | null = null;
  const writeExpr = (e: IrExpr): boolean => everyExprChild(e, writeExpr, writeOf);
  const writeOf = (st: IrStmt): boolean => {
    if (
      st.kind === "recordSet" &&
      st.value.kind !== "fieldAbsent" &&
      moves.get(st.shapeId)?.has(st.field)
    )
      writeSites.push({ st, fn: writeFn! });
    return everyStmtChild(st, writeExpr, writeOf);
  };
  for (const fn of fns) {
    writeFn = fn;
    for (const st of fn.body) writeOf(st);
  }
  // A shape whose copies cannot read their source keeps today's table, and
  // so do the shapes that mirror it.
  for (const [id, mirror] of mirrors) if (dropped.has(mirror.source)) dropped.add(id);
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
    if (dropped.has(st.shapeId)) continue;
    const transitions = moves.get(st.shapeId)!.get(st.field)!;
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
    const next = indexChain(current, transitions, loc);
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
    const update: IrStmt = {
      kind: "recordSet",
      obj,
      shapeId: st.shapeId,
      field: KEY_ORDER_FIELD,
      value: next,
      loc,
    };
    // The write becomes a block that moves the key first.
    const write: IrStmt = {
      kind: "recordSet",
      obj,
      shapeId: st.shapeId,
      field: st.field,
      value,
      loc,
    };
    const guard: IrStmt = { kind: "if", cond: absent, then: [update], else_: null, loc };
    const block: IrStmt = { kind: "block", body: [...prologue, guard, write], loc };
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
