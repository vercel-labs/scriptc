import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  DYN,
  RUNTIME_ERROR_CLASSES,
  STRING,
  typeKey,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { helperLoc, strLit, varRef } from "../../ir/build.js";
import { isJsSourceFile } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";

/** How a brand helper uses its receiver: `in` answers `#x in v`, `read` and
 * `write` return the receiver as the declaring class for a field access, and
 * `call` for a private method call. */
type BrandUse = "in" | "read" | "write" | "call";

const PREFIX = "%private.";

/** A function-local JavaScript class with private names. Its prototype
 * methods and accessors exist once per evaluation and check their receiver's
 * evaluation, so a method or accessor taken from an instance is the function
 * of that instance's own evaluation. */
export function perEvaluationPrivateNames(info: ClassInfo): boolean {
  const declaration = info.localClass ? info.decl : null;
  return (
    !!declaration &&
    isJsSourceFile(ts.getSourceFileOfNode(declaration)) &&
    declaration.members.nodes.some(
      (member) => member.name !== undefined && ts.isPrivateIdentifier(member.name),
    )
  );
}

/** The function-local class declaring a private name, when its private names
 * need a per-evaluation brand check: the nearest enclosing class that
 * declares the name, as JavaScript scoping resolves it. */
export function localPrivateBrandClass(
  lowerer: Lowerer,
  priv: ts.PrivateIdentifier,
): { info: ClassInfo; decl: ts.ClassDeclaration & { name: ts.Identifier } } | null {
  for (let node: ts.Node | undefined = priv.parent; node; node = node.parent) {
    if (!ts.isClassDeclaration(node) && !ts.isClassExpression(node)) continue;
    const declares = node.members.nodes.some((member) => {
      const name = (member as { name?: ts.PropertyName }).name;
      return name !== undefined && ts.isPrivateIdentifier(name) && name.text === priv.text;
    });
    if (!declares) continue;
    if (!ts.isClassDeclaration(node) || !node.name) return null;
    const symbol = lowerer.checker.getSymbolAtLocation(node.name);
    const info =
      lowerer.currentClass?.decl === node
        ? lowerer.currentClass
        : symbol
          ? lowerer.classBySymbol.get(symbol)
          : undefined;
    if (!info?.localClass) return null;
    return { info, decl: node as ts.ClassDeclaration & { name: ts.Identifier } };
  }
  return null;
}

/** Each evaluation of a function-local class creates fresh private names,
 * while one compiled class serves every evaluation. Its JavaScript prototype
 * methods are closures per evaluation whose `this` is a checked value, so a
 * private name on `this` is present exactly when the receiver is an instance
 * of the class (or a subclass) whose `%classEnvironment` field holds the
 * class value of the closure's own evaluation. The class's own binding names
 * that value (lowerClassExpressionInfo accepts only named declarations, whose
 * binding the checker keeps from being assigned). */
export function checkedPrivateReceiver(
  lowerer: Lowerer,
  info: ClassInfo,
  decl: ts.ClassDeclaration & { name: ts.Identifier },
  access: ts.PropertyAccessExpression,
  receiver: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const use: BrandUse = isPrivateWriteTarget(access) ? "write" : "read";
  return brandCall(lowerer, info, decl, use, access.name.text, receiver, loc);
}

/** Whether a checked value is a primitive: `#x in v` throws for those
 * before any brand lookup. */
export function primitiveOperand(value: IrExpr, loc: SrcLoc): IrExpr {
  return (["nullish", "number", "string", "boolean", "bigint", "symbol"] as const)
    .map((test): IrExpr => ({ kind: "dynTest", test, value, type: BOOL, loc }))
    .reduce((left, right) => ({ kind: "logical", op: "||", left, right, type: BOOL, loc }));
}

/** Node's TypeError message for `#x in v` on a primitive, which spells the
 * value as String(v) does. */
