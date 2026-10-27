import * as ts from "../../ts7/adapter.js";
import { type Lowerer, PoisonError } from "../lowerer.js";
import { locOf } from "../../program.js";
import { webAssemblyDiag } from "../../../diagnostics/diagnostic.js";
import { BOOL, DYN, F64, STRING, type IrExpr } from "../../../ir/ir.js";
import { dynUndefinedExpr } from "../../../ir/build.js";
import { lowerDynObjectLiteral } from "../expressions/object-literals.js";
import { stdlibGlobalNameOf } from "../surfaces.js";
import { isWebAssemblyType } from "../../type-mapper.js";

/* The WebAssembly API. scriptc.d.ts declares its types (lib.dom's
 * namespace) and the type mapper gives them the checked-dynamic
 * representation. Modules whose bytes the build sees are translated to
 * native code (wasm/translate.ts) and found at run time by the SHA-256 of
 * their bytes (scr_wasm.c):
 *   - WebAssembly.compile, instantiate and validate calls, new
 *     WebAssembly.Module, Instance, Memory, Table and Global, and
 *     WebAssembly.Module.imports, exports and customSections lower to
 *     wasm.* libCalls; members of the values they produce (exports, memory
 *     buffers, globals, tables) dispatch through the native handles;
 *   - the classes called without `new` throw Node's TypeError
 *     (wasm.withoutNew);
 *   - `v instanceof WebAssembly.<Class>` lowers to wasm.is;
 *   - the error classes construct with or without `new` (wasm.errorNew).
 * Every other reached use of the API value (the classes as values, the
 * streaming functions, Tag and Exception) still fences at its expression
 * with webAssemblyDiag: a build error in TypeScript sources, a located
 * runtime fence in JavaScript ones. typeof needs no value and folds to Node's
 * answer. A lowering marks the lowerer, so the build translates the
 * modules it discovers (lowerToIr). */

/** The classes `wasm.is` answers, by kind. */
const WASM_CLASSES = [
  "Module",
  "Instance",
  "Memory",
  "Table",
  "Global",
  "CompileError",
  "LinkError",
  "RuntimeError",
] as const;
/** Strips the spellings that leave a value unchanged: parentheses, type
 * assertions, `satisfies` and non-null assertions. */
function bare(expr: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) expr = expr.expression;
    else if (ts.isAsExpression(expr) || ts.isTypeAssertion(expr)) expr = expr.expression;
    else if (ts.isSatisfiesExpression(expr)) expr = expr.expression;
    else return expr;
  }
}

/** The global object itself, as `globalThis` or `global` spells it. */
function isGlobalThis(lowerer: Lowerer, expr: ts.Expression): boolean {
  const node = bare(expr);
  return (
    ts.isIdentifier(node) &&
    (node.text === "globalThis" || node.text === "global") &&
    stdlibGlobalNameOf(lowerer, node) === "globalThis"
  );
}

/** THE WebAssembly namespace value: `WebAssembly` or `globalThis.WebAssembly`
 * (and the global object reached through a cast, as in
 * `(globalThis as any).WebAssembly`). */
function isWebAssemblyGlobal(lowerer: Lowerer, expr: ts.Expression): boolean {
  expr = bare(expr);
  if (ts.isIdentifier(expr)) {
    return expr.text === "WebAssembly" && stdlibGlobalNameOf(lowerer, expr) === "WebAssembly";
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return expr.name.text === "WebAssembly" && isGlobalThis(lowerer, expr.expression);
  }
  if (ts.isElementAccessExpression(expr)) {
    const key = expr.argumentExpression;
    return (
      (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) &&
      key.text === "WebAssembly" &&
      isGlobalThis(lowerer, expr.expression)
    );
  }
  return false;
}

/** The surface a WebAssembly API expression names ('WebAssembly',
 * 'globalThis.WebAssembly', 'WebAssembly.compile'), or null. A cheap
 * spelling check runs first: almost every expression is rejected without a
 * checker query. */
