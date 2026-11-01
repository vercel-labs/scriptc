import { dynUndefinedExpr } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer, PoisonError } from "../lowerer.js";
import { locOf } from "../../program.js";
import {
  heldEnvHoldDiag,
  heldEnvIdentityDiag,
  heldEnvReassignedDiag,
  heldEnvWriteDiag,
} from "../../../diagnostics/diagnostic.js";
import { bindingNeverReassigned } from "../binding-analysis.js";
import { constituentTypes } from "../../ts7/checker.js";
import { pairsSnapshotHelper } from "../pairs-snapshot.js";
import {
  BOOL,
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

/** Whether `node` is a value HELD from `process.env` through a chain of
 * bindings: `const env = process.env`, `const alias = env`, or the
 * destructured `const { env } = process`. Node's held value IS the
 * environment object. Here the binding holds a snapshot record of it:
 * MEMBER accesses (`env.X`, `env[k]`, their writes, `delete env.X`) reroute
 * to the live table (see heldEnvValueType), and every BARE use re-snapshots
 * the environment at that use (see lowerIdentifierExpr), so both observe
 * the environment as Node's single object would.
 *
 * The ambient `process.env` itself is NOT a hold (depth === 0): it keeps
 * its own direct lowering (envGet/envSet intrinsics, its existing snapshot
 * when it escapes as a value), which is what Node's reads and writes see. */
export function holdsEnvSnapshot(
  lowerer: Lowerer,
  node: ts.Expression | undefined,
  depth = 0,
): boolean {
  if (node === undefined) return false;
  let inner: ts.Expression = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(inner) ||
      ts.isAsExpression(inner) ||
      ts.isNonNullExpression(inner) ||
      ts.isSatisfiesExpression(inner)
    ) {
      inner = inner.expression;
      continue;
    }
    break;
  }
  // At depth 0 this IS the ambient object, not a value held from it; as a
  // binding's initializer (depth >= 1) it is the hold's source.
  if (isProcessEnv(lowerer, inner)) return depth > 0;
  if (!ts.isIdentifier(inner) || depth >= 4) return false;
  const symbol = lowerer.checker.getSymbolAtLocation(inner);
  const decl = symbol?.valueDeclaration ?? symbol?.declarations[0];
  if (decl === undefined) return false;
  // `const env = process.env` (or an identifier alias of one). The symbol's
  // value declaration is the `const` itself; the written identifier here is
  // a different node than the declared name, so no node identity check.
  // A binding the program reassigns holds the environment only until the
  // reassignment, so it is not a hold (refuseHeldEnvCopyHold refuses it).
  if (ts.isVariableDeclaration(decl)) {
    return (
      holdsEnvSnapshot(lowerer, decl.initializer, depth + 1) &&
      !reassignedBinding(lowerer, symbol!, decl)
    );
  }
  // `const { env } = process` (also `{ env: held }`).
  if (ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent)) {
    const declaration = decl.parent.parent;
    const named = decl.propertyName ?? decl.name;
    if (
      ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(named) &&
      named.text === "env" &&
      declaration.initializer !== undefined
    ) {
      return (
        lowerer.isStdlibGlobal(declaration.initializer, "process") &&
        !reassignedBinding(lowerer, symbol!, declaration)
      );
    }
  }
  return false;
}

/** Whether something writes the binding after its declaration: a `let` or
 * `var` the file assigns (bindingNeverReassigned). A `const` never is. */
function reassignedBinding(
  lowerer: Lowerer,
  symbol: ts.Symbol,
  declaration: ts.VariableDeclaration,
): boolean {
  const list = declaration.parent;
  if (ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0) return false;
  return !bindingNeverReassigned(lowerer, symbol, declaration);
}

/** Whether an expression is the environment object to Node: the ambient
 * `process.env` or a value held from it (holdsEnvSnapshot). */
function denotesEnvironment(lowerer: Lowerer, node: ts.Expression): boolean {
  return isProcessEnv(lowerer, unwrapped(node)) || holdsEnvSnapshot(lowerer, node);
}

function unwrapped(node: ts.Expression): ts.Expression {
  let inner = node;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isSatisfiesExpression(inner)
  )
    inner = inner.expression;
  return inner;
}

/** `a === b`, `a == b` and their negations where an operand is the
 * environment object (denotesEnvironment). Every use of a held value reads
 * a snapshot, so the snapshots would never be identical, while Node
 * compares the one environment object:
 * - two operands that both denote it compare equal, folded (neither
 *   operand has an effect: each is a binding read or `process.env`);
 * - one compared with a primitive, `null` or `undefined` keeps the
 *   ordinary lowering, whose answer (never equal) is Node's;
 * - one compared with another object is refused (heldEnvIdentityDiag).
 * Null when no operand denotes the environment. */
