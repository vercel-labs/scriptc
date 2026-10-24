/* typeof expressions and the typeof tests they lower to. */
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import {
  BOOL,
  CAUGHT,
  DYN,
  type IrExpr,
  type IrStmt,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
} from "../../../ir/ir.js";
import { lowerWebAssemblyTypeof } from "../builtins/webassembly.js";
import { isNavigatorGlobal } from "../builtins/navigator.js";
import { processHasIpc } from "../builtins/process.js";
import { lowerPerfHooksTypeof } from "../builtins/performance.js";
import { isNodeModuleValue } from "../lower-node-module.js";
import { builtinClassRefOf } from "../builtins/class-values.js";
import { STRING_INDEX_METHODS, builtinModuleConstOf, stdlibGlobalNameOf } from "../surfaces.js";
import {
  constructorGlobalTypeof,
  deferredSlotOr,
  errorRootedObjectOf,
  lowerPromiseThenPresence,
  operandPairs,
  runtimeOptionalStorageOperand,
  typeofAnswer,
} from "../lower-exprs.js";
import { tryLowerExpression } from "./try-lower-expression.js";
import { isJsSourceFile, isNodeEsmFile } from "../../program.js";
import { isSafeToDiscard, isSafeToRepeat } from "./evaluation-safety.js";
import { varRef } from "../../../ir/build.js";
import { isExecExceptionType, refuseExecExceptionCode } from "../builtins/errors.js";
import { InternalCompilerError } from "../../../errors.js";
import { TEMPORAL_GLOBAL } from "../../builtin-modules.js";
import { isTemporalGlobalRoot } from "../lower-namespaces.js";