export function privateInMessage(name: string, value: IrExpr, loc: SrcLoc): IrExpr {
  return {
    kind: "strConcat",
    left: strLit(`Cannot use 'in' operator to search for '${name}' in `, loc),
    right: { kind: "libCall", fn: "dyn.stringConstructor", args: [value], type: STRING, loc },
    type: STRING,
    loc,
  };
}

/** A receiver checkedPrivateReceiver built for a field write. */
export function isPrivateWriteReceiver(expr: IrExpr): boolean {
  return expr.kind === "call" && expr.callee.startsWith(`${PREFIX}write:`);
}

/** `#x in v` for a checked value inside a function-local class: the brand
 * test above, after the TypeError a primitive operand throws. */
export function checkedPrivateIn(
  lowerer: Lowerer,
  info: ClassInfo,
  decl: ts.ClassDeclaration & { name: ts.Identifier },
  name: string,
  receiver: IrExpr,
  loc: SrcLoc,
): IrExpr {
  return brandCall(lowerer, info, decl, "in", name, receiver, loc);
}

function brandCall(
  lowerer: Lowerer,
  info: ClassInfo,
  decl: ts.ClassDeclaration & { name: ts.Identifier },
  use: BrandUse,
  name: string,
  receiver: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const className = info.def.name;
  const classType: IrType = { kind: "classval", className };
  const resultType: IrType = use === "in" ? BOOL : { kind: "object", className };
  const helper = `${PREFIX}${use}:${className}:${name}`;
  if (!lowerer.valueHelpers.has(helper)) {
    const at = helperLoc(loc);
    lowerer.liftedFns.push({
      name: helper,
      params: [
        { localId: "value.0", name: "value", type: DYN },
        { localId: "class.0", name: "class", type: classType },
      ],
      returnType: resultType,
      locals: [
        { id: "value.0", name: "value", type: DYN, mutable: false },
        { id: "class.0", name: "class", type: classType, mutable: false },
      ],
      // finalizePrivateBrands fills the body once every class is collected,
      // including subclasses declared after this use.
      body: [],
      loc: at,
    });
    lowerer.valueHelpers.set(helper, helper);
  }
  const evaluation = lowerer.classValueRef(info, decl.name);
  return { kind: "call", callee: helper, args: [receiver, evaluation], type: resultType, loc };
}

/** The class whose body declares the private name `priv` (the nearest
 * enclosing one, as JavaScript scoping resolves it), when it is a
 * declaration-level class, or null. */
export function privateNameClass(lowerer: Lowerer, priv: ts.PrivateIdentifier): ClassInfo | null {
  for (let node: ts.Node | undefined = priv.parent; node; node = node.parent) {
    if (!ts.isClassDeclaration(node) && !ts.isClassExpression(node)) continue;
    const declares = node.members.nodes.some((member) => {
      const name = (member as { name?: ts.PropertyName }).name;
      return name !== undefined && ts.isPrivateIdentifier(name) && name.text === priv.text;
    });
    if (!declares) continue;
    const symbol = node.name ? lowerer.checker.getSymbolAtLocation(node.name) : undefined;
    const info =
      lowerer.currentClass?.decl === node
        ? lowerer.currentClass
        : symbol
          ? lowerer.classBySymbol.get(symbol)
          : undefined;
    if (!info || info.localClass || info.generic || info.genericInstance) return null;
    return info;
  }
  return null;
}

/** `value.#x` on a checked-dynamic `value` in a declaration-level class
 * `info`: the receiver as an instance of `info` when the value is one (an
 * instance of the class or a subclass), else Node's TypeError for a missing
 * private member (also for undefined and null). */
