/** Constructors that `return` a value.
 *
 * JavaScript's `new C()` answers the constructor's returned value when it
 * is an object (functions included) and the constructed `this` otherwise.
 * A primitive or bare return therefore keeps the ordinary lowering, which
 * evaluates the operand and drops it.
 *
 * A return whose value is an instance of the constructor's own class keeps
 * the class representation (`if (Single.instance) return
 * Single.instance;`). The return stores that instance in a per-class
 * result slot and every direct `new C()` takes it from there. Any other
 * object has no representation as a `C` instance and refuses at the return
 * statement, deferred to run time in JavaScript like other statement
 * fences. A JavaScript value that is an object only at run time (`any`)
 * is tested when it returns: a primitive answers the constructed
 * instance, an instance of the class takes the result slot, and any other
 * object refuses.
 *
 * `super()` from a subclass refuses: Node would rebind the subclass's
 * `this` to the returned instance. In JavaScript the refusal is a run-time
 * test after the call: an instance other than the subclass's own `this`
 * refuses, and the constructed instance itself (`return this.set(r, g,
 * b)`, where `set` answers `this`) continues. The same run-time test also
 * rejects a returned descendant that is not an instance: a subclass
 * constructor that returns anything other than an object or `undefined`
 * throws a TypeError (spec 10.2.2), where a base constructor ignores the
 * primitive. That TypeError covers every primitive, `null` included, and
 * is decided statically whenever the returned expression's type is one. */
import * as ts from "../ts7/adapter.js";
import { nodeThrowExpr, varRef } from "../../ir/build.js";
import {
  BOOL,
  DYN,
  type IrExpr,
  type IrGlobal,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  typeKey,
  VOID,
} from "../../ir/ir.js";
import { unsupportedDiag } from "../../diagnostics/diagnostic.js";
import { isJsSourceFile, locOf } from "../program.js";
import type { ClassInfo } from "./lower-classes.js";
import type { Lowerer } from "./lowerer.js";

type ReturnKind = "instance" | "object" | "mixed" | "primitive";

/** Node's TypeError for a derived constructor that returns a primitive. */
const DERIVED_PRIMITIVE_RETURN = "Derived constructors may only return object or undefined";

export interface ConstructorReturnPlan {
  /** Returns whose value may be an object, by kind. Primitive and `this`
   * returns are absent: they keep the ordinary lowering. */
  returns: Map<ts.ReturnStatement, ReturnKind>;
  /** The result slot (`C | undefined`), present when some return yields an
   * instance of the class itself. */
  slot: IrGlobal | null;
  /** Set by a derived constructor's return of a non-`undefined` primitive.
   * The TypeError is raised where the construction returns (spec 10.2.2
   * raises it in [[Construct]], so a `try` in the body cannot catch it). */
  primitiveFlag: IrGlobal | null;
}

const PRIMITIVE_FLAGS =
  ts.TypeFlags.Primitive | ts.TypeFlags.EnumLike | ts.TypeFlags.Void | ts.TypeFlags.Never;

/** Types whose values may be primitives or objects: open types, type
 * variables and intersections (a branded `string & { tag }` is a string). */
const OPEN_FLAGS =
  ts.TypeFlags.AnyOrUnknown | ts.TypeFlags.InstantiableNonPrimitive | ts.TypeFlags.Intersection;