export function lowerTypeofExpr(lowerer: Lowerer, expr: ts.TypeOfExpression, loc: SrcLoc): IrExpr {
  const webAssembly = lowerWebAssemblyTypeof(lowerer, expr.expression);
  if (webAssembly) return webAssembly;
  if (lowerer.isStdlibGlobal(expr.expression, "process"))
    return { kind: "strLit", value: "object", type: STRING, loc };
  {
    let operand = expr.expression;
    while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
    const ipcMember =
      ts.isPropertyAccessExpression(operand) && !operand.questionDotToken
        ? lowerer.stdlibGlobalMember(operand, "process")
        : null;
    if (ipcMember === "send" || ipcMember === "disconnect") {
      return {
        kind: "ternary",
        cond: processHasIpc(lowerer, loc),
        then: { kind: "strLit", value: "function", type: STRING, loc },
        else_: { kind: "strLit", value: "undefined", type: STRING, loc },
        type: STRING,
        loc,
      };
    }
  }
  if (lowerer.isStdlibGlobal(expr.expression, "fetch"))
    return { kind: "strLit", value: "function", type: STRING, loc };
  // `__dirname` / `__filename` in a JavaScript ES module, where Node never
  // defines them: typeof answers "undefined" instead of throwing.
  {
    let operand = expr.expression;
    while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
    if (
      ts.isIdentifier(operand) &&
      (operand.text === "__dirname" || operand.text === "__filename") &&
      lowerer.isStdlibGlobal(operand, operand.text)
    ) {
      const sf = ts.getSourceFileOfNode(operand);
      if (isNodeEsmFile(sf, lowerer.program) && !/\.tsx?$/.test(sf.fileName))
        return { kind: "strLit", value: "undefined", type: STRING, loc };
    }
  }
  if (isNavigatorGlobal(lowerer, expr.expression))
    return { kind: "strLit", value: "object", type: STRING, loc };
  const performance = lowerPerfHooksTypeof(lowerer, expr.expression);
  if (performance) return performance;
  if (isNodeModuleValue(lowerer, expr.expression)) {
    return { kind: "strLit", value: "object", type: STRING, loc };
  }
  // `typeof EventEmitter`, `typeof zlib.Gzip`, `typeof C` over a
  // builtin class alias.
  if (builtinClassRefOf(lowerer, expr.expression) !== null) {
    return { kind: "strLit", value: "function", type: STRING, loc };
  }
  // The Buffer constructor and its aliases (`const B = globalThis.Buffer`,
  // `(globalThis as { Buffer?: B }).Buffer`): a value read of an alias is an
  // identity token, so its typeof is decided here.
  if (stdlibGlobalNameOf(lowerer, expr.expression) === "Buffer") {
    return { kind: "strLit", value: "function", type: STRING, loc };
  }
  if (ts.isPropertyAccessExpression(expr.expression)) {
    const member = expr.expression;
    const prototype = member.expression;
    if (
      STRING_INDEX_METHODS.has(member.name.text) &&
      ts.isPropertyAccessExpression(prototype) &&
      prototype.name.text === "prototype" &&
      ts.isIdentifier(prototype.expression) &&
      lowerer.isStdlibGlobal(prototype.expression, "String") &&
      lowerer.isStdlibMember(member)
    ) {
      return { kind: "strLit", value: "function", type: STRING, loc };
    }
    if (
      member.name.text === "at" &&
      ts.isPropertyAccessExpression(prototype) &&
      prototype.name.text === "prototype" &&
      ts.isIdentifier(prototype.expression) &&
      lowerer.isStdlibGlobal(prototype.expression, "Array") &&
      lowerer.isStdlibMember(member)
    ) {
      return { kind: "strLit", value: "function", type: STRING, loc };
    }
    const presence = lowerPromiseThenPresence(lowerer, expr.expression, {
      kind: "strLit",
      value: "function",
      type: STRING,
      loc,
    });
    if (presence !== null) return presence;
  }
  // `typeof queueMicrotask` / `typeof DOMException` on a STDLIB global
  // whose declared type is callable or constructable: folds to
  // "function" BEFORE the operand lowers — the identity-token story
  // (JS files) deliberately represents these values as strings, and
  // the TS-file fence would name a value the program never needs; an
  // identifier read has no side effects to preserve. Node's answer for
  // every function and constructor global is "function" (the harness's
  // `typeof queueMicrotask === 'function'` probes). Shadowing locals
  // have non-stdlib symbols and keep the ordinary path.
  let tested = expr.expression;
  while (ts.isParenthesizedExpression(tested)) tested = tested.expression;
  // `typeof zlib.Inflate` / `typeof zlib.createGzip`: an export of a
  // Node builtin module read through a plain binding (an import or
  // require result). The read has no side effects, and Node's answer for
  // every exported function and class is "function".
  if (
    ts.isPropertyAccessExpression(tested) &&
    ts.isIdentifier(tested.expression) &&
    lowerer.isStdlibMember(tested)
  ) {
    const sym = lowerer.checker.getSymbolAtLocation(tested.name);
    const decls = sym ? sym.declarations : [];
    if (
      decls.some(isBuiltinModuleValueDecl) &&
      decls.every((decl) => builtinModuleExportParent(decl) !== undefined)
    ) {
      const t = lowerer.typeOf(tested);
      if (
        lowerer.checker.getCallSignatures(t).length > 0 ||
        lowerer.checker.getConstructSignatures(t).length > 0
      ) {
        return { kind: "strLit", value: "function", type: STRING, loc };
      }
    }
  }
  // `typeof globalThis.AbortSignal` / `typeof Headers`: Node 24's Web
  // platform constructor globals are functions. JavaScript sources
  // represent such a value as an identity token, and the fallback
  // declarations type some (AbortSignal) without a construct signature,
  // so neither the operand nor the type can answer; the read has no
  // effects.
  // `typeof globalThis.<temporal>`: the global object has no such
  // property in Node 24.
  if (
    ts.isPropertyAccessExpression(tested) &&
    tested.name.text === TEMPORAL_GLOBAL &&
    stdlibGlobalNameOf(lowerer, tested.expression) === "globalThis"
  ) {
    return { kind: "strLit", value: "undefined", type: STRING, loc };
  }
  if (constructorGlobalTypeof(lowerer, tested) !== null)
    return { kind: "strLit", value: "function", type: STRING, loc };
  // `typeof global.setTimeout` / `typeof globalThis.queueMicrotask`: a
  // callable standard-library global read through the global object
  // answers like its bare spelling (JavaScript sources represent the
  // value as an identity token, so the operand cannot answer).
  if (ts.isPropertyAccessExpression(tested) && !tested.questionDotToken) {
    const name = stdlibGlobalNameOf(lowerer, tested);
    if (name !== null && name !== "globalThis") {
      const t = lowerer.typeOf(tested);
      if (
        lowerer.checker.getCallSignatures(t).length > 0 ||
        lowerer.checker.getConstructSignatures(t).length > 0
      )
        return { kind: "strLit", value: "function", type: STRING, loc };
    }
  }
  // `typeof globalThis.AbortSignal.any` (ky's feature probe): a static
  // member of a standard-library global, declared callable, whose value
  // has no representation. The read has no effects and Node's answer
  // for every such function is "function"; members that lower as values
  // keep their own answer.
  if (ts.isPropertyAccessExpression(tested) && !tested.questionDotToken) {
    const owner = stdlibGlobalNameOf(lowerer, tested.expression);
    if (owner !== null && lowerer.isStdlibMember(tested)) {
      const t = lowerer.typeOf(tested);
      if (
        (lowerer.checker.getCallSignatures(t).length > 0 ||
          lowerer.checker.getConstructSignatures(t).length > 0) &&
        tryLowerExpression(lowerer, tested) === null
      )
        return { kind: "strLit", value: "function", type: STRING, loc };
    }
  }
  if (ts.isIdentifier(tested)) {
    const sym = lowerer.checker.getSymbolAtLocation(tested);
    if (!sym) {
      return { kind: "strLit", value: "undefined", type: STRING, loc };
    }
    // Node 24 defines no temporal global: typeof answers "undefined"
    // without reading it, like any undeclared name.
    if (isTemporalGlobalRoot(lowerer, tested, sym)) {
      return { kind: "strLit", value: "undefined", type: STRING, loc };
    }
    // `const { inspect } = require("util")` / `import { inspect } from
    // "node:util"`: a binding of a builtin module's exported function,
    // class or object. JavaScript sources represent such a value without
    // its own lowering as an identity token (a string), so the operand's
    // representation cannot answer. Node's answer follows the export's
    // kind, and the binding read has no effects.
    const imported = isJsSourceFile(ts.getSourceFileOfNode(tested))
      ? lowerer.builtinImportOf(tested)
      : null;
    if (imported && builtinModuleConstOf(lowerer, imported.module, imported.member) === undefined) {
      const t = lowerer.typeOf(tested);
      if (
        lowerer.checker.getCallSignatures(t).length > 0 ||
        lowerer.checker.getConstructSignatures(t).length > 0
      ) {
        return { kind: "strLit", value: "function", type: STRING, loc };
      }
      if ((t.flags & ts.TypeFlags.Object) !== 0) {
        return { kind: "strLit", value: "object", type: STRING, loc };
      }
    }
    if (lowerer.isStdlibSymbol(sym)) {
      const t = lowerer.typeOf(expr.expression);
      if (
        lowerer.checker.getCallSignatures(t).length > 0 ||
        lowerer.checker.getConstructSignatures(t).length > 0
      ) {
        return { kind: "strLit", value: "function", type: STRING, loc };
      }
    }
  }
  // A known static result type fixes typeof's answer, but its producer
  // still evaluates: calls, getters, and checked reads can have effects
  // or throw. Only trivial operands may disappear.
  let operand = deferredSlotOr(
    lowerer,
    runtimeOptionalStorageOperand(lowerer, expr.expression) ?? lowerer.lowerExpr(expr.expression),
  );

  // A checker-narrowed dyn read arrives as a VALIDATED extraction
  // (maybeNarrow's dynCheck bridge). typeof needs no extraction — the
  // dyn kind table answers the question directly, and answers it even
  // where the flow type lied (the extraction would throw instead) —
  // so unwrap back to the dyn value and take the dyn.typeof path.
  if (operand.kind === "dynCheck" && operand.value.type.kind === "dyn") {
    operand = operand.value;
  }
  const FOLD: Partial<Record<string, string>> = {
    f64: "number",
    bigint: "bigint",
    string: "string",
    bool: "boolean",
    func: "function",
    array: "object",
    object: "object",
    record: "object",
    symbol: "symbol",
    map: "object",
    set: "object",
    promise: "object",
    bytes: "object",
    regex: "object",
    date: "object",
    generator: "object",
    classval: "function",
    moduleNs: "object",
    undefinedT: "undefined",
    nullT: "object",
  };
  const folded = FOLD[operand.type.kind];
  if (folded) {
    const result: IrExpr = { kind: "strLit", value: folded, type: STRING, loc };
    return isSafeToDiscard(operand)
      ? result
      : {
          kind: "seqExpr",
          stmts: [{ kind: "exprStmt", expr: operand, loc }],
          result,
          type: STRING,
          loc,
        };
  }
  // A union operand: every arm's typeof answer is static, so the value
  // form is a ternary chain over runtime TAG tests (arms grouped by
  // answer; the last group needs no test). The operand rides several
  // tests, so only side-effect-free reads compose — and when every arm
  // agrees the whole expression folds to that one string (dropping only
  // the pure read, the trust-the-checker bet lowerUnitComparison makes).
  // An effectful producer (a getter) evaluates once into a hidden local.
  const prelude: IrStmt[] = [];
  if (operand.type.kind === "union" && !isSafeToRepeat(operand)) {
    const local = lowerer.declareHiddenLocal("%typeofOperand", operand.type);
    prelude.push({ kind: "varDecl", localId: local.id, init: operand, loc });
    operand = varRef(local.id, operand.type, loc);
  }
  if (operand.type.kind === "union" && isSafeToRepeat(operand)) {
    const def = lowerer.unions.get(operand.type.unionId);
    const answers = def?.arms.map(typeofAnswer);
    if (def && answers && answers.every((s): s is string => s !== null)) {
      const groups = new Map<string, number[]>();
      answers.forEach((s, i) => groups.set(s, [...(groups.get(s) ?? []), i]));
      const ordered = [...groups.entries()];
      let result: IrExpr = {
        kind: "strLit",
        value: ordered[ordered.length - 1]![0],
        type: STRING,
        loc,
      };
      for (const [answer, tags] of ordered.slice(0, -1).reverse()) {
        let test: IrExpr = {
          kind: "unionIsTag",
          unionId: operand.type.unionId,
          tag: tags[0]!,
          negated: false,
          value: operand,
          type: BOOL,
          loc,
        };
        for (const t of tags.slice(1)) {
          test = {
            kind: "logical",
            op: "||",
            left: test,
            right: {
              kind: "unionIsTag",
              unionId: operand.type.unionId,
              tag: t,
              negated: false,
              value: operand,
              type: BOOL,
              loc,
            },
            type: BOOL,
            loc,
          };
        }
        result = {
          kind: "ternary",
          cond: test,
          then: { kind: "strLit", value: answer, type: STRING, loc },
          else_: result,
          type: STRING,
          loc,
        };
      }
      return prelude.length > 0
        ? { kind: "seqExpr", stmts: prelude, result, type: STRING, loc }
        : result;
    }
  }
  if (operand.type.kind === "dyn") {
    // Bare typeof on a dyn value: the runtime's kind→string table
    // (null answers "object", boxed closures "function" — JS-exact
    // for every dyn kind; "bigint"/"symbol" have no producers).
    return { kind: "libCall", fn: "dyn.typeof", args: [operand], type: STRING, loc };
  }
  lowerer.unsupported("SC1090", expr, "typeof expressions on statically-typed values");
}