export function checkedPrivateValue(
  lowerer: Lowerer,
  info: ClassInfo,
  access: ts.PropertyAccessExpression,
  receiver: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const use: BrandUse = isPrivateWriteTarget(access) ? "write" : "read";
  const className = info.def.name;
  const resultType: IrType = { kind: "object", className };
  const helper = `${PREFIX}${use}:${className}:${access.name.text}`;
  if (!lowerer.valueHelpers.has(helper)) {
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "value.0", name: "value", type: DYN }],
      returnType: resultType,
      locals: [{ id: "value.0", name: "value", type: DYN, mutable: false }],
      // finalizePrivateBrands fills the body.
      body: [],
      loc: helperLoc(loc),
    });
    lowerer.valueHelpers.set(helper, helper);
  }
  return { kind: "call", callee: helper, args: [receiver], type: resultType, loc };
}

/** `value.#m(...)` on a checked-dynamic `value` in a declaration-level class
 * `info` that declares the private method `#m`: the receiver as an instance
 * of `info` when the value is one, else Node's TypeError ("Receiver must be
 * an instance of class C"). */
export function checkedPrivateMethodReceiver(
  lowerer: Lowerer,
  info: ClassInfo,
  name: string,
  receiver: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const className = info.def.name;
  const resultType: IrType = { kind: "object", className };
  const helper = `${PREFIX}call:${className}:${name}`;
  if (!lowerer.valueHelpers.has(helper)) {
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "value.0", name: "value", type: DYN }],
      returnType: resultType,
      locals: [{ id: "value.0", name: "value", type: DYN, mutable: false }],
      // finalizePrivateBrands fills the body.
      body: [],
      loc: helperLoc(loc),
    });
    lowerer.valueHelpers.set(helper, helper);
  }
  return { kind: "call", callee: helper, args: [receiver], type: resultType, loc };
}

/** A plain assignment, a destructuring target, or a for-in/of target writes
 * the field. Compound assignments and updates read it first, and Node
 * reports the failed read. */
function isPrivateWriteTarget(access: ts.PropertyAccessExpression): boolean {
  let node: ts.Node = access;
  for (;;) {
    const parent = node.parent;
    if (ts.isParenthesizedExpression(parent)) {
      node = parent;
      continue;
    }
    if (ts.isBinaryExpression(parent))
      return parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    if (ts.isForOfStatement(parent) || ts.isForInStatement(parent))
      return parent.initializer === node;
    // Inside a destructuring pattern: keep walking to the assignment.
    if (
      ts.isArrayLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === node) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isSpreadAssignment(parent)
    ) {
      node = parent;
      continue;
    }
    return false;
  }
}

/** Fill the brand helpers: one branch per class a checked reference to an
 * instance can be boxed under (the declarer, its subclasses, and its
 * ancestors when the instance is at or below the declarer). */
