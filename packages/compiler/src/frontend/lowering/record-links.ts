/* Links from narrowed record copies to their sources.
 *
 * TypeScript lets an object with more properties be assigned to a narrower
 * record type; Node keeps the one object. A conversion into a narrower
 * record type builds a copy with the declared fields, so when the source
 * type has properties the target lacks, the copy links to its source
 * (record.link, a native table entry released with the copy). Each such
 * (source type, target type) pair has a number and a compose helper that
 * answers a record of the source type from the copy and its source: the
 * copy's values for the fields both declare, the source's for the others.
 * A reflective surface over the target type (keys, for...in, `in`, the
 * own-key tests, string conversion, Object.values and Object.entries,
 * JSON, inspect and checked views) answers for a linked copy as it does
 * for the composed record, and for any other value as before. Only
 * conversions into a type such a surface can observe link their copies
 * (finalizeRecordLinks); programs without them are unchanged. */
import { varRef } from "../../ir/build.js";
import {
  BOOL,
  DYN,
  F64,
  KEY_ORDER_FIELD,
  STRING,
  arrayOf,
  type IrExpr,
  type IrFunction,
  type IrRecordLink,
  type IrStmt,
  type IrType,
  type SrcLoc,
  shapeKeyOrders,
  typeEquals,
  typeKey,
} from "../../ir/ir.js";
import { everyStmtList, transformStmtList } from "../../ir/traverse.js";
import { keyedHelperName } from "./stable-names.js";
import type { Lowerer } from "./lowerer.js";
import { recordHasOwnHelper, recordKeysArrayCall } from "./lower-calls.js";
import { callOwn, callOwnOrBuiltin } from "./record-inherited.js";
import { recordMayKeepSource } from "./record-sources.js";
import { inspectHelperCall } from "./lower-inspect.js";
import { InternalCompilerError } from "../../errors.js";
import { unsupportedDiag } from "../../diagnostics/diagnostic.js";

/** The link pair of a conversion from record type `from` into the record
 * type `to`, or null when the conversion keeps no link: the target is a
 * plain closed record and the source has a field it does not declare. */
export function recordLinkPair(
  lowerer: Lowerer,
  from: string,
  to: string,
  loc: SrcLoc,
): IrRecordLink | null {
  const key = `${from}:${to}`;
  const known = lowerer.recordLinks.get(key);
  if (known) return known;
  const source = lowerer.shapes.get(from);
  const target = lowerer.shapes.get(to);
  if (
    !source ||
    !target ||
    source.tuple ||
    target.tuple ||
    source.indexValue !== undefined ||
    target.indexValue !== undefined ||
    target.fields.length === 0 ||
    target.fields.some((field) => field.name.startsWith("%")) ||
    source.fields.some((field) => field.name.startsWith("%"))
  )
    return null;
  const declared = new Set(target.fields.map((field) => field.name));
  if (!source.fields.some((field) => !declared.has(field.name))) return null;
  // The surfaces route through the link helpers only for record types
  // that can carry a source.
  if (!recordMayKeepSource(lowerer, { kind: "record", shapeId: to })) return null;
  const compose = keyedHelperName(lowerer, "%rec.compose", `compose:${key}`);
  const link: IrRecordLink = { pair: lowerer.recordLinks.size + 1, from, to, compose };
  lowerer.recordLinks.set(key, link);
  lowerer.recordLinkLocs.set(compose, loc);
  return link;
}

/** Notes that the conversion helper `projection` builds copies of the
 * link's pair. finalizeRecordLinks makes it link each copy to its source
 * when a reflective surface can observe the copy's type. */
export function registerLinkSite(
  lowerer: Lowerer,
  link: IrRecordLink,
  projection: IrFunction,
): void {
  lowerer.recordLinkSites.push({ link, projection });
}

/** The links whose copies have record type `to`, in pair order. */
export function recordLinksInto(lowerer: Lowerer, to: string): IrRecordLink[] {
  return [...lowerer.recordLinks.values()].filter((link) => link.to === to);
}

/** `record.link(copy, source, pair)`. */
export function recordLinkCall(
  copy: IrExpr,
  source: IrExpr,
  link: IrRecordLink,
  loc: SrcLoc,
): IrExpr {
  return {
    kind: "libCall",
    fn: "record.link",
    args: [copy, source, { kind: "numLit", value: link.pair, type: F64, loc }],
    type: { kind: "void" },
    loc,
  };
}

