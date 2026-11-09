import type { IrExpr } from "../../ir/ir.js";
import * as ts from "../ts7/adapter.js";
import { withoutParentheses } from "../outer-expressions.js";
import { definedValue } from "../define-branches.js";
import { isWriteTarget } from "./binding-analysis.js";
import { denotesEnvironment } from "./builtins/environment.js";
import type { Lowerer } from "./lowerer.js";
import { unitReuseEnabled } from "./unit-reuse.js";

/* Conditions that have one value in every run of the program:
 *
 *   const DEV = false;
 *   if (DEV) {
 *     Object.freeze(config);
 *   }
 *
 * The untaken arm of such an `if` is code the program never runs, so it does
 * not lower (lowerStatement), and what lowering it would have switched on
 * for the whole program stays off: the integrity words and write checks of
 * a program that freezes untyped values (frozen-records.ts
 * noteUntypedIntegrity) are the case this exists for. The right operand of
 * `&&` and `||` after a constant left operand that decides the result is
 * the same case (`DEV && check(x)`, expressions/binary.ts), and so is the
 * unselected arm of a conditional expression (`DEV ? check(x) : x`,
 * expressions/narrowing.ts lowerTernary).
 *
 * What is left is never more than the code without the fold. A condition
 * that runs nothing (conditionRunsNothing) is left out, so the `if` is its
 * taken arm and the conditional expression is its selected operand, the
 * same IR as that code written alone. A condition that can throw, a
 * `const` read before its declaration, still runs: the `if` evaluates it
 * and then runs the taken arm, and the conditional expression keeps both
 * operands.
 *
 * A `--define`d variable holds its value in every run because the
 * executable sets it when it starts and a change that names it is a build
 * error (refuseDefinedEnvWrite). A change through a name the build cannot
 * read (`process.env[name] = v`) could be a change of that variable, so in
 * a program that makes one the comparisons `--define` decides are not
 * constant here (changesEnvironmentByComputedName) and follow the variable
 * as under Node. The same holds where the build cannot read every writer
 * at all (definedConditionsFollowTheRun): in a program that runs code in
 * Node.js, whose JavaScript shares the process's environment and is not
 * lowered, and in a build that reuses lowered units, whose stored units
 * are not lowered again when another declaration gains such a write.
 *
 * A condition is constant when it is `true` or `false`, a `const` binding
 * whose initializer is a constant condition (through imports and
 * re-exports), a comparison `--define` decides (define-branches.ts, the
 * rule the JavaScript `if` statements resolve by), or `!`, `&&` and `||`
 * over those, where the left operand of `&&` and `||` decides the result or
 * both operands are constant. */

/** The value of a constant condition, or null when it needs evaluation. */
export function constantCondition(lowerer: Lowerer, expr: ts.Expression): boolean | null {
  return constantValue(lowerer, expr, new Set());
}

function constantValue(lowerer: Lowerer, expr: ts.Expression, seen: Set<ts.Node>): boolean | null {
  const e = withoutParentheses(expr);
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = constantValue(lowerer, e.operand, seen);
    return operand === null ? null : !operand;
  }
  if (ts.isIdentifier(e)) {
    const initializer = constInitializer(lowerer, e);
    if (initializer === null || seen.has(initializer)) return null;
    seen.add(initializer);
    return constantValue(lowerer, initializer, seen);
  }
  if (!ts.isBinaryExpression(e)) return null;
  const op = e.operatorToken.kind;
  if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
    const isAnd = op === ts.SyntaxKind.AmpersandAmpersandToken;
    const left = constantValue(lowerer, e.left, seen);
    if (left === null) return null;
    if (left !== isAnd) return left;
    return constantValue(lowerer, e.right, seen);
  }
  return definedCondition(lowerer, e);
}

/** The initializer of the `const` declaration `ident` reads, or null: a
 * `let`, a `var`, a parameter, a destructured name and an ambient
 * declaration can hold other values. */
function constInitializer(lowerer: Lowerer, ident: ts.Identifier): ts.Expression | null {
  const declaration = lowerer.resolveValueSymbol(ident)?.valueDeclaration;
  if (
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    declaration.initializer === undefined
  )
    return null;
  const list = declaration.parent;
  const blockScoped = ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using;
  if (
    list === undefined ||
    !ts.isVariableDeclarationList(list) ||
    (list.flags & blockScoped) !== ts.NodeFlags.Const ||
    (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) !== 0
  )
    return null;
  return declaration.initializer;
}

/** The value of a condition `--define` decides, when each `process` it
 * names is Node's global, the build reads every writer of the environment
 * and the program changes no variable through a name the build cannot
 * read. Such a condition reads the environment and nothing else. */
