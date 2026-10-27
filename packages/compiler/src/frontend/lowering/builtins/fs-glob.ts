import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  VOID,
  arrayOf,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../../ir/ir.js";
import { dynUndefinedExpr, numLit } from "../../../ir/build.js";
import { InternalCompilerError } from "../../../errors.js";
import { locOf } from "../../program.js";
import { checkForAwaitBinding } from "../lower-async-iteration.js";
import { builtinImportOf } from "./module-bindings.js";

/* fs.globSync, fs.glob and fs/promises glob (scr_glob.c, a port of Node's
 * lib/internal/fs/glob.js). The pattern and options cross as dyn values so
 * the runtime validates them in Node's order. The result form (strings or
 * Dirent rows) comes from the call's mapped result type, so withFileTypes
 * must be statically known; the runtime checks that the option agrees.
 * Because of that check, the form follows the checker's resolved overload
 * even where an untyped options argument leaves the overload undecided
 * (dynamicOverloadChoice). */

/** The interned Dirent record array (type-mapper.ts), or null. */
function direntArray(lowerer: Lowerer, type: IrType | null | undefined): boolean {
  if (type?.kind !== "array" || type.elem.kind !== "record") return false;
  const shape = lowerer.shapes.get(type.elem.shapeId);
  return (
    !!shape &&
    !shape.tuple &&
    !shape.indexValue &&
    shape.fields.length === 3 &&
    shape.fields.some((f) => f.name === "%dtype")
  );
}

/** An exclude function receives Node's Dirent objects when withFileTypes is
 * set, which have no native representation here. */
function fenceDirentExclude(lowerer: Lowerer, call: ts.CallExpression, what: string): void {
  const options = call.arguments.nodes[1];
  if (!options) return;
  const exclude = lowerer.checker.getPropertyOfType(lowerer.typeOf(options), "exclude");
  if (!exclude) return;
  const type = lowerer.checker.getTypeOfSymbolAtLocation(exclude, options);
  if (lowerer.checker.getCallSignatures(type).length === 0) return;
  lowerer.noLowering(
    `${what} with an exclude function and withFileTypes`,
    options,
    "pass exclude as a string[] of glob patterns, or match on names without withFileTypes",
  );
}

function globArgs(lowerer: Lowerer, call: ts.CallExpression, what: string): IrExpr[] {
  if (call.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(`${what} with spread arguments`, call, "write the arguments positionally");
  }
  return call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN));
}

/** `globSync(pattern, options?)`: string[] or Dirent[]. */
export function lowerFsGlobSyncCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  const args = globArgs(lowerer, call, "fs.globSync");
  const callType = lowerer.mapTypeOf(lowerer.checker.getTypeAtLocation(call));
  const types = direntArray(lowerer, callType);
  if (types) fenceDirentExclude(lowerer, call, "fs.globSync");
  if (!types && !(callType?.kind === "array" && callType.elem.kind === "string")) {
    lowerer.noLowering(
      "fs.globSync where the result is not string[] or Dirent[]",
      call,
      "pass withFileTypes as a literal true or false so the result type is known",
    );
  }
  return {
    kind: "libCall",
    fn: types ? "fs.globTypesSync" : "fs.globSync",
    args: [args[0] ?? dynUndefinedExpr(loc), args[1] ?? dynUndefinedExpr(loc)],
    type: types ? callType! : arrayOf(STRING),
    loc,
  };
}

/** `fs.glob(pattern[, options], callback)`: the argument vector goes to the
 * runtime, which validates it and calls back with string[]. */
export function lowerFsGlobCallbackCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  const args = globArgs(lowerer, call, "fs.glob");
  return {
    kind: "libCall",
    fn: "fs.callbackGlob",
    args: [{ kind: "dynArrLit", elems: args, type: DYN, loc }],
    type: VOID,
    loc,
  };
}

/** True when `node` calls fs/promises glob (any import spelling). */
export function isFspGlobCall(lowerer: Lowerer, node: ts.Expression): node is ts.CallExpression {
  let expr = node;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (!ts.isCallExpression(expr) || expr.questionDotToken) return false;
  const callee = expr.expression;
  const bi = ts.isIdentifier(callee)
    ? builtinImportOf(lowerer, callee)
    : ts.isPropertyAccessExpression(callee) && !callee.questionDotToken
      ? lowerer.builtinMemberOf(callee)
      : null;
  return bi?.module === "fs/promises" && bi.member === "glob";
}

/** fs/promises `glob(pattern, options?)` as the head of a `for await` loop
 * (lowerForOf marks the call): the matches as an array the loop awaits in
 * order. The walk runs when the loop starts, like the other fs/promises
 * operations, which complete before their continuations. Other uses of
 * the async iterator have no lowering. */