function webAssemblySurface(lowerer: Lowerer, expr: ts.Expression): string | null {
  // `globalThis as unknown as { WebAssembly: ... }`: the cast's target type
  // names the member, and the value it checks is the global object's
  // WebAssembly (the spelling pi's codemode uses).
  if (
    (ts.isAsExpression(expr) || ts.isTypeAssertion(expr)) &&
    isGlobalThis(lowerer, expr.expression)
  ) {
    const target = lowerer.checker.getTypeAtLocation(expr.type);
    const member = lowerer.checker.getPropertyOfType(target, "WebAssembly");
    // A target built from `typeof globalThis` (`typeof globalThis & { key?: T }`)
    // inherits the global's own WebAssembly declaration: that cast names the
    // whole global object, whose other properties stay readable and writable.
    const globalMember = lowerer.checker.getPropertyOfType(
      lowerer.typeOf(bare(expr.expression)),
      "WebAssembly",
    );
    return member !== undefined && member !== globalMember ? "globalThis.WebAssembly" : null;
  }
  const node = bare(expr);
  if (ts.isIdentifier(node)) {
    return node.text === "WebAssembly" && isWebAssemblyGlobal(lowerer, node) ? "WebAssembly" : null;
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (node.name.text === "WebAssembly") {
      return isWebAssemblyGlobal(lowerer, node) ? "globalThis.WebAssembly" : null;
    }
    // WebAssembly.<member>, and members of members
    // (WebAssembly.Module.customSections).
    const names = [node.name.text];
    let receiver = bare(node.expression);
    while (ts.isPropertyAccessExpression(receiver) && receiver.name.text !== "WebAssembly") {
      names.unshift(receiver.name.text);
      receiver = bare(receiver.expression);
    }
    const spelled =
      (ts.isIdentifier(receiver) && receiver.text === "WebAssembly") ||
      (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "WebAssembly");
    return spelled && isWebAssemblyGlobal(lowerer, receiver)
      ? `WebAssembly.${names.join(".")}`
      : null;
  }
  if (ts.isElementAccessExpression(node)) {
    return isWebAssemblyGlobal(lowerer, node) ? "globalThis.WebAssembly" : null;
  }
  return null;
}

/** Fences a reached use of the WebAssembly API. `prefix` qualifies a
 * construction ('new '). Returns normally when `expr` is anything else. */
export function refuseWebAssemblyUse(lowerer: Lowerer, expr: ts.Expression, prefix = ""): void {
  const surface = webAssemblySurface(lowerer, expr);
  if (surface === null) return;
  lowerer.pushDiag(webAssemblyDiag(`${prefix}${surface}`, locOf(expr)));
  throw new PoisonError();
}

/** `typeof WebAssembly` is "object" and `typeof WebAssembly.<member>` is
 * "function" for every member the namespace declares, as in Node. The
 * operand is an effect-free global read, so nothing else evaluates. */
export function lowerWebAssemblyTypeof(lowerer: Lowerer, operand: ts.Expression): IrExpr | null {
  const surface = webAssemblySurface(lowerer, operand);
  if (surface === null) return null;
  const loc = locOf(operand);
  if (surface === "WebAssembly" || surface === "globalThis.WebAssembly") {
    return { kind: "strLit", value: "object", type: STRING, loc };
  }
  const t = lowerer.typeOf(operand);
  if (
    lowerer.checker.getCallSignatures(t).length > 0 ||
    lowerer.checker.getConstructSignatures(t).length > 0
  ) {
    return { kind: "strLit", value: "function", type: STRING, loc };
  }
  return null;
}

/** The member `WebAssembly.<member>` names (any spelling of the namespace),
 * or null. */
function webAssemblyMember(lowerer: Lowerer, expr: ts.Expression): string | null {
  const surface = webAssemblySurface(lowerer, expr);
  if (surface === null || !surface.startsWith("WebAssembly.")) return null;
  const member = surface.slice("WebAssembly.".length);
  return member.includes(".") ? null : member;
}

function lowerArg(lowerer: Lowerer, arg: ts.Expression): IrExpr {
  return ts.isObjectLiteralExpression(arg)
    ? lowerDynObjectLiteral(lowerer, arg)
    : lowerer.lowerExprExpecting(arg, DYN);
}

/** An argument whose evaluation has no effect: a literal, a plain
 * identifier, or an empty object or array literal. */