/** `record.linkIs(copy, pair)`. */
export function recordLinkTest(copy: IrExpr, link: IrRecordLink, loc: SrcLoc): IrExpr {
  return {
    kind: "libCall",
    fn: "record.linkIs",
    args: [copy, { kind: "numLit", value: link.pair, type: F64, loc }],
    type: BOOL,
    loc,
  };
}

/** The record of the pair's source type composed from a copy that links
 * through it (record.linkIs held). */
export function composedRecord(copy: IrExpr, link: IrRecordLink, loc: SrcLoc): IrExpr {
  const fromT: IrType = { kind: "record", shapeId: link.from };
  return {
    kind: "call",
    callee: link.compose,
    args: [
      copy,
      {
        kind: "libCall",
        fn: "record.linkSource",
        args: [copy, { kind: "numLit", value: link.pair, type: F64, loc }],
        type: fromT,
        loc,
      },
    ],
    type: fromT,
    loc,
  };
}

/** What a registered helper answers about its record parameter (its first
 * one): Object.keys and for...in's key list, the own-key test with the
 * key `k.0` (hasOwnProperty, propertyIsEnumerable, Object.hasOwn, and `in`
 * for a key the type does not declare), ToString, ToPrimitive with the
 * default hint (`+`),
 * util.inspect (with the recursion `r.0` and depth budget `d.0`), or an
 * answer a finalizer of lowerer.linkedHelperFinalizers adds itself
 * (answerLinkedCopies; "custom"). */
export type LinkedHelperKind = "keys" | "hasOwn" | "string" | "primitive" | "inspect" | "custom";

/** A helper over a record type whose answer finalizeRecordLinks completes
 * once every conversion into the type is known. */
export interface LinkedHelper {
  readonly fn: IrFunction;
  readonly shapeId: string;
  readonly kind: LinkedHelperKind;
}

/** Registers `fn` (whose first parameter is a record of `shapeId`). */
export function registerLinkedHelper(
  lowerer: Lowerer,
  fn: IrFunction,
  shapeId: string,
  kind: LinkedHelperKind,
): void {
  lowerer.linkedHelpers.push({ fn, shapeId, kind });
}

/** Makes `fn` (whose first parameter is a record of `shapeId`) first
 * answer `answer(composed)` for each copy linked into the type, where
 * `composed` is the copy's composed record. Answers whether any link
 * targets the type. */
export function answerLinkedCopies(
  lowerer: Lowerer,
  fn: IrFunction,
  shapeId: string,
  answer: (composed: IrExpr & { kind: "varRef" }) => IrStmt[],
): boolean {
  const recordT: IrType & { kind: "record" } = { kind: "record", shapeId };
  const r = varRef(fn.params[0]!.localId, recordT, fn.loc);
  const prefix = linkedCopyBranches(lowerer, fn, r, shapeId, answer);
  if (prefix.length === 0) return false;
  fn.body = [...prefix, ...fn.body];
  return true;
}

/** For each link into `shapeId`, the statement of `fn` that answers
 * `answer(composed)` when `record` is a copy linked through it, with the
 * composed record in a hidden local. Empty when no link targets the type. */
export function linkedCopyBranches(
  lowerer: Lowerer,
  fn: IrFunction,
  record: IrExpr,
  shapeId: string,
  answer: (composed: IrExpr & { kind: "varRef" }) => IrStmt[],
): IrStmt[] {
  const loc = fn.loc;
  const branches: IrStmt[] = [];
  for (const link of recordLinksInto(lowerer, shapeId)) {
    const fromT: IrType & { kind: "record" } = { kind: "record", shapeId: link.from };
    // A chain of links can reach a pair again inside another branch.
    let local = `linked.${link.pair}`;
    if (fn.locals.some((l) => l.id === local)) local = `${local}.${fn.locals.length}`;
    fn.locals.push({ id: local, name: "linked", type: fromT, mutable: false });
    const composed = varRef(local, fromT, loc) as IrExpr & { kind: "varRef" };
    branches.push({
      kind: "if",
      cond: recordLinkTest(record, link, loc),
      then: [
        { kind: "varDecl", localId: local, init: composedRecord(record, link, loc), loc },
        ...answer(composed),
      ],
      else_: null,
      loc,
    });
  }
  return branches;
}

