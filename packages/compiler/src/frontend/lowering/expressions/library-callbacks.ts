/* A function binding whose storage also holds `undefined` (code can read it
 * before its first store, var-hoisting.ts), handed to a standard library
 * parameter that is declared as a function and does not admit `undefined`:
 * `server.on("error", fail)`, `setTimeout(done, 1)`, `list.forEach(visit)`.
 *
 * The builtin lowerings take the function such a parameter declares, not the
 * binding's undefined-armed storage. The library itself looks at the
 * callback once the call's receiver and every argument are evaluated, and
 * throws for `undefined`: V8's `undefined is not a function` for a default
 * library method, Node's ERR_INVALID_ARG_TYPE for the rest. So the binding
 * is checked at that point and read as its function:
 *
 * - When nothing after the callback in the call can be observed, the read
 *   itself is the check (requiredLibraryCallbackRead): the receiver and the
 *   arguments before it are evaluated by then.
 * - When an argument after it can be observed (`setTimeout(fire, delay())`
 *   runs `delay()`, and an exception it throws wins), the call evaluates
 *   its receiver and arguments in source order, then checks, then runs with
 *   their values (lowerDeferredCallbackCall).
 *
 * A parameter that admits `undefined` (an optional callback, `any`) keeps
 * the stored value, and so does a program function, whose parameter widens
 * with the binding. */
import * as ts from "../../ts7/adapter.js";
import { BOOL, type IrExpr, type IrStmt, type IrType, type SrcLoc, VOID } from "../../../ir/ir.js";
import { nodeThrowExpr, varRef } from "../../../ir/build.js";
import { withoutParentheses, withoutParenthesesTypeWrappers } from "../../outer-expressions.js";
import { isJsSourceFile, locOf } from "../../program.js";
import type { Lowerer } from "../lowerer.js";
import { identifierReadSymbol, sideEffectFreeOptionValue } from "../surfaces.js";

interface RequiredCallback {
  call: ts.CallExpression | ts.NewExpression;
  args: readonly ts.Expression[];
  /** The callback's position among the call's arguments. */
  index: number;
  unionId: string;
  /** The binding's function type and its tag in the stored union. */
  fn: IrType;
  tag: number;
  /** The library's error for `undefined` at this parameter, as a value of
   * `type`. */
  thrown: (type: IrType, loc: SrcLoc) => IrExpr;
}

/** The callback facts of `expr`, an identifier whose binding is stored as
 * `storage`, when it is such an argument; null otherwise. */
