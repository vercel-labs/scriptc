import * as ts from "../ts7/adapter.js";
import { bodyReadsArguments } from "../arguments-usage.js";
import { isJsSourceFile, locOf } from "../program.js";
import { BOOL, F64, type IrExpr, type IrStmt, type IrType } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { typeKey } from "../type-mapper.js";
import type { Lowerer } from "./lowerer.js";
import { isThisParameter } from "./call-signatures.js";
import { buildFunctionAdapter } from "./coercions/builders.js";
import { keyedHelperName } from "./stable-names.js";

/** `arguments.length` in a top-level function declaration that the program
 * also uses as a value. A direct call passes the declared parameters (tsc
 * checks the arity), while a call through the value passes the parameter
 * count of the function type the value was passed as (`[1].map(f)` calls f
 * with 3). The value is an adapter that stores that count in a global slot
 * before forwarding; the function reads the slot on entry and clears it,
 * so a direct call (the cleared slot) sees the declared count. */

/** The count slot of `decl`, or null when its `arguments.length` folds to
 * the declared count (or the declaration does not qualify). */
export function argumentCountSlot(lowerer: Lowerer, decl: ts.FunctionDeclaration): string | null {
  const cached = lowerer.argumentCountSlots.get(decl);
  if (cached !== undefined) return cached;
  let slot: string | null = null;
  if (
    decl.body !== undefined &&
    decl.name !== undefined &&
    decl.asteriskToken === undefined &&
    !decl.typeParameters?.nodes.length &&
    lowerer.isTopLevelFnSymbol(decl.name) &&
    decl.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) !== true &&
    !isJsSourceFile(ts.getSourceFileOfNode(decl)) &&
    fixedArity(decl) &&
    bodyReadsArguments(decl) &&
    usedAsValue(lowerer, decl)
  ) {
    const sig = lowerer.fnSigOf(decl.name);
    if (sig) {
      slot = `%g.argc.${sig.name}`;
      lowerer.globalsList.push({ id: slot, name: "%argc", type: F64, mutable: true });
    }
  }
  lowerer.argumentCountSlots.set(decl, slot);
  return slot;
}

/** Reads `decl`'s count slot into a hidden local on entry and clears it; the
 * local holds the declared count when the slot was clear. */
export function declareArgumentCount(
  lowerer: Lowerer,
  decl: ts.FunctionDeclaration,
  prologue: IrStmt[],
): void {
  const slot = argumentCountSlot(lowerer, decl);
  if (slot === null) return;
  const loc = locOf(decl);
  const local = lowerer.declareHiddenLocal("%argc", F64);
  const stored = varRef(slot, F64, loc);
  prologue.push(
    {
      kind: "varDecl",
      localId: local.id,
      init: {
        kind: "ternary",
        cond: {
          kind: "bin",
          op: "===",
          left: stored,
          right: { kind: "numLit", value: 0, type: F64, loc },
          type: BOOL,
          loc,
        },
        then: { kind: "numLit", value: declaredCount(decl), type: F64, loc },
        else_: stored,
        type: F64,
        loc,
      },
      loc,
    },
    { kind: "assign", localId: slot, value: { kind: "numLit", value: 0, type: F64, loc }, loc },
  );
  lowerer.ctx.argumentCount = local;
}

/** `decl` as a value at `reference`: the plain closure when every call
 * through the expected function type passes the declared count, otherwise
 * an adapter that stores the expected type's count in the slot first. */