/** Completes the record links after lowering. Links whose copies no
 * reflective surface can observe are dropped (keepObservedLinks); the
 * conversions of the others link each copy, and each kept pair gets its
 * compose helper. A helper over a record type that kept links target
 * first answers for each linked copy as for its composed record, and a
 * helper over a record type whose values a checked conversion can build
 * with a kept source (scanModule) answers for such a record from its live
 * checked view. Every other helper keeps the body it was built with,
 * and string conversions through helpers left with no other answer return
 * to their plain form. Helpers this registers are completed too, and
 * method calls a link source shadows are refused. */
export function finalizeRecordLinks(lowerer: Lowerer, functions: IrFunction[]): void {
  if (lowerer.linkedHelpers.length === 0 && lowerer.recordLinks.size === 0) return;
  const lifted = lowerer.liftedFns.length;
  const scan = scanModule(lowerer, [...functions, ...lowerer.liftedFns]);
  const sourced = scan.sourced;
  keepObservedLinks(lowerer, scan.exposed);
  for (const site of lowerer.recordLinkSites)
    if (lowerer.recordLinks.has(`${site.link.from}:${site.link.to}`))
      linkCopies(site.projection, site.link);
  for (const link of lowerer.recordLinks.values()) addComposer(lowerer, link, sourced);
  refuseShadowedMethodCalls(lowerer);
  const answering = new Set<string>();
  for (let i = 0; i < lowerer.linkedHelpers.length; i++) {
    const helper = lowerer.linkedHelpers[i]!;
    if (helper.kind === "custom") continue;
    const recordT: IrType & { kind: "record" } = { kind: "record", shapeId: helper.shapeId };
    // util.inspect's helper tests a kept source itself.
    if (sourced.has(helper.shapeId) && helper.kind !== "inspect") {
      const loc = helper.fn.loc;
      const r = varRef(helper.fn.params[0]!.localId, recordT, loc);
      helper.fn.body = [sourcedAnswer(helper, r, loc), ...helper.fn.body];
      answering.add(helper.fn.name);
    }
    if (
      answerLinkedCopies(lowerer, helper.fn, helper.shapeId, (composed) =>
        linkedAnswer(lowerer, helper, composed, sourced, helper.fn.loc),
      )
    )
      answering.add(helper.fn.name);
  }
  for (const finalize of lowerer.linkedHelperFinalizers) finalize(sourced);
  // The module's functions already hold the helpers lifted before.
  functions.push(...lowerer.liftedFns.slice(lifted));
  restoreStringConversions(lowerer, functions, answering);
}

/** A call of an Object.prototype method by name on a record type runs
 * the built-in, but a linked copy whose source has an own property of
 * that name would run the source's: such calls are refused. */
function refuseShadowedMethodCalls(lowerer: Lowerer): void {
  for (const call of lowerer.recordMethodCalls) {
    for (const link of recordLinksInto(lowerer, call.shapeId)) {
      const source = lowerer.shapes.get(link.from);
      if (!source?.fields.some((field) => field.name === call.method)) continue;
      lowerer.pushDiag(
        unsupportedDiag(
          "SC1090",
          call.loc,
          `'${call.method}()' on a record converted from an object with its own '${call.method}' property`,
          `call the source object's '${call.method}' through its own type`,
        ),
      );
      break;
    }
  }
}

/** Puts each call of a %rec.string or %rec.primitive helper that answers
 * nothing but "[object Object]" (not in `answering`) back to the
 * conversion it replaced (StringFallback), and drops those helpers. */
function restoreStringConversions(
  lowerer: Lowerer,
  functions: IrFunction[],
  answering: ReadonlySet<string>,
): void {
  const restored = new Map(
    [...lowerer.recordStringFallbacks].filter(([helper]) => !answering.has(helper)),
  );
  if (restored.size === 0) return;
  for (const fn of functions) {
    const calls = !everyStmtList(fn.body, {
      stmt: () => true,
      expr: (e) => e.kind !== "call" || !restored.has(e.callee),
    });
    if (!calls) continue;
    fn.body = transformStmtList(fn.body, {
      stmt: (s) => s,
      expr: (e) => {
        const fallback = e.kind === "call" ? restored.get(e.callee) : undefined;
        return fallback !== undefined && e.kind === "call"
          ? stringFallback(fallback, e.args[0]!, e.loc)
          : e;
      },
    });
  }
  for (const list of [functions, lowerer.liftedFns])
    for (let i = list.length - 1; i >= 0; i--) if (restored.has(list[i]!.name)) list.splice(i, 1);
}