function requiredLibraryCallback(
  lowerer: Lowerer,
  expr: ts.Identifier,
  storage: IrType,
): RequiredCallback | null {
  if (storage.kind !== "union") return null;
  const unionId = storage.unionId;
  const arms = lowerer.unions.get(unionId)?.arms;
  const fn = arms?.find((arm) => arm.kind === "func");
  if (arms?.length !== 2 || fn === undefined || !arms.some((arm) => arm.kind === "undefinedT"))
    return null;
  let argument: ts.Expression = expr;
  while (
    (ts.isParenthesizedExpression(argument.parent) ||
      ts.isAssertionExpression(argument.parent) ||
      ts.isSatisfiesExpression(argument.parent) ||
      ts.isNonNullExpression(argument.parent)) &&
    argument.parent.expression === argument
  ) {
    argument = argument.parent;
  }
  const call = argument.parent;
  if (!ts.isCallExpression(call) && !ts.isNewExpression(call)) return null;
  const args = call.arguments?.nodes ?? [];
  const index = args.indexOf(argument);
  if (index < 0 || args.slice(0, index).some(ts.isSpreadElement)) return null;
  const signature = lowerer.checker.getResolvedSignature(call);
  const declaration = signature?.declaration;
  if (signature === undefined || declaration === undefined || !ts.isFunctionLike(declaration))
    return null;
  const file = ts.getSourceFileOfNode(declaration);
  if (!lowerer.isStdlibFile(file)) return null;
  const partsOf = (type: ts.Type): readonly ts.Type[] =>
    (type.flags & ts.TypeFlags.Union) !== 0 ? ts.constituentTypes(type) : [type];
  const isFunction = (type: ts.Type): boolean => lowerer.checker.getCallSignatures(type).length > 0;
  const lenient =
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Null |
    ts.TypeFlags.Void;
  // The types an overload declares for the argument, before the call's type
  // arguments, or null when the overload lets it be omitted or undefined.
  const requiredAt = (
    overload: ts.SignatureDeclaration,
  ): { parameter: ts.ParameterDeclaration; parts: readonly ts.Type[] } | null => {
    const parameter = (
      (overload.parameters?.nodes ?? []) as readonly ts.ParameterDeclaration[]
    ).filter((p) => !(ts.isIdentifier(p.name) && p.name.text === "this"))[index];
    if (
      parameter === undefined ||
      parameter.dotDotDotToken !== undefined ||
      parameter.questionToken !== undefined ||
      parameter.initializer !== undefined
    )
      return null;
    const parts = partsOf(lowerer.checker.getTypeAtLocation(parameter.name));
    return parts.some((part) => (part.flags & lenient) !== 0) ? null : { parameter, parts };
  };
  // Every overload of the callee decides. `JSON.stringify(value)` beside
  // `JSON.stringify(value, replacer)` makes the replacer optional, and
  // `text.replace(pattern, replacement)` beside the replacer overload takes
  // a string there: JavaScript throws for undefined in neither.
  const name = "name" in declaration ? declaration.name : undefined;
  const symbol = name === undefined ? undefined : lowerer.checker.getSymbolAtLocation(name);
  const overloads = (symbol?.declarations ?? []).filter((d) => ts.isFunctionLike(d));
  for (const overload of overloads) {
    const required = requiredAt(overload);
    if (
      required === null ||
      !required.parts.every(
        (part) => isFunction(part) || (part.flags & ts.TypeFlags.Instantiable) !== 0,
      )
    )
      return null;
  }
  // The call's own overload: a bare type parameter (`map.set(key, value)`)
  // is a slot for any value, and the type the call gives the parameter is a
  // function.
  const required = requiredAt(declaration);
  const given = signature.getParameters()[index];
  if (
    required === null ||
    given === undefined ||
    !ts.isIdentifier(required.parameter.name) ||
    required.parts.some((part) => (part.flags & ts.TypeFlags.TypeParameter) !== 0) ||
    !partsOf(lowerer.checker.getTypeOfSymbol(given)).every(isFunction)
  )
    return null;
  const parameterName = required.parameter.name.text;
  const defaultLibrary = lowerer.program.isSourceFileDefaultLibrary(file);
  return {
    call,
    args,
    index,
    unionId,
    fn,
    tag: lowerer.armTag(unionId, fn),
    thrown: (type, loc) =>
      defaultLibrary
        ? nodeThrowExpr(1, "", "undefined is not a function", type, loc)
        : nodeThrowExpr(
            1,
            "ERR_INVALID_ARG_TYPE",
            `The "${parameterName}" argument must be of type function. Received undefined`,
            type,
            loc,
          ),
  };
}

/** The arguments after the callback whose evaluation can be observed. */
function observableAfter(callback: RequiredCallback): ts.Expression[] {
  return callback.args
    .slice(callback.index + 1)
    .filter((later) => ts.isSpreadElement(later) || !sideEffectFreeOptionValue(later));
}

/** The read of such a binding as its function, where the read can stand for
 * the library's check: nothing after it in the call can be observed. Null
 * when the read is not such an argument, and for a call with an observable
 * argument after it that lowerDeferredCallbackCall did not take: the stored
 * value passes on, and the lowering that takes it checks it after its
 * arguments (the timers) or refuses it. */
export function requiredLibraryCallbackRead(
  lowerer: Lowerer,
  expr: ts.Identifier,
  storage: { id: string; type: IrType },
  loc: SrcLoc,
): IrExpr | null {
  const callback = requiredLibraryCallback(lowerer, expr, storage.type);
  if (callback === null || observableAfter(callback).length > 0) return null;
  const { unionId, fn, tag } = callback;
  const value = varRef(storage.id, storage.type, loc);
  return {
    kind: "ternary",
    cond: { kind: "unionIsTag", unionId, tag, negated: false, value, type: BOOL, loc },
    then: { kind: "unionNarrow", unionId, tag, value, type: fn, loc },
    else_: callback.thrown(fn, loc),
    type: fn,
    loc,
  };
}