export function finalizePrivateBrands(lowerer: Lowerer, functions: IrFunction[]): void {
  for (const fn of functions) {
    if (!fn.name.startsWith(PREFIX) || fn.body.length > 0) continue;
    // `%private.<use>:<class>:<#name>`; class names may contain colons.
    const spec = fn.name.slice(PREFIX.length);
    const use = spec.slice(0, spec.indexOf(":")) as BrandUse;
    const className = spec.slice(use.length + 1, spec.lastIndexOf(":"));
    const name = spec.slice(spec.lastIndexOf(":") + 1);
    const loc = fn.loc;
    const value = varRef("value.0", DYN, loc);
    // A declaration-level class has one brand: the helper takes no class.
    const evaluation =
      fn.params.length > 1 ? varRef("class.0", { kind: "classval", className }, loc) : null;
    const ownerType: IrType = { kind: "object", className };
    const body: IrStmt[] = [];
    let matches = 0;
    for (const candidate of lowerer.classes.values()) {
      const candidateName = candidate.def.name;
      if (RUNTIME_ERROR_CLASSES.has(candidateName)) continue;
      const below = candidateName === className || lowerer.isSubclassOf(candidateName, className);
      const above = lowerer.isSubclassOf(className, candidateName);
      if (!below && !above) continue;
      const candidateType: IrType = { kind: "object", className: candidateName };
      const checked: IrExpr = { kind: "dynCheck", value, type: candidateType, loc };
      const local = `receiver.${matches++}`;
      fn.locals.push({ id: local, name: "receiver", type: ownerType, mutable: false });
      const receiver = varRef(local, ownerType, loc);
      const sameEvaluation: IrExpr = evaluation
        ? {
            kind: "bin",
            op: "===",
            left: {
              kind: "fieldGet",
              obj: receiver,
              className,
              field: `%classEnvironment:${className}`,
              type: evaluation.type,
              loc,
            },
            right: evaluation,
            type: BOOL,
            loc,
          }
        : { kind: "boolLit", value: true, type: BOOL, loc };
      const match = (typed: IrExpr): IrStmt[] => [
        { kind: "varDecl", localId: local, init: typed, loc },
        {
          kind: "if",
          cond: sameEvaluation,
          then: [
            {
              kind: "return",
              value: use === "in" ? { kind: "boolLit", value: true, type: BOOL, loc } : receiver,
              loc,
            },
          ],
          else_: null,
          loc,
        },
      ];
      const then: IrStmt[] = below
        ? match(
            candidateName === className
              ? checked
              : { kind: "upcast", value: checked, type: ownerType, loc },
          )
        : [
            {
              kind: "if",
              cond: { kind: "instanceOf", value: checked, className, type: BOOL, loc },
              then: match({ kind: "downcast", value: checked, type: ownerType, loc }),
              else_: null,
              loc,
            },
          ];
      body.push({
        kind: "if",
        cond: {
          kind: "libCall",
          fn: "dyn.typedRefIs",
          args: [value, strLit(typeKey(candidateType), loc)],
          type: BOOL,
          loc,
        },
        then,
        else_: null,
        loc,
      });
    }
    const typeError = (message: IrExpr): IrStmt => ({
      kind: "throw",
      value: {
        kind: "libCall",
        fn: "error.new",
        args: [message],
        type: { kind: "object", className: "%TypeError" },
        loc,
      },
      loc,
    });
    if (use === "in") {
      body.push(
        {
          kind: "if",
          cond: primitiveOperand(value, loc),
          then: [typeError(privateInMessage(name, value, loc))],
          else_: null,
          loc,
        },
        { kind: "return", value: { kind: "boolLit", value: false, type: BOOL, loc }, loc },
      );
    } else if (use === "call") {
      // V8 names the class by its own identifier (not a name inferred from
      // a binding), "anonymous" without one, also for a nullish receiver.
      const owner = lowerer.classes.get(className);
      const identifier = owner?.decl?.name;
      const shown = identifier !== undefined ? identifier.text : "anonymous";
      for (const unit of ["undefined", "null"] as const) {
        body.push({
          kind: "if",
          cond: { kind: "dynTest", test: unit, value, type: BOOL, loc },
          then: [typeError(strLit(`Cannot read properties of ${unit} (reading '${shown}')`, loc))],
          else_: null,
          loc,
        });
      }
      body.push(typeError(strLit(`Receiver must be an instance of class ${shown}`, loc)));
    } else {
      const verb = use === "read" ? "reading" : "setting";
      const action = use === "read" ? "Cannot read properties" : "Cannot set properties";
      for (const unit of ["undefined", "null"] as const) {
        body.push({
          kind: "if",
          cond: { kind: "dynTest", test: unit, value, type: BOOL, loc },
          then: [typeError(strLit(`${action} of ${unit} (${verb} '${name}')`, loc))],
          else_: null,
          loc,
        });
      }
      body.push(
        typeError(
          strLit(
            use === "read"
              ? `Cannot read private member ${name} from an object whose class did not declare it`
              : `Cannot write private member ${name} to an object whose class did not declare it`,
            loc,
          ),
        ),
      );
    }
    fn.body = body;
  }
}