/** Makes the conversion helper `projection` (one `return <copy>`) link
 * the copy it builds to its source record, the helper's parameter. */
function linkCopies(projection: IrFunction, link: IrRecordLink): void {
  const ret = projection.body[0];
  if (projection.body.length !== 1 || ret?.kind !== "return" || ret.value === null)
    throw new InternalCompilerError("lowerer bug: a record projection is not one return");
  const loc = ret.loc;
  const copyT = projection.returnType;
  const param = projection.params[0]!;
  const built = varRef("built.0", copyT, loc);
  projection.locals.push({ id: "built.0", name: "built", type: copyT, mutable: false });
  projection.body = [
    { kind: "varDecl", localId: "built.0", init: ret.value, loc },
    {
      kind: "exprStmt",
      expr: recordLinkCall(built, varRef(param.localId, param.type, loc), link, loc),
      loc,
    },
    { kind: "return", value: built, loc },
  ];
}

/** Keeps the links whose copies a reflective surface can observe: the
 * record types of the registered helpers (keys, own-key tests, string
 * conversion, inspect, values and entries) and of Object.prototype method
 * calls by name, and every record type that values of the `exposed` types
 * can hold (JSON.stringify, checked views and the serializing library
 * calls convert those through per-type helpers; the fields of a class
 * instance's view are not followed). A kept link observes its
 * source type too, through the composed record. The other links are
 * dropped, so their conversions build plain copies. */
function keepObservedLinks(lowerer: Lowerer, exposed: readonly IrType[]): void {
  if (lowerer.recordLinks.size === 0) return;
  // A call of an Object.prototype method by name observes the type too
  // (refuseShadowedMethodCalls).
  const observed = new Set([
    ...lowerer.linkedHelpers.map((helper) => helper.shapeId),
    ...lowerer.recordMethodCalls.map((call) => call.shapeId),
  ]);
  const reached = new Set<string>();
  const visit = (t: IrType): void => {
    const key = typeKey(t);
    if (reached.has(key)) return;
    reached.add(key);
    switch (t.kind) {
      case "record": {
        observed.add(t.shapeId);
        const shape = lowerer.shapes.get(t.shapeId);
        for (const field of shape?.fields ?? []) visit(field.type);
        if (shape?.indexValue !== undefined) visit(shape.indexValue);
        break;
      }
      case "array":
      case "set":
        visit(t.elem);
        break;
      case "map":
        visit(t.key);
        visit(t.value);
        break;
      case "union":
        for (const arm of lowerer.unions.get(t.unionId)?.arms ?? []) visit(arm);
        break;
      case "promise":
        visit(t.inner);
        break;
      case "func":
        // A boxed function's results are boxed for its callers.
        visit(t.ret);
        break;
      default:
        break;
    }
  };
  for (const t of exposed) visit(t);
  for (let changed = true; changed;) {
    changed = false;
    for (const link of lowerer.recordLinks.values())
      if (observed.has(link.to) && !observed.has(link.from)) {
        observed.add(link.from);
        changed = true;
      }
  }
  for (const [key, link] of lowerer.recordLinks)
    if (!observed.has(link.to)) lowerer.recordLinks.delete(key);
}

/** Builds a link's compose helper once every link is known: a record of
 * the source type with the copy's values for the fields both types declare
 * and the source's for the others, created in the source type's first key
 * order. The source can itself carry other properties: a kept checked
 * source when its type is in `sourced` (record.sourceShare), and a
 * link of its own when the source type is the target of other links (a
 * copy converted again). The composed record keeps both. */
