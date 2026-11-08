import * as ts from "../../ts7/adapter.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { DYN, type IrExpr, type IrType, type SrcLoc } from "../../../ir/ir.js";
import { unsupportedDiag } from "../../../diagnostics/diagnostic.js";
import { type Lowerer, PoisonError } from "../lowerer.js";
import { lowerDynObjectLiteral } from "./object-literals.js";

/** These values must stay checked-native instead of being copied into the
 * target's inferred record layout, including hoisted and module bindings. */
export function isNativeProxyInitializer(
  lowerer: Lowerer,
  expression: ts.Expression | undefined,
): boolean {
  if (!expression) return false;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return (
    ts.isNewExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "Proxy" &&
    lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(expression.expression) ?? undefined)
  );
}

/** What a slot of this type does with a Proxy, or null when it can hold
 * one. A Proxy is a checked-dynamic value: it lives in the binding it
 * initializes and wherever an untyped value can. A class slot holds native
 * instances only, so the checked conversion into it throws every time; a
 * record slot would hold the properties read through the traps once, which
 * is a copy and not the Proxy. A union is such a slot when it has a class
 * or record arm and no arm that could hold an object as it is. */
function typedSlotOfProxy(
  lowerer: Lowerer,
  expected: IrType,
): { kind: "class"; name: string } | { kind: "record" } | null {
  if (expected.kind === "object") {
    const info = lowerer.classes.get(expected.className);
    const name =
      info?.def.jsName ?? info?.decl?.name?.text ?? expected.className.replace(/^.*[%.]/, "");
    return { kind: "class", name };
  }
  if (expected.kind === "record") return { kind: "record" };
  if (expected.kind !== "union") return null;
  let slot: ReturnType<typeof typedSlotOfProxy> = null;
  for (const arm of lowerer.unions.get(expected.unionId)?.arms ?? []) {
    switch (arm.kind) {
      case "object":
      case "record":
        slot ??= typedSlotOfProxy(lowerer, arm);
        break;
      case "undefinedT":
      case "nullT":
      case "f64":
      case "string":
      case "bool":
      case "bigint":
      case "symbol":
        break;
      default:
        return null;
    }
  }
  return slot;
}

/** True for a function-local binding a Proxy initializes whose declared
 * type is a slot that would refuse or copy the Proxy: the binding takes
 * checked-dynamic storage and holds the Proxy itself, as a module binding
 * and a `var` do. Other declared types (a function type, whose slot wraps
 * a callable Proxy) keep their storage. */
export function proxyBindingHoldsProxy(lowerer: Lowerer, decl: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(decl.name) || !isNativeProxyInitializer(lowerer, decl.initializer))
    return false;
  const type = lowerer.mapTypeOf(lowerer.typeOf(decl.name));
  return type !== null && typedSlotOfProxy(lowerer, type) !== null;
}

/** Refuses a Proxy the build can see entering a class or record slot: at
 * run time the first throws when the statement executes and the second
 * silently replaces the Proxy with a copy. `trapless` is a Proxy whose
 * handler is the empty literal: it adds nothing to its target, so a record
 * slot converts it as it converts the target. */
export function refuseProxyInTypedSlot(
  lowerer: Lowerer,
  loc: SrcLoc,
  expected: IrType,
  trapless: boolean,
): void {
  if (expected.kind === "dyn") return;
  const slot = typedSlotOfProxy(lowerer, expected);
  if (slot === null || (trapless && slot.kind === "record")) return;
  lowerer.pushDiag(
    slot.kind === "class"
      ? unsupportedDiag(
          "SC1090",
          loc,
          `a Proxy where an instance of class '${slot.name}' is expected`,
          `a Proxy is not an instance of '${slot.name}', so native code that holds the class cannot hold it. For a value that forwards to the current instance, export a binding that is reassigned ('export let') or a function that returns the instance`,
        )
      : unsupportedDiag(
          "SC1090",
          loc,
          "a Proxy where a value of an object type is expected",
          "the slot would hold a copy of the properties, read through the traps once, and not the Proxy. Use the Proxy through the binding it initializes, or type the slot 'any'",
        ),
  );
  throw new PoisonError();
}

/** Records a read by name of the `const` binding a Proxy initializes: the
 * value read is that Proxy wherever the read then goes (an argument, a
 * shorthand property, a default). A binding typed as a class is not
 * recorded: its declaration is the error (refuseProxyClassBinding), and its
 * reads inherit that. */
export function noteNativeProxyRead(lowerer: Lowerer, node: ts.Identifier, read: IrExpr): void {
  if (read.type.kind !== "dyn") return;
  const declaration = lowerer.resolveValueSymbol(node)?.valueDeclaration;
  if (
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    !isNativeProxyInitializer(lowerer, declaration.initializer)
  )
    return;
  const type = lowerer.mapTypeOf(lowerer.typeOf(declaration.name));
  if (type !== null && typedSlotOfProxy(lowerer, type)?.kind === "class") return;
  let initializer = declaration.initializer!;
  while (ts.isParenthesizedExpression(initializer)) initializer = initializer.expression;
  const handler = (initializer as ts.NewExpression).arguments?.nodes[1];
  lowerer.nativeProxyReads.set(read, {
    trapless:
      handler !== undefined &&
      ts.isObjectLiteralExpression(handler) &&
      handler.properties.nodes.length === 0,
  });
}

/** The Proxy a value is known to be where it is about to enter a typed
 * slot, or null: the `new Proxy` expression itself, or a recorded read of
 * the `const` binding one initializes. */
