/* `new.target`. Compiled code has no invocation record, but inside a class
 * constructor `new.target` is always the class of the object under
 * construction: a compiled `new` allocates the instance with its concrete
 * class before any constructor of the chain runs, and every constructor of
 * the chain receives that instance as `this`. The program's class
 * hierarchy is closed, so the value is a static dispatch over the
 * constructor's class and its descendants: the deepest class the instance
 * is an instance of is its exact class.
 *
 * The checker rejects `new.target` in methods, accessors, static blocks and
 * field initializers. Plain functions (constructible in JavaScript) keep
 * the refusal. */
import * as ts from "../ts7/adapter.js";
import { BOOL, STRING, type IrExpr, type IrType, type SrcLoc } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";
import { classValueRef, functionLocalClass } from "./lower-classes.js";

export function isNewTarget(node: ts.Node): node is ts.MetaProperty {
  return (
    ts.isMetaProperty(node) &&
    node.keywordToken === ts.SyntaxKind.NewKeyword &&
    node.name.text === "target"
  );
}

/** Where `new.target` is bound: a class constructor, or a plain function
 * (refused). */
type Binding =
  | { kind: "constructor"; declaration: ts.ConstructorDeclaration }
  | { kind: "function" };

function bindingOf(node: ts.Node): Binding {
  for (let p = node.parent; p !== undefined; p = p.parent) {
    if (ts.isArrowFunction(p)) continue;
    if (ts.isConstructorDeclaration(p)) return { kind: "constructor", declaration: p };
    if (ts.isFunctionLike(p) || ts.isSourceFile(p)) return { kind: "function" };
  }
  return { kind: "function" };
}

interface Dispatch {
  info: ClassInfo;
  /** The constructor's descendants, deepest first, then its class. A
   * generic family stands for its instantiations, also those that later
   * bodies instantiate: its interval holds them all. */
  classes: ClassInfo[];
  self: IrExpr | null;
}

function depth(info: ClassInfo): number {
  let d = 0;
  for (let c = info.base; c; c = c.base) d++;
  return d;
}