function addComposer(lowerer: Lowerer, link: IrRecordLink, sourced: ReadonlySet<string>): void {
  const loc = lowerer.recordLinkLocs.get(link.compose)!;
  const fromT: IrType & { kind: "record" } = { kind: "record", shapeId: link.from };
  const toT: IrType & { kind: "record" } = { kind: "record", shapeId: link.to };
  const sourceShape = lowerer.shapes.get(link.from)!;
  const targetShape = lowerer.shapes.get(link.to)!;
  const copy = varRef("copy.0", toT, loc);
  const source = varRef("source.0", fromT, loc);
  const composed = varRef("composed.0", fromT, loc);
  const fields = shapeKeyOrders(sourceShape)[0]!.map((name) => {
    const field = sourceShape.fields.find((f) => f.name === name)!;
    const own = targetShape.fields.find((f) => f.name === name);
    const [obj, shapeId] =
      own !== undefined && typeEquals(own.type, field.type) ? [copy, link.to] : [source, link.from];
    const read: IrExpr = { kind: "recordGet", obj, shapeId, field: name, type: field.type, loc };
    return { name, value: lowerer.presenceKeepingCopy(obj, shapeId, name, read, loc) };
  });
  // A source type written in several key orders records each value's order
  // in a hidden field: the composed record enumerates in the source's.
  if (sourceShape.fields.some((f) => f.name === KEY_ORDER_FIELD))
    fields.push({
      name: KEY_ORDER_FIELD,
      value: {
        kind: "recordGet",
        obj: source,
        shapeId: link.from,
        field: KEY_ORDER_FIELD,
        type: F64,
        loc,
      },
    });
  const body: IrStmt[] = [
    {
      kind: "varDecl",
      localId: "composed.0",
      init: { kind: "recordLit", fields, type: fromT, loc },
      loc,
    },
  ];
  if (sourced.has(link.from))
    body.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "record.sourceShare",
        args: [composed, source],
        type: { kind: "void" },
        loc,
      },
      loc,
    });
  for (const next of recordLinksInto(lowerer, link.from)) {
    const sourceOf: IrExpr = {
      kind: "libCall",
      fn: "record.linkSource",
      args: [source, { kind: "numLit", value: next.pair, type: F64, loc }],
      type: { kind: "record", shapeId: next.from },
      loc,
    };
    body.push({
      kind: "if",
      cond: recordLinkTest(source, next, loc),
      then: [{ kind: "exprStmt", expr: recordLinkCall(composed, sourceOf, next, loc), loc }],
      else_: null,
      loc,
    });
  }
  body.push({ kind: "return", value: composed, loc });
  lowerer.liftedFns.push({
    name: link.compose,
    params: [
      { localId: "copy.0", name: "copy", type: toT },
      { localId: "source.0", name: "source", type: fromT },
    ],
    returnType: fromT,
    locals: [
      { id: "copy.0", name: "copy", type: toT, mutable: false },
      { id: "source.0", name: "source", type: fromT, mutable: false },
      { id: "composed.0", name: "composed", type: fromT, mutable: false },
    ],
    body,
    loc,
  });
}

/** The library calls that serialize, inspect or box their arguments. */
const EXPOSING_LIB_CALLS = /^(json|insp|dyn|js)\.|^(child|process)\.send$/;

/** One walk over the module: the record types whose values can keep a
 * checked source (keptSourceTypes), and the types of the values it boxes
 * as checked values, serializes or inspects. */
function scanModule(
  lowerer: Lowerer,
  functions: readonly IrFunction[],
): { sourced: Set<string>; exposed: IrType[] } {
  const sourced = new Set<string>();
  const seen = new Set<string>();
  const exposed = new Map<string, IrType>();
  const expose = (t: IrType): void => {
    if (!exposed.has(typeKey(t))) exposed.set(typeKey(t), t);
  };
  const links = lowerer.recordLinks.size > 0;
  for (const fn of functions) {
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (e) => {
        if (e.kind === "dynCheck") keptSourceTypes(lowerer, e.type, sourced, seen);
        // A literal that starts with a spread of a record that kept a
        // source keeps one too, as does a width spread or clone the
        // key-order pass keeps (record.sourceNote).
        if (
          e.kind === "libCall" &&
          (e.fn === "record.sourceSpread" || e.fn === "record.sourceNote")
        ) {
          const built = e.args[0]?.type;
          if (built?.kind === "record" && recordMayKeepSource(lowerer, built))
            sourced.add(built.shapeId);
        }
        if (!links) return true;
        if (e.kind === "dynFrom") expose(e.value.type);
        if (e.kind === "jsonStringify") expose(e.value.type);
        if (e.kind === "libCall" && EXPOSING_LIB_CALLS.test(e.fn))
          for (const arg of e.args) expose(arg.type);
        return true;
      },
    });
  }
  return { sourced, exposed: [...exposed.values()] };
}