function definedCondition(lowerer: Lowerer, e: ts.Expression): boolean | null {
  if (lowerer.define === undefined) return null;
  const value = definedValue(e, lowerer.define);
  if (typeof value !== "boolean" || definedConditionsFollowTheRun(lowerer)) return null;
  let global = true;
  const visit = (n: ts.Node): void => {
    if (!global) return;
    if (ts.isIdentifier(n)) {
      if (n.text === "process" && !lowerer.isStdlibGlobal(n, "process")) global = false;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(e);
  return global && !changesEnvironmentByComputedName(lowerer) ? value : null;
}

/** Whether this build cannot read every writer of the environment, so that
 * no comparison `--define` decides is constant in it:
 *
 * - The program runs code in Node.js (Lowerer.mayRunInNode). A Node island
 *   is the same process with the same environment, and its JavaScript is
 *   not lowered: neither the build error for a change that names a defined
 *   variable nor the walk for computed names reads it.
 *
 *     import { configure } from "island-package"; // sets process.env.NODE_ENV
 *     configure();
 *     if (process.env.NODE_ENV !== "production") check();
 *
 * - The build reuses lowered units (unit-reuse.ts). A stored unit that
 *   holds a folded condition spells only the names of its own text, so it
 *   would apply unchanged after another declaration gains
 *   `process.env[name] = v`. */
function definedConditionsFollowTheRun(lowerer: Lowerer): boolean {
  return unitReuseEnabled() || lowerer.mayRunInNode();
}

/** Whether the program writes or deletes an environment variable through a
 * name that is not a literal, found on first use:
 *
 *   process.env[name] = value;
 *   delete env[key]; // const env = process.env
 *
 * The variable could be one `--define` fixes, which no build error can say
 * (refuseDefinedEnvWrite reads literal names). Every form that targets the
 * member counts, whether or not its write reaches the environment today:
 * the compound assignments, `++`, a destructuring pattern, a `for` loop's
 * variable. */
function changesEnvironmentByComputedName(lowerer: Lowerer): boolean {
  if (lowerer.computedEnvironmentWrite !== null) return lowerer.computedEnvironmentWrite;
  let found = false;
  for (const sf of lowerer.program.getImplementationSourceFiles()) {
    if (found) break;
    if (sf.isDeclarationFile) continue;
    ts.walkPreorder(sf, (node) => {
      if (found) return "skip";
      if (
        ts.isElementAccessExpression(node) &&
        !ts.isStringLiteralLike(withoutParentheses(node.argumentExpression)) &&
        isWritten(node) &&
        denotesEnvironment(lowerer, node.expression)
      )
        found = true;
      return undefined;
    });
  }
  lowerer.computedEnvironmentWrite = found;
  return found;
}

/** Whether an access is assigned, updated or deleted (isWriteTarget), also
 * under the wrappers that name the same member, as an element of a
 * destructuring pattern, and as the variable of a `for` loop. */
function isWritten(access: ts.Expression): boolean {
  let node: ts.Node = access;
  for (;;) {
    const parent = node.parent;
    if (parent === undefined) return false;
    if (ts.isForOfStatement(parent) || ts.isForInStatement(parent))
      return parent.initializer === node;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isSpreadAssignment(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === node)
    ) {
      node = parent;
      continue;
    }
    return isWriteTarget(node as ts.Expression);
  }
}

/** Whether a constant condition, lowered to `cond`, runs nothing, so that
 * the code it selects may stand without it: a literal, a read of a binding
 * that needs no check, `!` of one, or a condition that only reads the
 * environment (definedCondition). A binding that can be read before its
 * declaration has run is checked at the read, which throws as under Node,
 * so such a condition has to run:
 * - a module binding with an initialization flag gets the check after its
 *   function is lowered, on the reference that is still there
 *   (cycle-initialization.ts), so every read of a flagged binding counts;
 * - a local that a closure declared above it reads is a `tdz` local, whose
 *   references the backend checks.
 * A module binding's own `tdz` guard needs pointer storage, which a
 * reference of type bool does not have. */
export function conditionRunsNothing(lowerer: Lowerer, expr: ts.Expression, cond: IrExpr): boolean {
  let read = cond;
  while (read.kind === "unary" && read.op === "!") read = read.operand;
  if (read.kind === "boolLit") return true;
  if (read.kind === "varRef") {
    const id = read.localId;
    if (read.type.kind !== "bool" || lowerer.cycleInitFlags.has(id)) return false;
    return lowerer.ctx.locals.find((local) => local.id === id)?.tdz !== true;
  }
  return definedCondition(lowerer, expr) !== null;
}