/** Whether `node` has the same value wherever in the call it is evaluated,
 * and evaluating it cannot be observed: a literal, a function expression,
 * `this`, a name that is not a variable (a function, a class, an enum, a
 * namespace, a library global), or a literal built from these. A variable is
 * not one, whatever declares it: an argument evaluated in between can assign
 * a `let`, a `var`, a parameter or another module's exported binding, and a
 * `const` read before its declaration throws where it is read. */
function isConstantOperand(lowerer: Lowerer, node: ts.Expression): boolean {
  const e = withoutParenthesesTypeWrappers(node);
  if (
    ts.isStringLiteralLike(e) ||
    ts.isNumericLiteral(e) ||
    ts.isBigIntLiteral(e) ||
    ts.isArrowFunction(e) ||
    ts.isFunctionExpression(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    e.kind === ts.SyntaxKind.ThisKeyword ||
    e.kind === ts.SyntaxKind.SuperKeyword
  )
    return true;
  if (ts.isIdentifier(e)) {
    let symbol = identifierReadSymbol(lowerer, e);
    // An import names what the other module declares.
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
      symbol = lowerer.checker.getAliasedSymbol(symbol);
    const declarations = symbol?.declarations ?? [];
    return (
      declarations.length > 0 &&
      declarations.every((d) => {
        const file = ts.getSourceFileOfNode(d);
        if (file.isDeclarationFile || ts.isSourceFile(d) || ts.isModuleDeclaration(d)) return true;
        // JavaScript lets a program assign a function's or a class's name.
        return (
          !isJsSourceFile(file) &&
          (ts.isFunctionDeclaration(d) || ts.isClassDeclaration(d) || ts.isEnumDeclaration(d))
        );
      })
    );
  }
  if (ts.isPrefixUnaryExpression(e))
    return (
      (e.operator === ts.SyntaxKind.MinusToken ||
        e.operator === ts.SyntaxKind.PlusToken ||
        e.operator === ts.SyntaxKind.ExclamationToken) &&
      (ts.isNumericLiteral(e.operand) || ts.isBigIntLiteral(e.operand))
    );
  if (ts.isArrayLiteralExpression(e))
    return e.elements.nodes.every(
      (element) => !ts.isSpreadElement(element) && isConstantOperand(lowerer, element),
    );
  if (ts.isObjectLiteralExpression(e))
    return e.properties.nodes.every(
      (property) =>
        ts.isPropertyAssignment(property) &&
        !ts.isComputedPropertyName(property.name) &&
        isConstantOperand(lowerer, property.initializer),
    );
  return false;
}

/** The operand of the call's callee that is evaluated before the arguments:
 * the receiver of a method call, the callee of a plain call or `new`. Null
 * for a callee of another form, and inside an optional chain, whose
 * receiver the chain has already evaluated. */
function calleeOperand(call: ts.CallExpression | ts.NewExpression): ts.Expression | null {
  if ((call.flags & ts.NodeFlags.OptionalChain) !== 0) return null;
  const callee = withoutParentheses(call.expression);
  if (ts.isIdentifier(callee)) return callee;
  if (ts.isPropertyAccessExpression(callee)) return callee.expression;
  return null;
}

/** Whether `value` reads the local `id`. */
function readsLocal(value: unknown, id: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => readsLocal(entry, id));
  if (value === null || typeof value !== "object") return false;
  const node = value as { kind?: unknown; localId?: unknown };
  if (node.kind === "varRef" && node.localId === id) return true;
  for (const key in value) {
    if (key !== "type" && key !== "loc" && readsLocal((value as Record<string, unknown>)[key], id))
      return true;
  }
  return false;
}