/** Adds to `out` the record types a checked conversion into `t` can build
 * with a kept source (recordMayKeepSource): `t` and the record types its
 * values hold. `seen` holds the type keys already walked. */
function keptSourceTypes(lowerer: Lowerer, t: IrType, out: Set<string>, seen: Set<string>): void {
  const key = typeKey(t);
  if (seen.has(key)) return;
  seen.add(key);
  switch (t.kind) {
    case "record": {
      if (recordMayKeepSource(lowerer, t)) out.add(t.shapeId);
      const shape = lowerer.shapes.get(t.shapeId);
      for (const field of shape?.fields ?? []) keptSourceTypes(lowerer, field.type, out, seen);
      if (shape?.indexValue !== undefined) keptSourceTypes(lowerer, shape.indexValue, out, seen);
      break;
    }
    case "array":
    case "set":
      keptSourceTypes(lowerer, t.elem, out, seen);
      break;
    case "map":
      keptSourceTypes(lowerer, t.key, out, seen);
      keptSourceTypes(lowerer, t.value, out, seen);
      break;
    case "union":
      for (const arm of lowerer.unions.get(t.unionId)?.arms ?? [])
        keptSourceTypes(lowerer, arm, out, seen);
      break;
    case "promise":
      keptSourceTypes(lowerer, t.inner, out, seen);
      break;
    default:
      break;
  }
}

/** The helper's answer for the record `composed` of a link's source type.
 * `sourced` holds the record types that can keep a checked source. */
function linkedAnswer(
  lowerer: Lowerer,
  helper: LinkedHelper,
  composed: IrExpr & { kind: "varRef" },
  sourced: ReadonlySet<string>,
  loc: SrcLoc,
): IrStmt[] {
  const source = (composed.type as IrType & { kind: "record" }).shapeId;
  const shape = lowerer.shapes.get(source)!;
  // A source type whose values can carry other properties (a copy linked
  // again, or a kept checked source) converts through its own helper when
  // it declares no method of its own for the conversion, so the method
  // those properties hold runs.
  const carries =
    sourced.has(source) || [...lowerer.recordLinks.values()].some((l) => l.to === source);
  const k = varRef("k.0", STRING, loc);
  switch (helper.kind) {
    case "keys":
      // The source type's helper, which answers for a composed record that
      // keeps a checked source or links further.
      return [
        {
          kind: "return",
          value: recordKeysArrayCall(
            lowerer,
            composed,
            composed.type as IrType & { kind: "record" },
            shape,
            loc,
          ),
          loc,
        },
      ];
    case "hasOwn":
      return [
        {
          kind: "return",
          value: {
            kind: "call",
            callee: recordHasOwnHelper(lowerer, source, loc),
            args: [composed, k],
            type: BOOL,
            loc,
          },
          loc,
        },
      ];
    case "string":
      if (carries && !shape.fields.some((f) => f.name === "toString"))
        return [{ kind: "return", value: sourceConversion(lowerer, "string", composed, loc), loc }];
      return [{ kind: "return", value: recordToString(lowerer, helper, composed, loc), loc }];
    case "custom":
      throw new InternalCompilerError(
        "lowerer bug: custom helpers answer linked copies themselves",
      );
    case "inspect":
      return [
        {
          kind: "return",
          value: inspectHelperCall(
            lowerer,
            composed,
            varRef("r.0", F64, loc),
            varRef("d.0", F64, loc),
            loc,
          ),
          loc,
        },
      ];
    case "primitive": {
      const valueOf = shape.fields.find((f) => f.name === "valueOf");
      if (valueOf === undefined || valueOf.type.kind !== "func")
        return [
          {
            kind: "return",
            value: carries
              ? sourceConversion(lowerer, "primitive", composed, loc)
              : recordToString(lowerer, helper, composed, loc),
            loc,
          },
        ];
      // ToPrimitive with the default hint calls an own valueOf first.
      const own: IrExpr = {
        kind: "recordGet",
        obj: composed,
        shapeId: source,
        field: "valueOf",
        type: valueOf.type,
        loc,
      };
      const value = callOwn(
        lowerer,
        declarerOf(helper.fn),
        own,
        [],
        valueOf.type.ret,
        "valueOf",
        loc,
      );
      // A primitive answer converts as ToString does; an object makes
      // ToPrimitive fall back to toString once valueOf has run.
      if (value.type.kind === "string") return [{ kind: "return", value, loc }];
      if (value.type.kind === "f64" || value.type.kind === "bool")
        return [
          { kind: "return", value: { kind: "toString", operand: value, type: STRING, loc }, loc },
        ];
      const fallback: IrStmt = {
        kind: "return",
        value: recordToString(lowerer, helper, composed, loc),
        loc,
      };
      if (OBJECT_KINDS.has(value.type.kind))
        return [{ kind: "exprStmt", expr: value, loc }, fallback];
      // Any other answer is tested once valueOf returns: null answers
      // "object" and is falsy, and every object is truthy.
      const boxed = lowerer.coerceToExpected(value, DYN);
      if (boxed.type.kind !== "dyn") return [{ kind: "exprStmt", expr: value, loc }, fallback];
      const resultId = declarerOf(helper.fn)("%valueOfResult", DYN);
      const result = varRef(resultId, DYN, loc);
      const typeOf: IrExpr = {
        kind: "libCall",
        fn: "dyn.typeof",
        args: [result],
        type: STRING,
        loc,
      };
      const typeIs = (name: string): IrExpr => ({
        kind: "strEq",
        negated: false,
        left: typeOf,
        right: { kind: "strLit", value: name, type: STRING, loc },
        type: BOOL,
        loc,
      });
      return [
        { kind: "varDecl", localId: resultId, init: boxed, loc },
        {
          kind: "if",
          cond: {
            kind: "logical",
            op: "||",
            left: typeIs("function"),
            right: {
              kind: "logical",
              op: "&&",
              left: typeIs("object"),
              right: { kind: "dynTest", test: "truthy", value: result, type: BOOL, loc },
              type: BOOL,
              loc,
            },
            type: BOOL,
            loc,
          },
          then: [fallback],
          else_: null,
          loc,
        },
        { kind: "return", value: { kind: "toString", operand: result, type: STRING, loc }, loc },
      ];
    }
  }
}