function unparenthesized(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** Whether a value of this checker type can be an object: "never",
 * "always", or "maybe" (open types and primitive/object unions). */
function objectness(type: ts.Type): "never" | "always" | "maybe" {
  const parts = type.isUnionType() ? ts.constituentTypes(type) : [type];
  let primitive = false;
  let object = false;
  for (const part of parts) {
    if ((part.flags & OPEN_FLAGS) !== 0) return "maybe";
    if ((part.flags & PRIMITIVE_FLAGS) !== 0) primitive = true;
    else object = true;
  }
  if (!object) return "never";
  return primitive ? "maybe" : "always";
}

/** Whether every value of this checker type is JavaScript `undefined`
 * (`undefined`, `void`, `never`, or a union of those): the one primitive a
 * derived constructor may return. */
function alwaysUndefined(type: ts.Type): boolean {
  const parts = type.isUnionType() ? ts.constituentTypes(type) : [type];
  return parts.every(
    (part) =>
      (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0,
  );
}

/** `typeof <dyn>` comparing equal to `name` (`negated` inverts it). */
function dynTypeofIs(read: IrExpr, name: string, negated: boolean, loc: SrcLoc): IrExpr {
  return {
    kind: "strEq",
    negated,
    left: { kind: "libCall", fn: "dyn.typeof", args: [read], type: STRING, loc },
    right: { kind: "strLit", value: name, type: STRING, loc },
    type: BOOL,
    loc,
  };
}

/** The constructor's own `return <expr>` statements: nested functions,
 * arrows and classes have their own returns. */
function ownValueReturns(ctor: ts.ConstructorDeclaration): ts.ReturnStatement[] {
  const out: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLikeDeclaration(node)) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined) out.push(node);
    ts.forEachChild(node, visit);
  };
  if (ctor.body !== undefined) ts.forEachChild(ctor.body, visit);
  return out;
}

/** A return inside a `try` with a `finally` block: the finally block runs
 * after the result is stored and may throw past it. */
function insideFinallyTry(node: ts.Node, ctor: ts.ConstructorDeclaration): boolean {
  for (let p = node.parent; p !== undefined && p !== ctor; p = p.parent) {
    if (ts.isTryStatement(p) && p.finallyBlock !== undefined && !nodeWithin(node, p.finallyBlock))
      return true;
  }
  return false;
}

function nodeWithin(node: ts.Node, ancestor: ts.Node): boolean {
  return node.pos >= ancestor.pos && node.end <= ancestor.end;
}

function instanceType(info: ClassInfo): IrType {
  return { kind: "object", className: info.def.name };
}

function isInstanceOf(lowerer: Lowerer, info: ClassInfo, type: IrType | null): boolean {
  if (type === null) return false;
  if (type.kind === "object") return type.className === info.def.name;
  if (type.kind !== "union") return false;
  const arms = lowerer.unions.get(type.unionId)?.arms ?? [];
  return (
    arms.length === 2 &&
    arms.some((arm) => arm.kind === "object" && arm.className === info.def.name) &&
    arms.some((arm) => arm.kind === "undefinedT")
  );
}

/** Whether an expression always yields the receiver itself: `this`, or a
 * call `this.m(...)` / `super.m(...)` whose every implementation the
 * receiver can reach (the statically resolved method and, for `this`
 * calls, each subclass override) returns only `this`, a primitive, or
 * nothing (`return this.set(r, g, b)` with a chainable setter). Such a
 * return answers the constructed instance. Methods already being checked
 * count as returning `this` (their other returns decide). */
function returnsThis(
  lowerer: Lowerer,
  info: ClassInfo,
  node: ts.Expression,
  visiting: Set<ts.Node> = new Set(),
): boolean {
  let e = node;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e))
    e = e.expression;
  if (e.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (!ts.isCallExpression(e)) return false;
  const callee = unparenthesized(e.expression);
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.questionDotToken !== undefined ||
    !ts.isIdentifier(callee.name)
  )
    return false;
  const receiver = unparenthesized(callee.expression).kind;
  if (receiver !== ts.SyntaxKind.ThisKeyword && receiver !== ts.SyntaxKind.SuperKeyword)
    return false;
  const name = callee.name.text;
  const symbol = lowerer.checker.getSymbolAtLocation(callee.name);
  if (symbol === undefined) return false;
  const methods: ts.Node[] = [...symbol.declarations];
  if (receiver === ts.SyntaxKind.ThisKeyword) {
    const pending = [...info.subclasses];
    while (pending.length > 0) {
      const sub = pending.pop()!;
      pending.push(...sub.subclasses);
      for (const member of sub.decl?.members.nodes ?? []) {
        if (member.name === undefined || !ts.isIdentifier(member.name) || member.name.text !== name)
          continue;
        if (!ts.isMethodDeclaration(member)) return false;
        methods.push(member);
      }
    }
  }
  if (methods.length === 0) return false;
  for (const method of methods) {
    if (!ts.isMethodDeclaration(method) || method.body === undefined) return false;
    if (visiting.has(method)) continue;
    visiting.add(method);
    for (const ret of ownReturns(method.body)) {
      if (ret.expression === undefined) continue;
      if (objectness(lowerer.typeOf(ret.expression)) === "never") continue;
      if (!returnsThis(lowerer, info, ret.expression, visiting)) return false;
    }
  }
  return true;
}

