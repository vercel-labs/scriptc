import { dynUndefinedExpr } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { pairsSnapshotHelper } from "../pairs-snapshot.js";
import {
  DYN,
  type IrExpr,
  type IrType,
  STRING,
  type SrcLoc,
  VOID,
  arrayOf,
  typeEquals,
} from "../../../ir/ir.js";

/** An `env` option object → the [k, v, ...] pairs array cp.execSync
 * consumes. The value must be a record (an index-signature ProcessEnv
 * snapshot — `{ ...process.env, X: y }` — or a plain string-map): its
 * string-typed fields and, for index-signature shapes, overflow entries
 * flatten in JS own-key order, undefined-armed values SKIPPED (Node
 * drops undefined env entries). Reuses the interned overflow-keys/read
 * machinery. */
export function recordToEnvPairs(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const v = lowerer.lowerExpr(node);
  if (v.type.kind !== "record") {
    lowerer.noLowering(
      `an env option of '${lowerer.fmt(v.type)}' values`,
      node,
      "pass a string-keyed object (spread process.env or build a Record<string, string>)",
    );
  }
  const helper = lowerer.envToPairsHelper(v.type.shapeId, locOf(node));
  if (helper === null) {
    lowerer.noLowering(
      `an env option of '${lowerer.fmt(v.type)}' values`,
      node,
      "env fields must be strings (or string | undefined)",
    );
  }
  return { kind: "call", callee: helper, args: [v], type: arrayOf(STRING), loc: locOf(node) };
}

/** True iff `node` is THE ambient `process.env` object itself (the
 * receiver of an env read). */
export function isProcessEnv(lowerer: Lowerer, node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) && lowerer.stdlibGlobalMember(node, "process") === "env"
  );
}

/** The interned `string | undefined` union — the type every env read
 * produces (withUndefinedArm interns [string, undefined] in canonical
 * order, so the string arm's tag is 0 and the undefined arm's is 1,
 * program-wide). */
export function envValueType(lowerer: Lowerer): IrType {
  return lowerer.withUndefinedArm(STRING);
}

/** `process.env.NAME` → the process.envGet intrinsic with a literal key
 * (the element form lands in lowerElementAccess). getenv(3) at runtime:
 * present wraps the string arm, absent yields the interned
 * undefined-arm instance. Null for non-env receivers. */
export function lowerProcessEnvGet(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken) return null;
  if (!lowerer.isProcessEnv(expr.expression)) return null;
  const loc = locOf(expr);
  const key: IrExpr = {
    kind: "strLit",
    value: expr.name.text,
    type: STRING,
    loc: locOf(expr.name),
  };
  return { kind: "libCall", fn: "process.envGet", args: [key], type: lowerer.envValueType(), loc };
}

export function lowerProcessLoadEnvFile(lowerer: Lowerer, call: ts.CallExpression): IrExpr {
  if (call.arguments.nodes.length > 1 || call.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering("process.loadEnvFile with spread or extra arguments", call);
  }
  const loc = locOf(call);
  const path: IrExpr = call.arguments.nodes[0]
    ? lowerer.lowerExprExpecting(call.arguments.nodes[0], DYN)
    : dynUndefinedExpr(loc);
  const load: IrExpr = {
    kind: "libCall",
    fn: "process.loadEnvFile",
    args: [path],
    type: VOID,
    loc,
  };
  if (ts.isExpressionStatement(call.parent)) return load;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: load, loc }],
    result: dynUndefinedExpr(loc),
    type: DYN,
    loc,
  };
}

/** The interned `%env.snapshot` helper behind `process.env` as a VALUE: a
 * fresh `{ [k: string]: string | undefined }` record built over environ —
 * envPairs hands the [k0, v0, k1, v1, ...] strings in environ order and
 * the helper keyed-writes each pair into the record's overflow map (JS
 * own-key order follows insertion, exactly Node's Object.keys order over
 * process.env). The target shape must be a pure index-signature record
 * whose value slot is the `string | undefined` union (what ProcessEnv
 * maps to); anything else answers null and the caller keeps its fence. */
export function envSnapshotHelper(lowerer: Lowerer, shapeId: string, loc: SrcLoc): string | null {
  return pairsSnapshotHelper(lowerer, shapeId, loc, {
    keyPrefix: "env",
    libCall: "process.envPairs",
    indexValueOk: (indexValue) => typeEquals(indexValue, lowerer.envValueType()),
  });
}