export function nativeProxyEntering(lowerer: Lowerer, value: IrExpr): { trapless: boolean } | null {
  if (value.kind === "libCall" && value.fn === "dyn.proxyNew") {
    const handler = value.args[1];
    return { trapless: handler?.kind === "dynObjLit" && !handler.fields?.length };
  }
  return lowerer.nativeProxyReads.get(value) ?? null;
}

/** The binding a `new Proxy` expression initializes takes checked-dynamic
 * storage whatever its type says, so no conversion sees the Proxy enter it.
 * A binding typed as a class is refused here: reads of it would be typed as
 * the class everywhere else in the program. */
function refuseProxyClassBinding(lowerer: Lowerer, expr: ts.NewExpression): void {
  let outer: ts.Node = expr;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const declaration = outer.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== outer ||
    !ts.isIdentifier(declaration.name)
  )
    return;
  const type = lowerer.mapTypeOf(lowerer.typeOf(declaration.name));
  if (type === null || typedSlotOfProxy(lowerer, type)?.kind !== "class") return;
  refuseProxyInTypedSlot(lowerer, locOf(expr), type, false);
}

/** A Proxy target written as an asserted object literal (`{} as Config`),
 * or null. The assertion only names the type the checker gives the Proxy:
 * the constructor takes the literal as an untyped object, so neither the
 * assertion's checked conversion (which for a class throws) nor the
 * asserted type's record layout (whose traps the runtime refuses) applies. */
function assertedTargetLiteral(arg: ts.Expression): ts.ObjectLiteralExpression | null {
  let inner = arg;
  let asserted = false;
  for (;;) {
    if (ts.isParenthesizedExpression(inner) || ts.isSatisfiesExpression(inner)) {
      inner = inner.expression;
    } else if (ts.isAsExpression(inner) || ts.isTypeAssertion(inner)) {
      asserted = true;
      inner = inner.expression;
    } else break;
  }
  return asserted && ts.isObjectLiteralExpression(inner) ? inner : null;
}

export function lowerNativeProxy(lowerer: Lowerer, expr: ts.NewExpression): IrExpr {
  const loc = locOf(expr);
  const args = expr.arguments?.nodes ?? [];
  if (args.length !== 2 || args.some(ts.isSpreadElement))
    lowerer.noLowering("new Proxy with this argument list", expr);
  const handler = args[1]!;
  if (isJsSourceFile(ts.getSourceFileOfNode(expr)) && ts.isObjectLiteralExpression(handler)) {
    for (const prop of handler.properties.nodes) {
      const callback = ts.isMethodDeclaration(prop)
        ? prop
        : ts.isPropertyAssignment(prop) &&
            (ts.isFunctionExpression(prop.initializer) || ts.isArrowFunction(prop.initializer))
          ? prop.initializer
          : null;
      if (!callback) continue;
      if (!callback.type) lowerer.runtimeOptionalFunctionReturns.set(callback, DYN);
      // The native trap ABI passes live checked values. Contextual
      // ProxyHandler types include symbols, which this boundary
      // explicitly refuses; they must not force a copying record
      // parameter or an unboxable string|symbol closure signature.
      for (const param of callback.parameters.nodes) {
        if (ts.isIdentifier(param.name) && !param.type && !param.dotDotDotToken)
          lowerer.checkedCallbackParams.add(param);
      }
    }
  }
  const inputs = args.map((arg, index) => {
    const asserted = index === 0 ? assertedTargetLiteral(arg) : null;
    let value = asserted
      ? lowerDynObjectLiteral(lowerer, asserted)
      : ts.isObjectLiteralExpression(arg)
        ? lowerer.lowerExprExpecting(arg, DYN)
        : lowerer.lowerExpr(arg);
    if (value.type.kind !== "dyn" && lowerer.dynConvertible(value.type))
      value = lowerer.coerceToExpected(value, DYN);
    if (value.type.kind !== "dyn") {
      lowerer.unsupported(
        "SC1090",
        arg,
        "Proxy targets and handlers outside checked-native object storage",
      );
    }
    // The runtime's Proxy constructor takes an untyped object as the handler,
    // and an untyped object, a function or a plain record as the target. A
    // handler that reaches it as a reference to typed storage (dynFrom's
    // typed capsule: a record boxed with liveRef, or any class instance), and
    // a target that is a class instance or an array, are refused every time
    // the construction runs, so they are refused here. Other typed targets
    // (a union of records, say) are decided by the value at run time.
    const typed = value.kind === "dynFrom" ? value.value.type : null;
    if (typed !== null) {
      if (
        index === 1 &&
        ((value.kind === "dynFrom" && value.liveRef === true && typed.kind === "record") ||
          typed.kind === "object")
      )
        lowerer.unsupported(
          "SC1090",
          arg,
          "Proxy handlers whose traps have typed signatures",
          "declare each trap's parameters and result as 'any', for example get(target: any, key: string | symbol): any, so the handler is built as an untyped object",
        );
      if (index === 0 && (typed.kind === "object" || typed.kind === "array"))
        lowerer.unsupported(
          "SC1090",
          arg,
          "a Proxy over a class instance or an array",
          "proxy a plain object: an object literal, or a value typed 'any'",
        );
    }
    return value;
  });
  // After the operands, so that an operand the constructor refuses is the
  // diagnostic reported.
  refuseProxyClassBinding(lowerer, expr);
  return { kind: "libCall", fn: "dyn.proxyNew", args: inputs, type: DYN, loc };
}