/** A function body's own return statements (nested functions, arrows and
 * classes have their own). */
function ownReturns(body: ts.Node): ts.ReturnStatement[] {
  const out: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLikeDeclaration(node)) return;
    if (ts.isReturnStatement(node)) out.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}

export function constructorReturnPlan(
  lowerer: Lowerer,
  info: ClassInfo,
): ConstructorReturnPlan | null {
  const byClass = lowerer.constructorReturnPlans;
  const known = byClass.get(info.def.name);
  if (known !== undefined) return known;
  const ctor = info.ctor;
  let plan: ConstructorReturnPlan | null = null;
  if (ctor?.body !== undefined && info.decl !== null) {
    const returns = new Map<ts.ReturnStatement, ReturnKind>();
    for (const stmt of ownValueReturns(ctor)) {
      const value = unparenthesized(stmt.expression!);
      if (returnsThis(lowerer, info, value)) continue;
      const type = lowerer.typeOf(value);
      const shape = objectness(type);
      if (shape === "never") {
        // A derived constructor that returns a primitive throws a TypeError
        // (spec 10.2.2); `undefined` is the one allowed primitive, and a
        // base constructor ignores every primitive.
        if (info.base !== null && !alwaysUndefined(type)) returns.set(stmt, "primitive");
        continue;
      }
      // Local classes construct through their own environment, which has
      // no result slot.
      const instance =
        info.localClass === undefined &&
        !insideFinallyTry(stmt, ctor) &&
        isInstanceOf(lowerer, info, lowerer.mapTypeOf(type));
      returns.set(stmt, instance ? "instance" : shape === "always" ? "object" : "mixed");
    }
    if (returns.size > 0) {
      let slot: IrGlobal | null = null;
      // A JavaScript value typed only at run time may hold an instance of
      // the class too (`if (C.instance) return C.instance;`).
      const runtimeInstance =
        info.localClass === undefined &&
        isJsSourceFile(ts.getSourceFileOfNode(ctor)) &&
        [...returns].some(([stmt, kind]) => kind === "mixed" && !insideFinallyTry(stmt, ctor));
      if ([...returns.values()].includes("instance") || runtimeInstance) {
        slot = {
          id: `%g.${info.def.name}.%constructorResult`,
          name: `${info.def.name}.%constructorResult`,
          type: lowerer.withUndefinedArm(instanceType(info)),
          mutable: true,
        };
        lowerer.globalsList.push(slot);
      }
      let primitiveFlag: IrGlobal | null = null;
      const kinds = [...returns.values()];
      // A JavaScript `any` return may be a primitive at run time, and a
      // derived constructor's primitive return throws (see mayReturnPrimitive).
      const mayPrimitive =
        info.base !== null &&
        (kinds.includes("primitive") ||
          (kinds.includes("mixed") && isJsSourceFile(ts.getSourceFileOfNode(ctor))));
      if (mayPrimitive) {
        primitiveFlag = {
          id: `%g.${info.def.name}.%constructorPrimitive`,
          name: `${info.def.name}.%constructorPrimitive`,
          type: BOOL,
          mutable: true,
        };
        lowerer.globalsList.push(primitiveFlag);
      }
      plan = { returns, slot, primitiveFlag };
    }
  }
  byClass.set(info.def.name, plan);
  return plan;
}