function isInert(arg: ts.Expression): boolean {
  const node = bare(arg);
  if (ts.isObjectLiteralExpression(node)) return node.properties.nodes.length === 0;
  if (ts.isArrayLiteralExpression(node)) return node.elements.nodes.length === 0;
  return (
    ts.isIdentifier(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.BigIntLiteral ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword
  );
}

/** The arguments, padded with undefined to `count`. Extra arguments are
 * ignored, as the API ignores them, when evaluating them has no effect;
 * null for spreads or other extra arguments (they stay refused). */
function lowerArgs(
  lowerer: Lowerer,
  args: readonly ts.Expression[],
  count: number,
  loc: IrExpr["loc"],
): IrExpr[] | null {
  if (args.some(ts.isSpreadElement)) return null;
  if (args.length > count) {
    if (!args.slice(count).every(isInert)) return null;
    args = args.slice(0, count);
  }
  const out = args.map((arg) => lowerArg(lowerer, arg));
  while (out.length < count) out.push(dynUndefinedExpr(loc));
  return out;
}

function errorNew(member: string, args: IrExpr[], loc: IrExpr["loc"]): IrExpr {
  const kind = (WASM_CLASSES as readonly string[]).indexOf(member);
  return {
    kind: "libCall",
    fn: "wasm.errorNew",
    args: [{ kind: "numLit", value: kind, type: F64, loc }, args[0]!, args[1]!],
    type: DYN,
    loc,
  };
}

/** The classes that require `new`, in wasm.withoutNew's numbering. */
const NEW_ONLY = ["Module", "Instance", "Memory", "Table", "Global"];

/** `WebAssembly.Module.imports(module)`, `exports(module)` and
 * `customSections(module, name)`. Their results are arrays of descriptors
 * or ArrayBuffers built as checked-dynamic values, then taken into the
 * call's own type. Null for anything else. */
function lowerModuleStatic(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  const surface = webAssemblySurface(lowerer, call.expression);
  const name = surface?.startsWith("WebAssembly.Module.")
    ? surface.slice("WebAssembly.Module.".length)
    : null;
  if (name !== "imports" && name !== "exports" && name !== "customSections") return null;
  const loc = locOf(call);
  const args = lowerArgs(lowerer, call.arguments.nodes, name === "customSections" ? 2 : 1, loc);
  if (args === null) return null;
  lowerer.usesWebAssembly = true;
  if (name === "customSections") lowerer.usesWasmCustomSections = true;
  const fn =
    name === "imports"
      ? "wasm.moduleImports"
      : name === "exports"
        ? "wasm.moduleExports"
        : "wasm.moduleCustomSections";
  const result: IrExpr = { kind: "libCall", fn, args, type: DYN, loc };
  return lowerer.coerceInto(call, result, lowerer.irTypeOf(call));
}

/** `WebAssembly.compile(bytes)`, `WebAssembly.instantiate(source,
 * imports?)`, `WebAssembly.validate(bytes)`, the error classes called
 * without `new`, the other classes called without `new` (a TypeError), and
 * Module's static functions. Null for anything else. */
export function lowerWebAssemblyCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (call.questionDotToken) return null;
  const member = webAssemblyMember(lowerer, call.expression);
  if (member === null) return lowerModuleStatic(lowerer, call);
  const loc = locOf(call);
  const newOnly = NEW_ONLY.indexOf(member);
  if (newOnly >= 0) {
    // The arguments evaluate, then the call throws.
    const args = lowerArgs(lowerer, call.arguments.nodes, 2, loc);
    if (args === null) return null;
    lowerer.usesWebAssembly = true;
    return {
      kind: "libCall",
      fn: "wasm.withoutNew",
      args: [{ kind: "numLit", value: newOnly, type: F64, loc }, args[0]!, args[1]!],
      type: DYN,
      loc,
    };
  }
  const isError = member === "CompileError" || member === "LinkError" || member === "RuntimeError";
  if (member !== "compile" && member !== "instantiate" && member !== "validate" && !isError)
    return null;
  const used = member === "instantiate" || isError ? 2 : 1;
  const args = lowerArgs(lowerer, call.arguments.nodes, used, loc);
  if (args === null) return null;
  lowerer.usesWebAssembly = true;
  let result: IrExpr;
  if (isError) result = errorNew(member, args, loc);
  else if (member === "validate")
    result = { kind: "libCall", fn: "wasm.validate", args: [args[0]!], type: BOOL, loc };
  else if (member === "compile")
    result = {
      kind: "libCall",
      fn: "wasm.compile",
      args: [args[0]!],
      type: { kind: "promise", inner: DYN },
      loc,
    };
  else
    result = {
      kind: "libCall",
      fn: "wasm.instantiate",
      args: [args[0]!, args[1]!],
      type: { kind: "promise", inner: DYN },
      loc,
    };
  return result;
}

/** `new WebAssembly.Module(bytes)`, `new WebAssembly.Instance(module,
 * imports?)`, `new WebAssembly.Memory(descriptor)`, `new
 * WebAssembly.Table(descriptor, value?)`, `new
 * WebAssembly.Global(descriptor, value?)` and the error classes. Null for
 * anything else. */