export function lowerFspGlobCall(lowerer: Lowerer, call: ts.CallExpression, loc: SrcLoc): IrExpr {
  if (lowerer.fspGlobHead !== call) {
    lowerer.noLowering(
      "fs/promises glob outside a for await loop",
      call,
      "iterate the matches directly with for await (const path of glob(pattern)), or use fs.globSync",
    );
  }
  const args = globArgs(lowerer, call, "fs/promises glob");
  // The async iterator's yielded type (its first type argument).
  const yielded = lowerer.checker.getTypeArguments(
    lowerer.checker.getTypeAtLocation(call) as ts.TypeReference,
  )[0];
  const element = yielded ? lowerer.mapTypeOf(yielded) : null;
  const rows: IrType | null = element ? { kind: "array", elem: element } : null;
  const types = direntArray(lowerer, rows);
  if (types) fenceDirentExclude(lowerer, call, "fs/promises glob");
  if (!types && element?.kind !== "string") {
    lowerer.noLowering(
      "fs/promises glob where the yielded value is not a string or a Dirent",
      call,
      "pass withFileTypes as a literal true or false so the yielded type is known",
    );
  }
  return {
    kind: "libCall",
    fn: types ? "fsp.globTypes" : "fsp.globStrings",
    args: [args[0] ?? dynUndefinedExpr(loc), args[1] ?? dynUndefinedExpr(loc)],
    type: types ? rows! : arrayOf(STRING),
    loc,
  };
}

/** `for await (const path of glob(pattern, options))`: the walk runs when
 * the loop starts and its matches bind in order, one microtask hop per
 * step. When the walk ended with an error (an exclude callback threw), the
 * matches found before it bind first and the error is thrown when the loop
 * reaches the end, as Node's async iterator yields them before rejecting;
 * leaving the loop early with break or return skips it. */
export function lowerFspGlobForAwait(
  lowerer: Lowerer,
  stmt: ts.ForOfStatement,
  call: ts.CallExpression,
): IrStmt {
  const binding = checkForAwaitBinding(lowerer, stmt);
  const loc = locOf(stmt);
  lowerer.fspGlobHead = call;
  let rowsExpr: IrExpr;
  try {
    rowsExpr = lowerer.lowerExpr(call);
  } finally {
    lowerer.fspGlobHead = null;
  }
  if (rowsExpr.type.kind !== "array") {
    throw new InternalCompilerError("fs/promises glob head did not lower to an array");
  }
  const rowsT = rowsExpr.type;
  const elemT = rowsT.elem;
  lowerer.scopes.push(new Map());
  try {
    const rows = lowerer.declareHiddenLocal("%globRows", rowsT);
    const error = lowerer.declareHiddenLocal("%globError", DYN);
    const index = lowerer.declareHiddenLocal("%globIndex", F64);
    index.mutable = true;
    const item = lowerer.declareLocal(
      binding.declaration.name,
      binding.declaration.name.text,
      elemT,
      binding.mutable,
    );
    const rowsRef = (): IrExpr => ({ kind: "varRef", localId: rows.id, type: rowsT, loc });
    const indexRef = (): IrExpr => ({ kind: "varRef", localId: index.id, type: F64, loc });
    const errorRef = (): IrExpr => ({ kind: "varRef", localId: error.id, type: DYN, loc });
    const body = lowerer.inCtl("loop", () => lowerer.lowerScopedBlock(stmt.statement));
    const loop: IrStmt = {
      kind: "while",
      cond: { kind: "boolLit", value: true, type: BOOL, loc },
      body: [
        {
          kind: "exprStmt",
          expr: { kind: "libCall", fn: "async.hop", args: [], type: VOID, loc },
          loc,
        },
        {
          kind: "if",
          cond: {
            kind: "unary",
            op: "!",
            operand: { kind: "arrayHas", arr: rowsRef(), index: indexRef(), type: BOOL, loc },
            type: BOOL,
            loc,
          },
          then: [
            {
              kind: "if",
              cond: {
                kind: "unary",
                op: "!",
                operand: { kind: "dynTest", test: "undefined", value: errorRef(), type: BOOL, loc },
                type: BOOL,
                loc,
              },
              then: [{ kind: "throw", value: errorRef(), loc }],
              else_: null,
              loc,
            },
            { kind: "break", loc },
          ],
          else_: null,
          loc,
        },
        {
          kind: "varDecl",
          localId: item.id,
          init: { kind: "arrayGet", arr: rowsRef(), index: indexRef(), type: elemT, loc },
          loc,
        },
        {
          kind: "assign",
          localId: index.id,
          value: { kind: "bin", op: "+", left: indexRef(), right: numLit(1, loc), type: F64, loc },
          loc,
        },
        ...body,
      ],
      loc,
    };
    return {
      kind: "block",
      body: [
        { kind: "varDecl", localId: rows.id, init: rowsExpr, loc },
        {
          kind: "varDecl",
          localId: error.id,
          init: { kind: "libCall", fn: "fsp.globError", args: [], type: DYN, loc },
          loc,
        },
        { kind: "varDecl", localId: index.id, init: numLit(0, loc), loc },
        loop,
      ],
      loc,
    };
  } finally {
    lowerer.scopes.pop();
  }
}