export function lowerEnvironmentIdentity(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
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
  const left = denotesEnvironment(lowerer, expr.left);
  const right = denotesEnvironment(lowerer, expr.right);
  if (!left && !right) return null;
  if (left && right) return { kind: "boolLit", value: !negated, type: BOOL, loc };
  if (isPrimitiveOperand(lowerer.typeOf(left ? expr.right : expr.left))) return null;
  lowerer.pushDiag(heldEnvIdentityDiag(loc));
  throw new PoisonError();
}

/** Whether a checker type has only primitive values (`null` and `undefined`
 * included), which are never the environment object. */
function isPrimitiveOperand(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Union) !== 0)
    return constituentTypes(type).every(isPrimitiveOperand);
  return (
    (type.flags &
      (ts.TypeFlags.Null |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Void |
        ts.TypeFlags.StringLike |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.ESSymbolLike)) !==
    0
  );
}

/** The receiver expression of a write target — the assignment's or delete's
 * access (`env.X`, `env[k]`), through any compound/update wrapping. Null for
 * targets that write no entry of a receiver. */
function writeTargetReceiver(node: ts.Node): ts.Expression | null {
  if (ts.isBinaryExpression(node)) return writeTargetReceiver(node.left);
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    return writeTargetReceiver(node.operand);
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return node.expression;
  }
  return null;
}

/** Whether a MEMBER access (`env.X`, `env[k]`, and their writes) through a
 * value HELD from `process.env` can go to the live environment table: the
 * held binding's type must be exactly the env snapshot record (a pure
 * index-signature shape whose value slot is `string | undefined`, what
 * `process.env` maps to). Returns that value type, or null — a hold whose
 * type differs keeps the snapshot record for reads and refuses writes (see
 * refuseHeldEnvWrite). Member accesses alias the live table the way Node's
 * do. A BARE use of the held value (a spread source, Object.keys, an
 * argument, a return) is not a member access and takes a fresh snapshot of
 * the environment at that use site (lowerIdentifierExpr). */
export function heldEnvValueType(lowerer: Lowerer, receiver: ts.Expression): IrType | null {
  if (!holdsEnvSnapshot(lowerer, receiver)) return null;
  return envRecordValueType(lowerer, lowerer.mapTypeOf(lowerer.typeOf(receiver)));
}

/** The env-record value type a hold must have to alias the live table —
 * a pure index-signature record (no fields, not a tuple) whose value slot
 * is the `string | undefined` union, which is what `process.env` maps to.
 * Null for every other type. */
function envRecordValueType(lowerer: Lowerer, mapped: IrType | null): IrType | null {
  if (mapped?.kind !== "record") return null;
  const shape = lowerer.shapes.get(mapped.shapeId);
  if (!shape || shape.tuple || shape.fields.length > 0 || shape.indexValue === undefined)
    return null;
  const value = lowerer.envValueType();
  return typeEquals(shape.indexValue, value) ? value : null;
}

/** Refuse a BINDING that holds `process.env` under a type which is not the
 * env record — `const env: Record<string, string> = process.env as any`, a
 * fixed-field annotation, `const e: any = process.env`. Node's hold IS the
 * environment object, so member reads through it see the live table;
 * here the hold is a snapshot record taken at the initializer, so reads
 * would silently observe the environment as it was then (writes are
 * already refused — refuseHeldEnvWrite). Refuse the hold where it is
 * created instead of letting its later reads drift. `name` is the bound
 * identifier, `blame` the declaration the diagnostic points at. */
export function refuseHeldEnvCopyHold(lowerer: Lowerer, name: ts.Identifier, blame: ts.Node): void {
  if (
    ts.isVariableDeclaration(blame) &&
    holdsEnvSnapshot(lowerer, blame.initializer, 1) &&
    !holdsEnvSnapshot(lowerer, name)
  ) {
    // Initialized from process.env but reassigned later (holdsEnvSnapshot).
    lowerer.pushDiag(heldEnvReassignedDiag(locOf(blame)));
    throw new PoisonError();
  }
  if (!holdsEnvSnapshot(lowerer, name)) return;
  if (envRecordValueType(lowerer, lowerer.mapTypeOf(lowerer.typeOf(name))) !== null) return;
  lowerer.pushDiag(heldEnvHoldDiag(locOf(blame)));
  throw new PoisonError();
}

/** Refuse a write through a value HELD from `process.env` that cannot take
 * the live path: the compound and update forms (`env.X += v`, `env.X++`)
 * reach this wrapper, and so does any write through a hold whose type is
 * not the env record. The held value is a snapshot record, so such a write
 * would land on the copy while the real environment kept its old value;
 * Node writes setenv(3) through the very same object, so a program relying
 * on it would silently diverge. Plain `=`, computed-key and `delete` writes
 * through the env record alias the live table instead (lower-stmts.ts,
 * element-access.ts); `target` is the write's or delete's access node. */
export function refuseHeldEnvWrite(lowerer: Lowerer, target: ts.Node): void {
  const receiver = writeTargetReceiver(target);
  if (receiver === null || !holdsEnvSnapshot(lowerer, receiver)) return;
  lowerer.pushDiag(heldEnvWriteDiag(locOf(target)));
  throw new PoisonError();
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