/** The function-local classes of the program that extend a class. */
function functionLocalSubclasses(lowerer: Lowerer): ts.ClassLikeDeclaration[] {
  let found = lowerer.functionLocalSubclasses;
  if (found === undefined) {
    const classes: ts.ClassLikeDeclaration[] = [];
    for (const sf of lowerer.moduleOrder)
      ts.walkPreorder(sf, (node) => {
        if (
          (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
          baseExpressionOf(node) !== undefined &&
          functionLocalClass(node)
        )
          classes.push(node);
      });
    lowerer.functionLocalSubclasses = found = classes;
  }
  return found;
}

function baseExpressionOf(node: ts.ClassLikeDeclaration): ts.Expression | undefined {
  let base = node.heritageClauses?.nodes.find(
    (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
  )?.types?.nodes[0]?.expression;
  while (base !== undefined && ts.isParenthesizedExpression(base)) base = base.expression;
  return base;
}

/** Whether the class `node` extends the class of `info` (for an
 * instantiation, its family), directly or through other classes, as far as
 * its `extends` clauses name classes. */
function derivesFrom(
  lowerer: Lowerer,
  node: ts.ClassLikeDeclaration,
  info: ClassInfo,
  seen: Set<ts.Node>,
): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  const base = baseExpressionOf(node);
  const name =
    base === undefined
      ? undefined
      : ts.isIdentifier(base)
        ? base
        : ts.isPropertyAccessExpression(base)
          ? base.name
          : undefined;
  let symbol = name === undefined ? undefined : lowerer.checker.getSymbolAtLocation(name);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
    symbol = lowerer.checker.getAliasedSymbol(symbol);
  if (symbol === undefined) return false;
  const named = lowerer.classBySymbol.get(symbol);
  if (named !== undefined)
    return (
      named === info ||
      named === info.genericInstance?.family ||
      lowerer.isSubclassOf(named.def.name, info.def.name)
    );
  // A class lowering has not collected: through its declaration.
  for (const declaration of symbol.declarations) {
    let cls: ts.Node | undefined = declaration;
    if (ts.isVariableDeclaration(cls)) {
      cls = cls.initializer;
      while (cls !== undefined && ts.isParenthesizedExpression(cls)) cls = cls.expression;
    }
    if (
      cls !== undefined &&
      (ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) &&
      derivesFrom(lowerer, cls, info, seen)
    )
      return true;
  }
  return false;
}

/** `node`'s name, quoted, for diagnostics. */
function localClassName(node: ts.ClassLikeDeclaration): string {
  if (node.name) return `'${node.name.text}'`;
  const parent = node.parent;
  return parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
    ? `'${parent.name.text}'`
    : "a class expression";
}

/** The classes `new.target` can denote in the constructor being lowered,
 * or null after a diagnostic. */
function dispatchOf(lowerer: Lowerer, expr: ts.MetaProperty): Dispatch | null {
  const binding = bindingOf(expr);
  if (binding.kind !== "constructor") return null;
  const info = lowerer.currentClass;
  const cls = binding.declaration.parent;
  if (!info || (info.decl !== null && info.decl !== cls)) {
    lowerer.unsupported(
      "SC1090",
      expr,
      "'new.target' in this constructor (its class has no lowering here)",
    );
    return null;
  }
  // An instantiation's subclasses can also be instantiations of generic
  // subclasses of its family (`class G<T> extends Box<T>` under Box<number>).
  const family = info.genericInstance?.family;
  const descendants: ClassInfo[] = [];
  for (const other of lowerer.classes.values()) {
    if (other === info) continue;
    if (
      lowerer.isSubclassOf(other.def.name, info.def.name) ||
      (family !== undefined &&
        other.generic !== undefined &&
        other !== family &&
        lowerer.isSubclassOf(other.def.name, family.def.name))
    )
      descendants.push(other);
  }
  descendants.sort((a, b) => depth(b) - depth(a));
  const classes = [...descendants, info];
  for (const c of classes) {
    if (c.localClass) {
      lowerer.unsupported(
        "SC1090",
        expr,
        `'new.target' where '${c.def.jsName ?? c.def.name}' is a function-local class (each evaluation creates a new class)`,
      );
      return null;
    }
  }
  // Lowering collects a function-local class with the body declaring it,
  // which may come after this constructor.
  for (const local of functionLocalSubclasses(lowerer)) {
    if (!derivesFrom(lowerer, local, info, new Set())) continue;
    lowerer.unsupported(
      "SC1090",
      expr,
      `'new.target' where ${localClassName(local)} is a function-local class (each evaluation creates a new class)`,
    );
  }
  let self: IrExpr | null = null;
  if (classes.length > 1) {
    const thisLocal = lowerer.resolveThis(expr);
    if (!thisLocal || thisLocal.type.kind !== "object") {
      lowerer.unsupported(
        "SC1090",
        expr,
        "'new.target' where the constructor's 'this' has no class representation",
      );
      return null;
    }
    self = varRef(thisLocal.id, thisLocal.type, locOf(expr));
  }
  return { info, classes, self };
}

/** A conditional chain selecting `arm(D)` for the exact class D of the
 * instance under construction. */
function select(
  dispatch: Dispatch,
  type: IrType,
  loc: SrcLoc,
  arm: (info: ClassInfo) => IrExpr,
): IrExpr {
  const { classes, self } = dispatch;
  let result = arm(classes[classes.length - 1]!);
  for (let i = classes.length - 2; i >= 0; i--) {
    const c = classes[i]!;
    result = {
      kind: "ternary",
      cond: { kind: "instanceOf", value: self!, className: c.def.name, type: BOOL, loc },
      then: arm(c),
      else_: result,
      type,
      loc,
    };
  }
  return result;
}

function refuseFunction(lowerer: Lowerer, expr: ts.MetaProperty): never {
  return lowerer.unsupported(
    "SC1090",
    expr,
    "'new.target' in a plain function (a constructible function's invocation record does not exist in compiled code; use a class constructor)",
  );
}

/** `new.target` as a value. */
export function lowerNewTarget(lowerer: Lowerer, expr: ts.MetaProperty): IrExpr {
  const loc = locOf(expr);
  if (bindingOf(expr).kind === "function") refuseFunction(lowerer, expr);
  const dispatch = dispatchOf(lowerer, expr)!;
  const type: IrType = { kind: "classval", className: dispatch.info.def.name };
  for (const c of dispatch.classes) {
    if (c.generic) {
      lowerer.unsupported(
        "SC1090",
        expr,
        `'new.target' as a value where '${c.def.jsName ?? c.def.name}' is a generic subclass (its instantiations have no common class value; read 'new.target.name' or compare 'new.target' with a class instead)`,
      );
    }
    if (c !== dispatch.info && !lowerer.ctorAbiEquals(c, dispatch.info)) {
      lowerer.unsupported(
        "SC1090",
        expr,
        `'new.target' as a value where '${c.def.jsName ?? c.def.name}' constructs with a different signature than '${dispatch.info.def.jsName ?? dispatch.info.def.name}' (read 'new.target.name' or compare 'new.target' with a class instead)`,
      );
    }
  }
  return select(dispatch, type, loc, (c) =>
    lowerer.coerceToExpected(classValueRef(lowerer, c, expr), type),
  );
}

/** `new.target.name`: the exact class's name, without materializing a
 * class value (subclasses may construct with other signatures). */
export function lowerNewTargetName(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.questionDotToken || access.name.text !== "name") return null;
  let target: ts.Expression = access.expression;
  while (ts.isParenthesizedExpression(target)) target = target.expression;
  if (!isNewTarget(target) || bindingOf(target).kind !== "constructor") return null;
  const dispatch = dispatchOf(lowerer, target);
  if (!dispatch) return null;
  const loc = locOf(access);
  return select(dispatch, STRING, loc, (c) => {
    // An own static `name` field replaces the class's name; a subclass has
    // its own name. An instantiation's statics are its family's.
    const owner = c.genericInstance?.family ?? c;
    const field = owner.staticFields.find((f) => f.name === "name");
    if (field !== undefined) {
      if (field.type.kind !== "string")
        lowerer.unsupported(
          "SC1090",
          access,
          `'new.target.name' where '${c.def.jsName ?? c.def.name}' declares a static 'name' that is not a string`,
        );
      return { kind: "varRef", localId: field.globalId, type: field.type, loc };
    }
    if (owner.staticMethods?.has("name") || owner.genericStatics?.has("name"))
      lowerer.unsupported(
        "SC1090",
        access,
        `'new.target.name' where '${c.def.jsName ?? c.def.name}' declares a static method 'name'`,
      );
    // A generic family's instantiations share its name.
    if (c.generic)
      return { kind: "strLit", value: c.def.jsName ?? c.generic.baseName, type: STRING, loc };
    return {
      kind: "libCall",
      fn: "class.name",
      args: [classValueRef(lowerer, c, target)],
      type: STRING,
      loc,
    };
  });
}