export function argumentCountValue(
  lowerer: Lowerer,
  decl: ts.FunctionDeclaration,
  reference: ts.Expression,
  closure: IrExpr & { type: IrType & { kind: "func" } },
): IrExpr {
  const slot = argumentCountSlot(lowerer, decl);
  if (slot === null) return closure;
  const count = contextualCallCount(lowerer, reference);
  if (count === null || count === "varies") {
    lowerer.unsupported(
      "SC1090",
      reference,
      count === null
        ? "functions that read 'arguments.length' used as values where no function type is expected (the count each call passes is not known)"
        : "functions that read 'arguments.length' used as values where the expected function type has optional or rest parameters (the count varies per call)",
    );
  }
  const declared = declaredCount(decl);
  if (count <= declared) return closure;
  const loc = locOf(reference);
  const type = closure.type;
  const key = `argc:${slot}:${count}:${typeKey(type)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (name === undefined) {
    name = keyedHelperName(lowerer, "%argc.adapter", key);
    lowerer.arrHofHelpers.set(key, name);
    const params = type.params.map((t, i) => ({ localId: `p${i}.0`, name: `p${i}`, type: t }));
    lowerer.liftedFns.push(
      ...buildFunctionAdapter(
        name,
        type,
        type,
        params,
        [],
        [
          {
            kind: "assign",
            localId: slot,
            value: { kind: "numLit", value: count, type: F64, loc },
            loc,
          },
          {
            kind: "return",
            value: {
              kind: "callValue",
              callee: varRef("f.0", type, loc),
              args: params.map((p) => varRef(p.localId, p.type, loc)),
              type: type.ret,
              loc,
            },
            loc,
          },
        ],
        loc,
      ),
    );
  }
  return { kind: "call", callee: name, args: [closure], type, loc };
}

/** The argument count every call through the function type `node` is
 * expected as passes: that type's parameter count when it has one call
 * signature with a fixed parameter list (a `this` parameter is type-only),
 * "varies" when it has optional or rest parameters, null when there is no
 * such type. */
export function contextualCallCount(
  lowerer: Lowerer,
  node: ts.Expression,
): number | "varies" | null {
  const contextual = lowerer.checker.getContextualType(node);
  if (contextual === undefined) return null;
  const signatures = lowerer.checker.getCallSignatures(
    lowerer.checker.getNonNullableType(contextual),
  );
  if (signatures.length !== 1) return null;
  const declaration = signatures[0]!.declaration;
  if (declaration === undefined) return null;
  let count = 0;
  for (const parameter of (declaration.parameters?.nodes ?? []) as ts.ParameterDeclaration[]) {
    if (isThisParameter(parameter)) continue;
    if (parameter.questionToken || parameter.initializer || parameter.dotDotDotToken)
      return "varies";
    count++;
  }
  return count;
}

/** Whether a program reference to the function declaration or method `fn`
 * reads it as a value (`xs.map(f)`, `const g = f`, `xs.map(C.parse)`) rather
 * than calling it. Export specifiers and default exports only name a
 * function; the importing files' references resolve to it and are checked
 * the same way. */
export function usedAsValue(
  lowerer: Lowerer,
  fn: ts.FunctionDeclaration | ts.MethodDeclaration,
): boolean {
  const name = fn.name;
  if (!name || !(ts.isIdentifier(name) || ts.isPrivateIdentifier(name))) return false;
  const method = ts.isMethodDeclaration(fn);
  const symbolAt = (n: ts.Node): ts.Symbol | null | undefined =>
    method
      ? lowerer.checker.getSymbolAtLocation(n)
      : lowerer.resolveValueSymbol(n as ts.Identifier);
  const symbol = symbolAt(name);
  if (!symbol) return false;
  let found = false;
  for (const sf of lowerer.program.getImplementationSourceFiles()) {
    ts.walkPreorder(sf, (n) => {
      if (found) return "stop";
      if (ts.isTypeNode(n)) return "skip";
      if (n === name || !(ts.isIdentifier(n) || ts.isPrivateIdentifier(n))) return undefined;
      if (n.text !== name.text || !n.parent) return undefined;
      const parent = n.parent;
      // A method is read through its member name (`C.parse`, `this.#m`).
      const read = ts.isPropertyAccessExpression(parent) && parent.name === n ? parent : n;
      if (method && read === n && !ts.isBindingElement(parent)) return undefined;
      const use = read.parent;
      if (use && ts.isCallExpression(use) && use.expression === read) return undefined;
      if (ts.isExportSpecifier(parent) || ts.isExportAssignment(parent)) return undefined;
      if (ts.isImportSpecifier(parent) || ts.isImportClause(parent)) return undefined;
      if (symbolAt(n) === symbol) found = true;
      return undefined;
    });
    if (found) break;
  }
  return found;
}

function fixedArity(fn: ts.FunctionLikeDeclaration): boolean {
  return fn.parameters.nodes.every(
    (p) =>
      p.questionToken === undefined &&
      p.initializer === undefined &&
      p.dotDotDotToken === undefined,
  );
}

function declaredCount(fn: ts.FunctionLikeDeclaration): number {
  return fn.parameters.nodes.filter((p) => !isThisParameter(p)).length;
}