/** The IR type kinds whose values are always objects. */
const OBJECT_KINDS: ReadonlySet<string> = new Set([
  "record",
  "object",
  "array",
  "map",
  "set",
  "func",
  "promise",
]);

/** `%rec.<hint>.<n>(r)` over the source type of `composed`: ToString (or
 * ToPrimitive with the default hint) as the record's other properties
 * answer, for a copy linked again or a kept checked source, else as
 * recordToString does. finalizeRecordLinks adds the answers, and the
 * helper keeps its own conversion when none applies. */
function sourceConversion(
  lowerer: Lowerer,
  hint: "string" | "primitive",
  composed: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const recordT = composed.type as IrType & { kind: "record" };
  const key = `rec.${hint}.source:${recordT.shapeId}`;
  let name = lowerer.valueHelpers.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, `%rec.${hint}`, key);
    lowerer.valueHelpers.set(key, name);
    const fn: IrFunction = {
      name,
      params: [{ localId: "r.0", name: "r", type: recordT }],
      returnType: STRING,
      locals: [{ id: "r.0", name: "r", type: recordT, mutable: false }],
      body: [],
      loc,
    };
    const helper: LinkedHelper = { fn, shapeId: recordT.shapeId, kind: hint };
    const r = varRef("r.0", recordT, loc);
    fn.body = [{ kind: "return", value: recordToString(lowerer, helper, r, loc), loc }];
    lowerer.liftedFns.push(fn);
    registerLinkedHelper(lowerer, fn, recordT.shapeId, hint);
  }
  return { kind: "call", callee: name, args: [composed], type: STRING, loc };
}

/** ToString of the record `composed`: its own toString when it holds a
 * callable one, else Object.prototype's "[object Object]". */