/** `typeof e.code === "string"` / `"undefined"` (and the `!==` forms)
 * where e — through parens and as-casts — is a catch binding or a value
 * of %Error-rooted type: the runtime error's code slot is a string
 * exactly when present, so the typeof test IS the presence test (the
 * isErrnoException predicate's third conjunct,
 * `typeof (err as Record<string, unknown>).code === "string"`). The
 * as-cast changes the expression's TYPE, never the value — peeled like
 * lowerProcessStreamProperty's receiver match. Null for every other
 * shape, so the sibling typeof lowerings keep trying. */
export function lowerErrorCodeTypeofTest(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr | null {
  const negated = expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  for (const [a, b] of operandPairs(expr)) {
    if (!ts.isTypeOfExpression(a)) continue;
    let prop: ts.Expression = a.expression;
    while (ts.isParenthesizedExpression(prop)) prop = prop.expression;
    if (!ts.isPropertyAccessExpression(prop) || prop.questionDotToken) continue;
    if (prop.name.text !== "code") continue;
    let recv: ts.Expression = prop.expression;
    while (
      ts.isParenthesizedExpression(recv) ||
      ts.isAsExpression(recv) ||
      ts.isTypeAssertion(recv)
    )
      recv = recv.expression;
    const errT = errorRootedObjectOf(lowerer, lowerer.typeOf(recv));
    if (!errT) continue;
    if (isExecExceptionType(lowerer, lowerer.typeOf(recv))) refuseExecExceptionCode(lowerer, prop);
    const caught = lowerer.caughtLocalOf(recv);
    let receiver: IrExpr;
    if (caught) {
      // The checker proved the Error narrowing (errT above), so the
      // trusted extraction is sound — caughtRead itself would fence on
      // the intersection spelling.
      receiver = {
        kind: "caughtNarrow",
        value: { kind: "varRef", localId: caught.id, type: CAUGHT, loc },
        type: errT,
        loc,
      };
    } else {
      receiver = lowerer.lowerExpr(recv);
      if (receiver.type.kind !== "object") continue;
    }
    if (!ts.isStringLiteral(b)) continue;
    if (b.text !== "string" && b.text !== "undefined") continue;
    const codeType = lowerer.envValueType();
    if (codeType.kind !== "union")
      throw new InternalCompilerError("lowerer bug: error code type is not a union");
    const undefTag = lowerer.armTag(codeType.unionId, UNDEFINED_T);
    const read: IrExpr = {
      kind: "libCall",
      fn: "error.code",
      args: [receiver],
      type: codeType,
      loc,
    };
    // typeof === "string" ⇔ the code slot is present (NOT the undefined
    // arm); === "undefined" ⇔ absent. `!==` flips either.
    const isNotUndef = b.text === "string" ? !negated : negated;
    return {
      kind: "unionIsTag",
      unionId: codeType.unionId,
      tag: undefTag,
      ...(isNotUndef ? { negated: true as const } : {}),
      value: read,
      type: BOOL,
      loc,
    };
  }
  return null;
}

/** `typeof v === "lit"` / `typeof v !== "lit"` where v is `unknown`-typed
 * (dyn): the runtime kind test over the dyn node's tag. Only the kinds a
 * later read can bridge narrow ("string"/"number"/"boolean") plus
 * "undefined" (no payload to read); "object"/"function" tests keep the
 * fence — an object-narrowed `unknown` read has no lowering anyway (a
 * checked cast `v as T` is the supported extraction). Null when neither
 * side is a typeof over a dyn-typed operand (not this pattern). */
export function lowerDynTypeofTest(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr | null {
  const negated = expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  for (const [a, b] of operandPairs(expr)) {
    if (!ts.isTypeOfExpression(a)) continue;
    if (lowerer.isStdlibGlobal(a.expression, "fetch")) continue;
    // Non-literal comparisons use the ordinary typeof string value,
    // preserving both operands' evaluation order without a narrowing test.
    if (!ts.isStringLiteral(b)) continue;
    const declared = lowerer.mapTypeOf(lowerer.typeOf(a.expression));
    let value: IrExpr;
    if (declared?.kind === "dyn") {
      value = lowerer.lowerExpr(a.expression);
      if (value.type.kind !== "dyn") continue; // defensive: an already-narrowed use
    } else if (lowerer.caughtLocalOf(a.expression)) {
      continue; // the caught lowering's territory (it ran first and declined)
    } else {
      // `typeof (value as T).field === "string"` — the raw-object
      // validation idiom (routes.ts's isValidRoute): the `as` is erasure
      // in JS, so the READ is the dyn KEYED read of the un-cast value —
      // a missing key answers undefined and the guard goes false,
      // Node-exact — never the checked cast (validating T here would
      // throw on exactly the values the guard exists to reject).
      const unparen = (e: ts.Expression): ts.Expression => {
        while (ts.isParenthesizedExpression(e)) e = e.expression;
        return e;
      };
      let keyed: IrExpr | null = null;
      const pn = unparen(a.expression);
      if (ts.isPropertyAccessExpression(pn) && !pn.questionDotToken && ts.isIdentifier(pn.name)) {
        const recv = unparen(pn.expression);
        if (ts.isAsExpression(recv) || ts.isTypeAssertion(recv)) {
          const inner = unparen(recv.expression);
          const obj = tryLowerExpression(lowerer, inner);
          if (obj?.type.kind === "dyn") {
            keyed = {
              kind: "dynKeyGet",
              key: { kind: "strLit", value: pn.name.text, type: STRING, loc },
              value: obj,
              type: DYN,
              loc,
            };
          }
        }
      }
      if (keyed) {
        value = keyed;
      } else {
        // A narrowing residue of `unknown`: a `!== undefined` (or truthy)
        // guard ahead of the typeof test spells the operand `{}`/`{} |
        // null` — no useful static mapping, but the READ is still the dyn
        // value (`if (obj.name !== undefined) { if (typeof obj.name !==
        // "string") ... }`, the validateConfig idiom). Probe the lowering
        // and claim exactly the dyn results; anything else keeps its
        // sibling lowerings and fences untouched.
        const probed = tryLowerExpression(lowerer, a.expression);
        if (probed?.type.kind !== "dyn") continue;
        value = probed;
      }
    }
    if (
      b.text === "string" ||
      b.text === "number" ||
      b.text === "boolean" ||
      b.text === "undefined" ||
      b.text === "bigint" ||
      b.text === "symbol"
    ) {
      return {
        kind: "dynTest",
        test: b.text,
        ...(negated ? { negated: true as const } : {}),
        value,
        type: BOOL,
        loc,
      };
    }
    // `typeof v === "object"`: the dyn answers exactly (object, array,
    // bytes, and null kinds — JS's oldest wart preserved). tsc narrows
    // the branch to `object | null`; reads past the narrow take the
    // checked-cast path per site.
    if (b.text === "object") {
      return {
        kind: "dynTest",
        test: "object",
        ...(negated ? { negated: true as const } : {}),
        value,
        type: BOOL,
        loc,
      };
    }
    // `typeof v === "function"`: a REAL runtime test since the checked-dynamic tree's
    // function kind exists (boxed closures — the mustCall guard
    // `if (typeof fn !== 'function') throw` answers honestly).
    if (b.text === "function") {
      return {
        kind: "dynTest",
        test: "function",
        ...(negated ? { negated: true as const } : {}),
        value,
        type: BOOL,
        loc,
      };
    }
    // Native checked values do not yet carry symbols.
    if (b.text === "symbol") {
      return { kind: "boolLit", value: negated, type: BOOL, loc };
    }
    lowerer.unsupported(
      "SC1090",
      b,
      `'typeof' tests against "${b.text}" on 'unknown' values (only "string"/"number"/` +
        `"boolean"/"undefined"/"object" narrow; use a checked cast — 'v as T' — to extract)`,
    );
  }
  return null;
}

/** The `declare module "..."` body (or nested namespace body) a module
 * export's declaration sits directly in, or undefined. */
function builtinModuleExportParent(decl: ts.Node): ts.ModuleBlock | undefined {
  const parent = ts.isVariableDeclaration(decl) ? decl.parent?.parent?.parent : decl.parent;
  return parent !== undefined && ts.isModuleBlock(parent) ? parent : undefined;
}

/** A function, class or variable exported by a builtin module's body. */
function isBuiltinModuleValueDecl(decl: ts.Node): boolean {
  return (
    builtinModuleExportParent(decl) !== undefined &&
    (ts.isFunctionDeclaration(decl) ||
      ts.isClassDeclaration(decl) ||
      ts.isVariableDeclaration(decl))
  );
}