function foreignObjectFeature(info: ClassInfo): string {
  const display = info.def.name.replace(/^%|^%m\d+\./, "");
  return `returning an object other than an instance of the class from a constructor (Node's 'new ${display}()' answers the returned object, which has no representation as a '${display}' instance)`;
}

/** `return <expr>` inside a class constructor whose value may be an
 * object. Null when the statement keeps the ordinary lowering. */
export function lowerConstructorReturn(lowerer: Lowerer, stmt: ts.ReturnStatement): IrStmt | null {
  const info = lowerer.currentClass;
  if (info === null || info.ctor === null || stmt.expression === undefined) return null;
  let fn: ts.Node | undefined = stmt.parent;
  while (fn !== undefined && !ts.isFunctionLike(fn) && !ts.isClassLikeDeclaration(fn))
    fn = fn.parent;
  if (fn !== info.ctor) return null;
  const plan = constructorReturnPlan(lowerer, info);
  const kind = plan?.returns.get(stmt);
  if (plan === null || kind === undefined) return null;
  const loc = locOf(stmt);
  if (kind === "instance") {
    const value = lowerer.coerceInto(
      stmt.expression,
      lowerer.lowerExpr(stmt.expression),
      plan.slot!.type,
    );
    return {
      kind: "block",
      body: [
        { kind: "assign", localId: plan.slot!.id, value, loc },
        { kind: "return", value: null, loc },
      ],
      loc,
    };
  }
  if (kind === "primitive") {
    return lowerDerivedPrimitiveReturn(lowerer, stmt, plan.primitiveFlag!, loc);
  }
  const feature = foreignObjectFeature(info);
  if (kind === "object" || !isJsSourceFile(ts.getSourceFileOfNode(stmt)))
    lowerer.unsupported("SC1090", stmt, feature);
  // A JavaScript value that is an object only sometimes: a primitive
  // still answers the constructed instance, an object refuses.
  const value = lowerer.coerceToExpected(lowerer.lowerExpr(stmt.expression), DYN);
  if (value.type.kind !== "dyn") lowerer.unsupported("SC1090", stmt, feature);
  const held = lowerer.declareHiddenLocal("%returned", DYN);
  const read = varRef(held.id, DYN, loc);
  const typeOf: IrExpr = { kind: "libCall", fn: "dyn.typeof", args: [read], type: STRING, loc };
  const typeIs = (name: string): IrExpr => ({
    kind: "strEq",
    negated: false,
    left: typeOf,
    right: { kind: "strLit", value: name, type: STRING, loc },
    type: BOOL,
    loc,
  });
  const diag = unsupportedDiag("SC1090", loc, feature);
  lowerer.runtimeFences.push(diag);
  const sf = ts.getSourceFileOfNode(stmt);
  const line = ts.getLineAndCharacterOfPosition(sf, loc.start).line + 1;
  return {
    kind: "block",
    body: [
      { kind: "varDecl", localId: held.id, init: value, loc },
      {
        kind: "if",
        // null answers "object" and is falsy; every object is truthy.
        cond: {
          kind: "logical",
          op: "||",
          left: typeIs("function"),
          right: {
            kind: "logical",
            op: "&&",
            left: typeIs("object"),
            right: lowerer.ensureBool(read, stmt.expression),
            type: BOOL,
            loc,
          },
          type: BOOL,
          loc,
        },
        then: [
          ...(plan.slot !== null && !insideFinallyTry(stmt, info.ctor)
            ? [
                {
                  kind: "if" as const,
                  cond: {
                    kind: "libCall" as const,
                    fn: "dyn.typedRefIs" as const,
                    args: [
                      read,
                      {
                        kind: "strLit" as const,
                        value: typeKey(instanceType(info)),
                        type: STRING,
                        loc,
                      },
                    ],
                    type: BOOL,
                    loc,
                  },
                  then: [
                    {
                      kind: "assign" as const,
                      localId: plan.slot.id,
                      value: lowerer.coerceToExpected(
                        lowerer.coerceToExpected(read, instanceType(info)),
                        plan.slot.type,
                      ),
                      loc,
                    },
                    { kind: "return" as const, value: null, loc },
                  ],
                  else_: null,
                  loc,
                },
              ]
            : []),
          {
            kind: "runtimeFence",
            code: diag.code,
            message: `${diag.message} [${diag.code} at ${loc.file}:${line}]`,
            loc,
          },
        ],
        else_: null,
        loc,
      },
      // A derived constructor's non-object result must be `undefined`; any
      // other primitive (null answers "object" here) throws once the
      // construction returns. A base constructor keeps the constructed
      // instance.
      ...(plan.primitiveFlag !== null && info.base !== null
        ? [
            {
              kind: "if" as const,
              cond: dynTypeofIs(read, "undefined", true, loc),
              then: [
                {
                  kind: "assign" as const,
                  localId: plan.primitiveFlag.id,
                  value: { kind: "boolLit" as const, value: true, type: BOOL, loc },
                  loc,
                },
              ],
              else_: null,
              loc,
            },
          ]
        : []),
      { kind: "return", value: null, loc },
    ],
    loc,
  };
}