function recordToString(
  lowerer: Lowerer,
  helper: LinkedHelper,
  composed: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const source = (composed.type as IrType & { kind: "record" }).shapeId;
  return callOwnOrBuiltin(
    lowerer,
    declarerOf(helper.fn),
    composed,
    source,
    "toString",
    [],
    STRING,
    "toString",
    loc,
  );
}

/** A hidden-local declarer for statements added to `fn`. */
function declarerOf(fn: IrFunction): (name: string, type: IrType) => string {
  return (name, type) => {
    const id = `${name}.${fn.locals.length}`;
    fn.locals.push({ id, name, type, mutable: false });
    return id;
  };
}

/** `if (record.sourceHas(r)) return <the live checked view's answer>`. */
function sourcedAnswer(helper: LinkedHelper, r: IrExpr, loc: SrcLoc): IrStmt {
  const view: IrExpr = { kind: "dynFrom", value: r, liveRef: true, type: DYN, loc };
  const k = varRef("k.0", STRING, loc);
  let answer: IrExpr;
  switch (helper.kind) {
    case "keys":
      answer = {
        kind: "libCall",
        fn: "dyn.objKeyStrings",
        args: [view],
        type: arrayOf(STRING),
        loc,
      };
      break;
    case "hasOwn":
      answer = {
        kind: "libCall",
        fn: "dyn.hasOwn",
        args: [view, k],
        type: BOOL,
        loc,
      };
      break;
    case "string":
      answer = { kind: "toString", operand: view, type: STRING, loc };
      break;
    case "inspect":
    case "custom":
      throw new InternalCompilerError(
        `lowerer bug: ${helper.kind} helpers test kept sources themselves`,
      );
    case "primitive":
      answer = {
        kind: "toString",
        operand: {
          kind: "libCall",
          fn: "dyn.add",
          args: [
            {
              kind: "dynFrom",
              value: { kind: "strLit", value: "", type: STRING, loc },
              type: DYN,
              loc,
            },
            view,
          ],
          type: DYN,
          loc,
        },
        type: STRING,
        loc,
      };
      break;
  }
  return {
    kind: "if",
    cond: { kind: "libCall", fn: "record.sourceHas", args: [r], type: BOOL, loc },
    then: [{ kind: "return", value: answer, loc }],
    else_: null,
    loc,
  };
}

/** `%rec.string.<n>(r)` (ToString) or `%rec.primitive.<n>(r)` (ToPrimitive
 * with the default hint, then ToString) of a record type whose values
 * answer Object.prototype.toString: "[object Object]", or for a linked
 * copy or a record with a kept source, what its source answers. When no
 * value of the type can answer otherwise, finalizeRecordLinks puts
 * `fallback`, the conversion without the helper, in the calls' place. */
export function recordStringCall(
  lowerer: Lowerer,
  record: IrExpr,
  hint: "string" | "primitive",
  loc: SrcLoc,
  fallback: StringFallback,
): IrExpr {
  const recordT = record.type as IrType & { kind: "record" };
  const key = `rec.${hint}:${recordT.shapeId}:${fallback}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, `%rec.${hint}`, key);
    lowerer.valueHelpers.set(key, helper);
    const fn: IrFunction = {
      name: helper,
      params: [{ localId: "r.0", name: "r", type: recordT }],
      returnType: STRING,
      locals: [{ id: "r.0", name: "r", type: recordT, mutable: false }],
      body: [
        {
          kind: "return",
          value: { kind: "strLit", value: "[object Object]", type: STRING, loc },
          loc,
        },
      ],
      loc,
    };
    lowerer.liftedFns.push(fn);
    registerLinkedHelper(lowerer, fn, recordT.shapeId, hint);
    lowerer.recordStringFallbacks.set(helper, fallback);
  }
  return { kind: "call", callee: helper, args: [record], type: STRING, loc };
}

/** The string conversion a %rec.string or %rec.primitive call replaces:
 * "[object Object]" without evaluating the record ("constant"), or the
 * backend's ToString of the record ("toString"). */
export type StringFallback = "constant" | "toString";

/** The conversion `fallback` of `record` at `loc`. */
function stringFallback(fallback: StringFallback, record: IrExpr, loc: SrcLoc): IrExpr {
  return fallback === "constant"
    ? { kind: "strLit", value: "[object Object]", type: STRING, loc }
    : { kind: "toString", operand: record, type: STRING, loc };
}