/** A call that hands such a binding to a required library callback and has
 * an argument after it whose evaluation can be observed. JavaScript
 * evaluates the receiver, then each argument in order (the read of the
 * binding among them), and only then does the library refuse an undefined
 * callback. So the call is lowered as its operands in that order, each into
 * a hidden local, then the check, then the call itself over those values:
 * `list.forEach(visit, (list = other, self))` iterates the array `list` held
 * when the call began. An operand that is the same wherever it is evaluated
 * (isConstantOperand) stays in the call. The call's lowering has to read
 * every value it is handed; a call whose lowering does not (it takes an
 * operand apart instead of evaluating it) is refused, since that operand
 * would run twice. Null for every other call, and for a callee of a form
 * this does not hold a value for: there the callback keeps the stored
 * value. */
export function lowerDeferredCallbackCall(
  lowerer: Lowerer,
  call: ts.CallExpression | ts.NewExpression,
): IrExpr | null {
  const args = call.arguments?.nodes ?? [];
  for (let index = 0; index < args.length - 1; index++) {
    const expr = withoutParenthesesTypeWrappers(args[index]!);
    if (!ts.isIdentifier(expr)) continue;
    // This call is being lowered over its held operands, the callback among
    // them (below): nothing is left to hold.
    if (lowerer.chainRecvByNode.has(expr)) return null;
    const symbol = identifierReadSymbol(lowerer, expr);
    if (symbol === undefined || !lowerer.earlyReadVars.has(symbol)) continue;
    const first = calleeOperand(call);
    if (first === null || args.some(ts.isSpreadElement)) return null;
    const storage = lowerer.resolveLocal(expr) ?? lowerer.globalOf(expr);
    if (storage === null) return null;
    const callback = requiredLibraryCallback(lowerer, expr, storage.type);
    if (callback === null || observableAfter(callback).length === 0) return null;
    const { unionId, fn, tag } = callback;
    const loc = locOf(expr);
    const stmts: IrStmt[] = [];
    const overrides: { node: ts.Expression; value: IrExpr }[] = [];
    const temps: { node: ts.Expression; id: string }[] = [];
    // An operand's value where the source evaluates it; false when it has
    // none to hold.
    const hold = (node: ts.Expression): boolean => {
      if (isConstantOperand(lowerer, node)) return true;
      const value = lowerer.lowerExpr(node);
      if (value.type.kind === "void") return false;
      const temp = lowerer.declareHiddenLocal("%callOperand", value.type);
      const at = locOf(node);
      stmts.push({ kind: "varDecl", localId: temp.id, init: value, loc: at });
      // A lowering may look through parentheses and type wrappers before it
      // evaluates the operand: each of those nodes stands for the value.
      for (let inner: ts.Expression = node; ; inner = inner.expression) {
        overrides.push({ node: inner, value: varRef(temp.id, temp.type, at) });
        if (
          !ts.isParenthesizedExpression(inner) &&
          !ts.isAssertionExpression(inner) &&
          !ts.isSatisfiesExpression(inner) &&
          !ts.isNonNullExpression(inner)
        )
          break;
      }
      temps.push({ node, id: temp.id });
      return true;
    };
    if (!hold(first) || !args.slice(0, index).every(hold)) return null;
    const held = lowerer.declareHiddenLocal("%callbackArg", storage.type);
    const heldRef = varRef(held.id, held.type, loc);
    stmts.push({
      kind: "varDecl",
      localId: held.id,
      init: varRef(storage.id, storage.type, loc),
      loc,
    });
    overrides.push({
      node: expr,
      value: { kind: "unionNarrow", unionId, tag, value: heldRef, type: fn, loc },
    });
    if (!args.slice(index + 1).every(hold)) return null;
    stmts.push({
      kind: "if",
      cond: { kind: "unionIsTag", unionId, tag, negated: true, value: heldRef, type: BOOL, loc },
      then: [{ kind: "exprStmt", expr: callback.thrown(VOID, loc), loc }],
      else_: null,
      loc,
    });
    const result = lowerer.withExpressionOverrides(overrides, () => lowerer.lowerExpr(call));
    for (const temp of temps) {
      if (!readsLocal(result, temp.id))
        lowerer.unsupported(
          "SC1090",
          temp.node,
          "this operand of a call whose callback may be undefined (give the callback's binding its value where it is declared)",
        );
    }
    return { kind: "seqExpr", stmts, result, type: result.type, loc: locOf(call) };
  }
  return null;
}