/** `return <primitive>` in a derived constructor: the operand is evaluated
 * for its side effects, then a non-`undefined` value records the pending
 * TypeError and returns normally. The error is raised where the
 * construction returns, because [[Construct]] raises it there: a `try` or
 * `catch` inside the constructor body cannot observe it, and a `finally`
 * block still runs first. A base constructor's primitive return is
 * ignored, so only a derived class reaches this. */
function lowerDerivedPrimitiveReturn(
  lowerer: Lowerer,
  stmt: ts.ReturnStatement,
  flag: IrGlobal,
  loc: SrcLoc,
): IrStmt {
  const value = lowerer.coerceToExpected(lowerer.lowerExpr(stmt.expression!), DYN);
  const held = lowerer.declareHiddenLocal("%returned", DYN);
  const read = varRef(held.id, DYN, loc);
  return {
    kind: "block",
    body: [
      { kind: "varDecl", localId: held.id, init: value, loc },
      {
        kind: "if",
        cond: dynTypeofIs(read, "undefined", true, loc),
        then: [
          {
            kind: "assign",
            localId: flag.id,
            value: { kind: "boolLit", value: true, type: BOOL, loc },
            loc,
          },
        ],
        else_: null,
        loc,
      },
      { kind: "return", value: null, loc },
    ],
    loc,
  };
}

/** Whether this class's constructor may record a derived primitive return.
 * A cheap static filter: only these classes need the flag cleared on entry,
 * and only they pay for computing the whole plan before their body lowers. */
function mayReturnPrimitive(lowerer: Lowerer, info: ClassInfo): boolean {
  const ctor = info.ctor;
  if (info.base === null || ctor?.body === undefined || info.decl === null) return false;
  const js = isJsSourceFile(ts.getSourceFileOfNode(ctor));
  for (const stmt of ownValueReturns(ctor)) {
    const value = unparenthesized(stmt.expression!);
    if (returnsThis(lowerer, info, value)) continue;
    const type = lowerer.typeOf(value);
    const shape = objectness(type);
    if (shape === "maybe" && js) return true;
    if (shape === "never" && !alwaysUndefined(type)) return true;
  }
  return false;
}

/** The flag that a construction of exactly class `C` reads after the
 * constructor returns, or null. Clearing it on entry keeps an abandoned
 * construction (a `finally` that throws after the primitive return) from
 * leaking into the next one. */