export function lowerWebAssemblyNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  const member = webAssemblyMember(lowerer, expr.expression);
  if (member === null) return null;
  const isError = member === "CompileError" || member === "LinkError" || member === "RuntimeError";
  if (!NEW_ONLY.includes(member) && !isError) return null;
  const loc = locOf(expr);
  const used = member === "Module" || member === "Memory" ? 1 : 2;
  const args = lowerArgs(lowerer, expr.arguments?.nodes ?? [], used, loc);
  if (args === null) return null;
  lowerer.usesWebAssembly = true;
  let result: IrExpr;
  if (isError) result = errorNew(member, args, loc);
  else if (member === "Module")
    result = { kind: "libCall", fn: "wasm.moduleNew", args: [args[0]!], type: DYN, loc };
  else if (member === "Memory")
    result = { kind: "libCall", fn: "wasm.memoryNew", args: [args[0]!], type: DYN, loc };
  else if (member === "Table")
    result = { kind: "libCall", fn: "wasm.tableNew", args: [args[0]!, args[1]!], type: DYN, loc };
  else if (member === "Global")
    result = { kind: "libCall", fn: "wasm.globalNew", args: [args[0]!, args[1]!], type: DYN, loc };
  else
    result = {
      kind: "libCall",
      fn: "wasm.instanceNew",
      args: [args[0]!, args[1]!],
      type: DYN,
      loc,
    };
  return result;
}

/** `v instanceof WebAssembly.<Class>`. Null for anything else. */
export function lowerWebAssemblyInstanceof(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  const member = webAssemblyMember(lowerer, expr.right);
  if (member === null) return null;
  const kind = (WASM_CLASSES as readonly string[]).indexOf(member);
  if (kind < 0) return null;
  const loc = locOf(expr);
  lowerer.usesWebAssembly = true;
  const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
  return {
    kind: "libCall",
    fn: "wasm.is",
    args: [value, { kind: "numLit", value: kind, type: F64, loc }],
    type: BOOL,
    loc,
  };
}

/** WebAssembly API values: `WebAssembly.compile`, `instantiate` and
 * `validate` read as functions, the namespace itself (`WebAssembly`,
 * `globalThis.WebAssembly`), and the global object cast to a type with a
 * `WebAssembly` member (pi codemode's spelling). Null for anything else,
 * which refuseWebAssemblyUse then fences. */
export function lowerWebAssemblyValue(lowerer: Lowerer, expr: ts.Expression): IrExpr | null {
  const surface = webAssemblySurface(lowerer, expr);
  if (surface === null) return null;
  const loc = locOf(expr);
  const node = bare(expr);
  const fn = (name: string, args: IrExpr[]): IrExpr => {
    lowerer.usesWebAssembly = true;
    return { kind: "libCall", fn: name as "wasm.namespace", args, type: DYN, loc };
  };
  if (surface === "globalThis.WebAssembly") {
    // The cast spelling names the global object, not its member.
    const cast =
      (ts.isAsExpression(expr) || ts.isTypeAssertion(expr)) &&
      isGlobalThis(lowerer, expr.expression);
    return cast ? fn("wasm.globalView", []) : fn("wasm.namespace", []);
  }
  if (surface === "WebAssembly") return fn("wasm.namespace", []);
  const index = ["WebAssembly.compile", "WebAssembly.instantiate", "WebAssembly.validate"].indexOf(
    surface,
  );
  if (index < 0 || !ts.isPropertyAccessExpression(node)) return null;
  return fn("wasm.function", [{ kind: "numLit", value: index, type: F64, loc }]);
}

/** `global.valueOf()` on a receiver typed as a WebAssembly value: a
 * Global answers its value (the generic dyn.valueOf answers the object
 * itself for native handles other than Date). Null for other receivers. */
export function lowerWebAssemblyValueOf(
  lowerer: Lowerer,
  receiver: ts.Expression,
  recv: IrExpr,
  loc: IrExpr["loc"],
): IrExpr | null {
  const ctx = {
    checker: lowerer.checker,
    isStdlibFile: (sf: ts.SourceFile) => lowerer.isStdlibFile(sf),
  };
  if (!isWebAssemblyType(lowerer.typeOf(receiver), ctx)) return null;
  lowerer.usesWebAssembly = true;
  return { kind: "libCall", fn: "wasm.valueOf", args: [recv], type: DYN, loc };
}