/** `new.target === C` (and `!==`, `==`, `!=`, either operand order) with a
 * program class named by the other operand: an exact-class test. */
export function lowerNewTargetComparison(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  const op = expr.operatorToken.kind;
  const negated =
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken;
  if (
    !negated &&
    op !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
    op !== ts.SyntaxKind.EqualsEqualsToken
  )
    return null;
  const strip = (e: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    return e;
  };
  const left = strip(expr.left);
  const right = strip(expr.right);
  const target = isNewTarget(left) ? left : isNewTarget(right) ? right : null;
  if (!target || bindingOf(target).kind !== "constructor") return null;
  const other = target === left ? right : left;
  if (!ts.isIdentifier(other)) return null;
  // A constructor's new.target is never undefined.
  if (other.text === "undefined" && (lowerer.typeOf(other).flags & ts.TypeFlags.Undefined) !== 0)
    return { kind: "boolLit", value: negated, type: BOOL, loc: locOf(expr) };
  const symbol = lowerer.resolveValueSymbol(other);
  const named = symbol ? lowerer.classBySymbol.get(symbol) : undefined;
  if (!named || named.generic || named.localClass) return null;
  const dispatch = dispatchOf(lowerer, target);
  if (!dispatch) return null;
  const loc = locOf(expr);
  return select(dispatch, BOOL, loc, (c) => ({
    kind: "boolLit",
    value: (c === named) !== negated,
    type: BOOL,
    loc,
  }));
}