export function constructorPrimitiveFlag(lowerer: Lowerer, info: ClassInfo): IrGlobal | null {
  if (!mayReturnPrimitive(lowerer, info)) return null;
  return constructorReturnPlan(lowerer, info)?.primitiveFlag ?? null;
}

/** Node's TypeError for a construction whose derived constructor recorded a
 * primitive return, as a statement. */
function throwPendingPrimitiveReturn(flag: IrGlobal, loc: SrcLoc): IrStmt[] {
  return [
    {
      kind: "assign",
      localId: flag.id,
      value: { kind: "boolLit", value: false, type: BOOL, loc },
      loc,
    },
    { kind: "exprStmt", expr: nodeThrowExpr(1, "", DERIVED_PRIMITIVE_RETURN, VOID, loc), loc },
  ];
}

/** The value of a construction of exactly class `C`: the constructed
 * instance, or the instance the constructor returned. Unchanged for
 * classes without a result slot. The slot is read and cleared by a
 * per-class helper, so every construction site (direct `new`, class
 * values, the checked dynamic dispatchers) shares one protocol. */
export function constructedValue(lowerer: Lowerer, info: ClassInfo, constructed: IrExpr): IrExpr {
  const plan = constructorReturnPlan(lowerer, info);
  const slot = plan?.slot ?? null;
  const flag = plan?.primitiveFlag ?? null;
  if (slot === null && flag === null) return constructed;
  const loc = constructed.loc;
  const type = instanceType(info);
  const name = `%${info.def.name}.%constructed`;
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const instance = { id: "instance.0", name: "instance", type, mutable: false };
    const returned = {
      id: "returned.0",
      name: "returned",
      type: slot?.type ?? type,
      mutable: false,
    };
    lowerer.liftedFns.push({
      name,
      params: [{ localId: instance.id, name: instance.name, type }],
      returnType: type,
      locals: slot === null ? [instance] : [instance, returned],
      body: [
        ...(slot === null
          ? []
          : [
              {
                kind: "varDecl" as const,
                localId: returned.id,
                init: varRef(slot.id, slot.type, loc),
                loc,
              },
              {
                kind: "assign" as const,
                localId: slot.id,
                value: lowerer.wrappedUndefined(slot.type, loc)!,
                loc,
              },
            ]),
        // The pending TypeError a derived constructor's primitive return
        // recorded, raised here: [[Construct]] raises it after the body.
        ...(flag === null
          ? []
          : [
              {
                kind: "if" as const,
                cond: varRef(flag.id, BOOL, loc),
                then: throwPendingPrimitiveReturn(flag, loc),
                else_: null,
                loc,
              },
            ]),
        {
          kind: "return",
          value:
            slot === null
              ? varRef(instance.id, type, loc)
              : {
                  kind: "orDefault",
                  left: varRef(returned.id, slot.type, loc),
                  right: varRef(instance.id, type, loc),
                  type,
                  loc,
                },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [constructed], type, loc };
}

/** A construction through a class value whose static class is `info`: the
 * value holds `info` itself or a descendant. Descendants of a class with a
 * result slot refuse at their `super()`, so only `info`'s own slot can
 * apply; a descendant with its own slot has no static home here. */
export function constructedFromValue(
  lowerer: Lowerer,
  info: ClassInfo,
  constructed: IrExpr,
  blame: ts.Node,
): IrExpr {
  const pending = [...info.subclasses];
  while (pending.length > 0) {
    const sub = pending.pop()!;
    pending.push(...sub.subclasses);
    const plan = constructorReturnPlan(lowerer, sub);
    if (plan === null || (plan.slot === null && plan.primitiveFlag === null)) continue;
    const display = sub.def.name.replace(/^%|^%m\d+\./, "");
    lowerer.unsupported(
      "SC1090",
      blame,
      plan.slot === null
        ? `constructing through a class value that may hold '${display}', whose constructor can return a primitive`
        : `constructing through a class value that may hold '${display}', whose constructor can return an existing instance`,
    );
  }
  return constructedValue(lowerer, info, constructed);
}

/** `super()` into a class with a result slot, from the constructor of
 * class `sub`: `call` runs the base constructor over `self` (the
 * subclass's `this`, upcast to the base). Node rebinds the subclass's
 * `this` to an instance the base constructor returns, which has no
 * representation. A TypeScript subclass refuses. In JavaScript the base
 * stores the instance it returns in its slot, and a per-subclass helper
 * reads and clears the slot after the call: an instance other than `self`
 * refuses at run time. Unchanged for bases without a result slot. */
export function superIntoResultSlot(
  lowerer: Lowerer,
  base: ClassInfo,
  sub: ClassInfo,
  call: IrStmt,
  self: IrExpr,
  blame: ts.Node,
): IrStmt {
  const plan = constructorReturnPlan(lowerer, base);
  const slot = plan?.slot ?? null;
  const flag = plan?.primitiveFlag ?? null;
  if (plan === null || (slot === null && flag === null)) return call;
  const display = base.def.name.replace(/^%|^%m\d+\./, "");
  const feature =
    slot === null
      ? `extending a class whose constructor can return a primitive ('super()' raises the TypeError Node raises for a derived constructor's non-object result)`
      : `extending a class whose constructor can return an existing instance ('super()' would rebind 'this' to the instance '${display}' returns)`;
  if (!isJsSourceFile(ts.getSourceFileOfNode(blame))) {
    lowerer.unsupported("SC1090", blame, feature);
    return call;
  }
  const loc = locOf(blame);
  const type = instanceType(base);
  const name = `%${sub.def.name}.%superResult`;
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const instance = { id: "instance.0", name: "instance", type, mutable: false };
    const returned = {
      id: "returned.0",
      name: "returned",
      type: slot?.type ?? type,
      mutable: false,
    };
    const body: IrStmt[] = [];
    if (slot !== null) {
      const diag = unsupportedDiag("SC1090", loc, feature);
      lowerer.runtimeFences.push(diag);
      const line =
        ts.getLineAndCharacterOfPosition(ts.getSourceFileOfNode(blame), loc.start).line + 1;
      body.push(
        { kind: "varDecl", localId: returned.id, init: varRef(slot.id, slot.type, loc), loc },
        { kind: "assign", localId: slot.id, value: lowerer.wrappedUndefined(slot.type, loc)!, loc },
        {
          kind: "if",
          cond: {
            kind: "bin",
            op: "!==",
            left: {
              kind: "orDefault",
              left: varRef(returned.id, slot.type, loc),
              right: varRef(instance.id, type, loc),
              type,
              loc,
            },
            right: varRef(instance.id, type, loc),
            type: BOOL,
            loc,
          },
          then: [
            {
              kind: "runtimeFence",
              code: diag.code,
              message: `${diag.message} [${diag.code} at ${loc.file}:${line}]`,
              loc,
            },
          ],
          else_: null,
          loc,
        },
      );
    }
    // The TypeError a primitive return in the base recorded: [[Construct]]
    // raises it here, at the `super()` call, so the subclass's own body
    // sees (and may catch) it.
    if (flag !== null) {
      body.push({
        kind: "if",
        cond: varRef(flag.id, BOOL, loc),
        then: throwPendingPrimitiveReturn(flag, loc),
        else_: null,
        loc,
      });
    }
    body.push({ kind: "return", value: null, loc });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: instance.id, name: instance.name, type }],
      returnType: VOID,
      locals: slot === null ? [instance] : [instance, returned],
      body,
      loc,
    });
  }
  const check: IrStmt = {
    kind: "exprStmt",
    expr: { kind: "call", callee: name, args: [self], type: VOID, loc },
    loc,
  };
  return { kind: "block", body: [call, check], loc };
}
