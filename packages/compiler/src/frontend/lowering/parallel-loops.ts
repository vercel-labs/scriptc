/* Parallel loops (@scriptc/experimental): parallelInto, parallelReduce and
 * parallelFor (scr_parallel.c, backend/llvm/parallel-loops.ts).
 *
 * Each export is a free function, recognized by its named import from
 * @scriptc/experimental, and lowers at its call site to one intrinsic that
 * splits [0, count) into chunks — the chunks packages/experimental/index.js
 * computes — and calls the callbacks once per chunk:
 *
 *   par.into   (target, stride, grainGiven, grain, parallel, body,
 *               ...reads)                                  -> void
 *   par.reduce (count, grainGiven, grain, initial, parallel, part,
 *               combine)                                    -> f64
 *   par.for    (count, grainGiven, grain, parallel, body)    -> void
 *
 * `parallel` is 1 when the call may run its chunks on several threads and 0
 * when it must run them one after another. The runtime runs the Node.js
 * chunk loop on the calling thread either way — same chunks, same order,
 * same result — so the flag only decides whether helpers may take chunks.
 *
 * The compiler sets `parallel` only when it can show that running the chunks
 * at the same time is not observable:
 * - the callbacks are function expressions with an exact signature;
 * - their bodies read numbers and captured typed arrays, write variables
 *   they declare themselves and the `part` they are given, and call only
 *   Math's pure functions. No allocation, no reference count update, no call
 *   of any other function and no throw: a helper thread has no exception
 *   cell, so a throw there would have nowhere to go;
 * - parallelReduce's result is a number, so partial values cross the runtime
 *   as doubles.
 * Anything else compiles to the sequential loop — exact Node.js behavior —
 * and reports why as an SC6106 performance warning (never a build failure).
 * parallelFor always runs sequentially for now: the compiler cannot yet show
 * that the chunks of its general form write disjoint elements.
 *
 * The options argument must be absent, `undefined`, or an object literal: it
 * is the only part of a call the compiler reads at compile time, and its
 * property values are evaluated in source order, as Node evaluates the
 * literal. */
import { numLit } from "../../ir/build.js";
import { type IrFieldWalker, walkStmtFields } from "../../ir/fields.generated.js";
import { F64, VOID, funcOf } from "../../ir/ir.js";
import type { IrExpr, IrStmt, IrType, SrcLoc } from "../../ir/ir.js";
import { type ExperimentalMember, experimentalImportOf } from "../experimental-import.js";
import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";

type Member = Extract<ExperimentalMember, "parallelInto" | "parallelReduce" | "parallelFor">;

/** SC6106: a parallel call whose chunks run one after another. */
export const SEQUENTIAL_CODE = "SC6106";

/** The Math members a body may call: pure functions of their arguments that
 * allocate nothing and never throw. `Math.random` is not one of them (it
 * reads thread state), and nothing on this list does I/O or reads a clock. */
const PURE_MATH = new Set([
  "abs",
  "acos",
  "acosh",
  "asin",
  "asinh",
  "atan",
  "atan2",
  "atanh",
  "cbrt",
  "ceil",
  "clz32",
  "cos",
  "cosh",
  "exp",
  "expm1",
  "floor",
  "fround",
  "hypot",
  "imul",
  "log",
  "log10",
  "log1p",
  "log2",
  "max",
  "min",
  "pow",
  "round",
  "sign",
  "sin",
  "sinh",
  "sqrt",
  "tan",
  "tanh",
  "trunc",
]);

/** Why a body cannot run on helper threads, with the source node to name. */
interface Refusal {
  reason: string;
  node: ts.Node;
}

/** The text of `node` for a warning: truncated, whitespace collapsed. It is
 * never recorded as a source dependency, and a build that reported a warning
 * is not reused after an edit. */
function textOf(node: ts.Node): string {
  const text = ts.getTextOfNode(node).replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** Whether `node` is `outer` or sits inside it. */
function inside(node: ts.Node | undefined, outer: ts.Node): boolean {
  for (let cur = node; cur !== undefined; cur = cur.parent) if (cur === outer) return true;
  return false;
}

/** `node` without parentheses, non-null assertions, `as` and type
 * assertions: the expression whose value the call reads. */
function unadorned(node: ts.Expression): ts.Expression {
  let cur = node;
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (ts.isNonNullExpression(cur)) cur = cur.expression;
    else if (ts.isAsExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

/** The function expression `node` is, if it is one. */
function callbackLiteral(node: ts.Expression): ts.ArrowFunction | ts.FunctionExpression | null {
  const inner = unadorned(node);
  return ts.isArrowFunction(inner) || ts.isFunctionExpression(inner) ? inner : null;
}

/** One `name: value` entry of an options literal: the option's name and the
 * expression Node evaluates for it (a shorthand's value is the binding it
 * names). Null when the name is computed: it could name an option. */
function optionEntry(
  property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
): { key: string; value: ts.Expression } | null {
  const name = property.name;
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name))
    return {
      key: name.text,
      value: ts.isPropertyAssignment(property) ? property.initializer : name,
    };
  return null;
}

/** Whether `node` is the `undefined` value itself (`undefined`, `void 0`). */
function isUndefinedValue(node: ts.Expression): boolean {
  const inner = unadorned(node);
  return (ts.isIdentifier(inner) && inner.text === "undefined") || ts.isVoidExpression(inner);
}

/** The parameter list of a callback, or null when it is not a plain list of
 * named parameters (no rest, no defaults, no destructuring). */
function parametersOf(
  fn: ts.ArrowFunction | ts.FunctionExpression,
): readonly ts.ParameterDeclaration[] | null {
  for (const param of fn.parameters.nodes) {
    if (
      param.dotDotDotToken !== undefined ||
      param.initializer !== undefined ||
      !ts.isIdentifier(param.name)
    )
      return null;
  }
  return fn.parameters.nodes;
}

/** The root identifier of an element access chain (`a[i]`, `a[i][j]`: `a`). */
function rootIdentifier(node: ts.Expression): ts.Identifier | null {
  let cur = node;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
    else if (ts.isElementAccessExpression(cur)) cur = cur.expression;
    else break;
  }
  return ts.isIdentifier(cur) ? cur : null;
}

/** The body rule's answer for one callback. */
type BodyScan = { refusal: Refusal } | null;

/** The body rule: a whitelist walk of the callback's own source.
 *
 * What it accepts compiles to arithmetic on numbers, element reads of typed
 * arrays and element writes to `part`, so a chunk's compiled code allocates
 * nothing, retains and releases nothing, calls nothing that is not a pure
 * number function and cannot throw. Everything else is refused by node kind
 * or by type, and the refusal names the expression so the warning can point
 * at it. */
function scanBody(
  lowerer: Lowerer,
  fn: ts.ArrowFunction | ts.FunctionExpression,
  written: "part" | "none",
  hasPart: boolean,
): BodyScan {
  const checker = lowerer.program.getTypeChecker();
  const parameters = parametersOf(fn);
  if (parameters === null)
    return {
      refusal: { reason: "a callback with a rest, default or destructured parameter", node: fn },
    };
  let refusal: Refusal | null = null;
  const refuse = (node: ts.Node, reason: string): void => {
    refusal ??= { reason, node };
  };
  const mapped = (node: ts.Node): IrType | null => {
    try {
      return lowerer.mapTypeOf(lowerer.typeOf(node));
    } catch {
      return null;
    }
  };
  /** A number or a boolean: what a body computes with. */
  const numeric = (node: ts.Node): boolean => {
    const type = mapped(node);
    return type !== null && (type.kind === "f64" || type.kind === "bool");
  };
  /** A typed array the body may read. */
  const bytes = (node: ts.Node): boolean => mapped(node)?.kind === "bytes";
  const symbolOf = (node: ts.Node): ts.Symbol | null => checker.getSymbolAtLocation(node) ?? null;
  /** Whether the identifier names something the callback declares itself. */
  const own = (ident: ts.Identifier): boolean => {
    const decl = symbolOf(ident)?.declarations?.[0];
    return (
      decl !== undefined &&
      (inside(decl, fn) || parameters.includes(decl as ts.ParameterDeclaration))
    );
  };
  /** Whether the identifier names the callback's `part` parameter: the
   * typed array it is given, when this call gives one. */
  const part = (ident: ts.Identifier): boolean => {
    if (!hasPart) return false;
    const decl = symbolOf(ident)?.declarations?.[0];
    return decl !== undefined && parameters.length > 0 && decl === parameters[0];
  };

  /** A write target: a local number variable, or (in `part` mode) an
   * element of `part`. */
  const writeTarget = (target: ts.Expression): void => {
    let cur = unadorned(target);
    while (ts.isNonNullExpression(cur)) cur = cur.expression;
    if (ts.isIdentifier(cur)) {
      if (own(cur) && mapped(cur)?.kind === "f64") return;
      const decl = symbolOf(cur)?.declarations?.[0];
      refuse(
        target,
        decl !== undefined && parameters.includes(decl as ts.ParameterDeclaration)
          ? "a write to a parameter of the callback"
          : "a write to a captured value",
      );
      return;
    }
    if (ts.isElementAccessExpression(cur)) {
      const root = rootIdentifier(cur);
      if (root !== null && part(root)) {
        if (written === "none") {
          refuse(target, "a write to `part`, which this callback is not given");
          return;
        }
        if (!numeric(cur.argumentExpression))
          refuse(cur.argumentExpression, "an index into `part` that is not a number");
        return;
      }
      refuse(
        target,
        root !== null && own(root)
          ? "a write to an array the callback creates"
          : "a write to an element of a captured typed array",
      );
      return;
    }
    refuse(target, "a write through a property");
  };

  /** Visits every statement and expression of the callback, and nothing
   * else: a node's type annotation is the checker's business, not the
   * runtime's. */
  const visitAll = (nodes: readonly ts.Node[] | undefined): void => {
    for (const node of nodes ?? []) visit(node);
  };

  const visit = (node: ts.Node): void => {
    if (refusal !== null) return;
    switch (node.kind) {
      // Statements and control flow: their compiled forms are jumps. Each
      // arm visits the children it has; a kind with no arm refuses.
      case ts.SyntaxKind.Block:
        visitAll((node as ts.Block).statements.nodes);
        break;
      case ts.SyntaxKind.VariableStatement:
        visit((node as ts.VariableStatement).declarationList);
        break;
      case ts.SyntaxKind.VariableDeclarationList: {
        const list = node as ts.VariableDeclarationList;
        // `using` and `await using` acquire and dispose through runtime calls
        // the statement's own source does not show.
        if ((list.flags & ts.NodeFlags.Using) !== 0) {
          refuse(list, "a `using` declaration");
          break;
        }
        visitAll(list.declarations.nodes);
        break;
      }
      case ts.SyntaxKind.VariableDeclaration: {
        const declaration = node as ts.VariableDeclaration;
        // A destructured binding names several values through pattern
        // syntax, whose lowering allocates.
        if (declaration.name !== undefined && !ts.isIdentifier(declaration.name)) {
          refuse(declaration, "a destructured binding");
          break;
        }
        if (declaration.initializer !== undefined) visit(declaration.initializer);
        break;
      }
      case ts.SyntaxKind.IfStatement: {
        const statement = node as ts.IfStatement;
        visit(statement.expression);
        visit(statement.thenStatement);
        if (statement.elseStatement !== undefined) visit(statement.elseStatement);
        break;
      }
      case ts.SyntaxKind.ForStatement: {
        const loop = node as ts.ForStatement;
        if (loop.initializer !== undefined) visit(loop.initializer);
        if (loop.condition !== undefined) visit(loop.condition);
        if (loop.incrementor !== undefined) visit(loop.incrementor);
        visit(loop.statement);
        break;
      }
      case ts.SyntaxKind.WhileStatement: {
        const loop = node as ts.WhileStatement;
        visit(loop.expression);
        visit(loop.statement);
        break;
      }
      case ts.SyntaxKind.DoStatement: {
        const loop = node as ts.DoStatement;
        visit(loop.statement);
        visit(loop.expression);
        break;
      }
      case ts.SyntaxKind.ExpressionStatement:
        visit((node as ts.ExpressionStatement).expression);
        break;
      case ts.SyntaxKind.ReturnStatement: {
        const statement = node as ts.ReturnStatement;
        if (statement.expression !== undefined) visit(statement.expression);
        break;
      }
      case ts.SyntaxKind.ParenthesizedExpression:
      case ts.SyntaxKind.AsExpression:
      case ts.SyntaxKind.NonNullExpression:
        visit((node as ts.ParenthesizedExpression).expression);
        break;
      case ts.SyntaxKind.BreakStatement:
      case ts.SyntaxKind.ContinueStatement:
      case ts.SyntaxKind.EmptyStatement:
      case ts.SyntaxKind.NumericLiteral:
      case ts.SyntaxKind.TrueKeyword:
      case ts.SyntaxKind.FalseKeyword:
        break;
      case ts.SyntaxKind.Identifier: {
        const ident = node as ts.Identifier;
        if (ident.text === "NaN" || ident.text === "Infinity") break;
        if (part(ident)) {
          if (!bytes(ident)) refuse(ident, "a `part` that is not a typed array");
          break;
        }
        if (own(ident)) {
          // A local that holds a typed array would be an owned reference
          // whenever the body reassigns it, and a helper thread cannot
          // retain or release: only numbers and booleans, then.
          if (!numeric(ident))
            refuse(ident, `a callback local that is not a number (\`${textOf(ident)}\`)`);
          break;
        }
        if (!numeric(ident) && !bytes(ident))
          refuse(ident, `a captured value of another type (\`${textOf(ident)}\`)`);
        break;
      }
      case ts.SyntaxKind.BinaryExpression: {
        const binary = node as ts.BinaryExpression;
        const operator = binary.operatorToken.kind;
        if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) {
          writeTarget(binary.left);
          visit(binary.left);
          visit(binary.right);
          break;
        }
        // `+` may concatenate strings, which allocates; every other binary
        // operator over numbers and booleans compiles to one instruction.
        if (
          operator === ts.SyntaxKind.PlusToken &&
          (mapped(binary.left)?.kind !== "f64" || mapped(binary.right)?.kind !== "f64")
        ) {
          refuse(binary, "a `+` that may concatenate strings");
          break;
        }
        visit(binary.left);
        visit(binary.right);
        break;
      }
      case ts.SyntaxKind.PrefixUnaryExpression: {
        const unary = node as ts.PrefixUnaryExpression;
        if (
          unary.operator === ts.SyntaxKind.PlusPlusToken ||
          unary.operator === ts.SyntaxKind.MinusMinusToken
        )
          writeTarget(unary.operand);
        visit(unary.operand);
        break;
      }
      case ts.SyntaxKind.PostfixUnaryExpression: {
        const unary = node as ts.PostfixUnaryExpression;
        writeTarget(unary.operand);
        visit(unary.operand);
        break;
      }
      case ts.SyntaxKind.ConditionalExpression: {
        const ternary = node as ts.ConditionalExpression;
        visit(ternary.condition);
        visit(ternary.whenTrue);
        visit(ternary.whenFalse);
        break;
      }
      case ts.SyntaxKind.ElementAccessExpression: {
        const access = node as ts.ElementAccessExpression;
        const root = rootIdentifier(access.expression);
        if (root === null) {
          refuse(node, "an element read through a computed receiver");
          break;
        }
        if (!part(root) && !bytes(root)) {
          refuse(node, `an element read of \`${textOf(root)}\`, which is not a typed array`);
          break;
        }
        if (!numeric(access.argumentExpression))
          refuse(access.argumentExpression, "an index that is not a number");
        visit(access.expression);
        visit(access.argumentExpression);
        break;
      }
      case ts.SyntaxKind.PropertyAccessExpression: {
        const access = node as ts.PropertyAccessExpression;
        const root = rootIdentifier(access.expression);
        if (access.name.text === "length" && root !== null && (part(root) || bytes(root))) {
          visit(access.expression);
          break;
        }
        refuse(node, `a property read (\`${textOf(node)}\`)`);
        break;
      }
      case ts.SyntaxKind.CallExpression: {
        const call = node as ts.CallExpression;
        const callee = call.expression;
        if (
          !ts.isPropertyAccessExpression(callee) ||
          !ts.isIdentifier(callee.expression) ||
          callee.expression.text !== "Math" ||
          !PURE_MATH.has(callee.name.text)
        ) {
          refuse(node, `a call (\`${textOf(callee)}\`)`);
          break;
        }
        for (const arg of call.arguments.nodes) {
          if (ts.isSpreadElement(arg)) {
            refuse(arg, "a spread argument");
            continue;
          }
          if (!numeric(arg)) {
            refuse(arg, "a non-number argument to Math");
            continue;
          }
          visit(arg);
        }
        break;
      }
      default:
        refuse(node, `a construct outside the accepted body (\`${textOf(node)}\`)`);
    }
  };
  visit(fn.body);
  return refusal === null ? null : { refusal };
}

/** One option property, read at the call site. */
interface OptionRead {
  /** Whether the property is present, as 1 or 0 (Node's `?? default`). */
  given: IrExpr;
  /** The value, f64, or the property's default when it is absent. */
  value: IrExpr;
}

function absent(loc: SrcLoc, fallback: number): OptionRead {
  return { given: numLit(0, loc), value: numLit(fallback, loc) };
}

/** The callback type of each call, as the runtime's function pointers spell
 * them: `intrinsic` signatures take the closure as their variable. */
function callbackType(member: Member, part: IrType): IrType {
  switch (member) {
    case "parallelInto":
      return funcOf([part, F64, F64], VOID);
    case "parallelReduce":
      return funcOf([F64, F64], F64);
    default:
      return funcOf([F64, F64], VOID);
  }
}

/** What the warning says to do about a call that stayed sequential. */
function parallelHint(member: Member): string {
  return member === "parallelInto"
    ? "have the body write only its `part` and read captured typed arrays, so its chunks can run on several threads"
    : "have the callback read captured values only, so its chunks can run on several threads";
}

/** Lowers `parallelInto`, `parallelReduce` and `parallelFor`. */
export function lowerParallelCall(lowerer: Lowerer, expr: ts.CallExpression): IrExpr | null {
  const callee = expr.expression;
  if (!ts.isIdentifier(callee)) return null;
  const importMember = experimentalImportOf(lowerer.program, callee);
  if (
    importMember !== "parallelInto" &&
    importMember !== "parallelReduce" &&
    importMember !== "parallelFor"
  )
    return null;
  const member: Member = importMember;
  const loc = locOf(expr);
  if (expr.questionDotToken !== undefined)
    lowerer.noLowering(`an optional call of ${member}`, expr, `call ${member}(...) directly`);
  const args = expr.arguments.nodes;
  const least = member === "parallelReduce" ? 4 : 2;
  if (args.some((argument) => ts.isSpreadElement(argument)))
    lowerer.noLowering(`${member} with a spread argument`, expr);
  if (args.length !== least && args.length !== least + 1)
    lowerer.noLowering(
      `${member} with ${args.length} arguments`,
      expr,
      member === "parallelReduce"
        ? "call parallelReduce(count, initial, part, combine, options?)"
        : `call ${member}(${member === "parallelInto" ? "target, body" : "count, body"}, options?)`,
    );

  const stmts: IrStmt[] = [];
  /** Evaluates `node` and keeps its value in a hidden local, in the order the
   * source evaluates it. */
  const stageValue = (value: IrExpr, name: string): IrExpr => {
    const local = lowerer.declareHiddenLocal(name, value.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: value, loc });
    return { kind: "varRef", localId: local.id, type: value.type, loc };
  };
  const stage = (node: ts.Expression, name: string, expected: IrType): IrExpr =>
    stageValue(lowerer.coerceInto(node, lowerer.lowerExpr(node), expected), name);
  /** Evaluates `value` for its effects (a value the call does not read). */
  const discard = (value: IrExpr): void => {
    if (
      value.kind === "numLit" ||
      value.kind === "boolLit" ||
      value.kind === "strLit" ||
      value.kind === "unitLit"
    )
      return;
    stmts.push({ kind: "exprStmt", expr: value, loc });
  };

  // The first reason the call cannot run its chunks at the same time, if
  // any: `refuse` runs inside the helpers below, so it is read back through
  // a call (a binding assigned only in a closure keeps its initial type).
  let sequential: Refusal | null = null;
  const stayedSequential = (): Refusal | null => sequential;
  const refuse = (reason: Refusal): void => {
    sequential ??= reason;
  };

  let target: IrExpr | null = null;
  let partType: IrType = VOID;
  let count: IrExpr | null = null;
  if (member === "parallelInto") {
    const targetType = lowerer.mapTypeOf(lowerer.typeOf(args[0]!));
    if (targetType === null || targetType.kind !== "bytes")
      lowerer.noLowering(
        `${member} of a value that is not a typed array`,
        args[0]!,
        "pass one of the numeric typed arrays",
      );
    partType = targetType!;
    target = stage(args[0]!, "%parTarget", targetType!);
  } else {
    const countType = lowerer.mapTypeOf(lowerer.typeOf(args[0]!));
    if (countType === null || countType.kind !== "f64")
      lowerer.noLowering(`${member} with a count that is not a number`, args[0]!, "pass a number");
    count = stage(args[0]!, "%parCount", F64);
  }

  /** The lifted function of the `parallelInto` body: what names the typed
   * arrays the body reads (readArrays). */
  let bodyFn: string | null = null;
  let bodyCaptures: string[] | null = null;

  /** Lowers a callback argument, checks its body and answers its value. */
  const callback = (
    node: ts.Expression,
    name: string,
    expected: IrType,
    written: "part" | "none",
    hasPart: boolean,
  ): IrExpr => {
    const literal = callbackLiteral(node);
    const raw = lowerer.lowerExpr(node);
    if (written === "part" && raw.kind === "closure") {
      bodyFn = raw.fnName;
      bodyCaptures = raw.captures;
    }
    const value =
      raw.type.kind === "func" && typesMatch(raw.type, expected)
        ? stageValue(raw, name)
        : stage(node, name, expected);
    if (value.type.kind !== "func" || !typesMatch(value.type, expected))
      lowerer.noLowering(
        `${member} with a callback of the wrong type`,
        node,
        "pass a function with the documented parameters",
      );
    if (literal === null || literal.asteriskToken !== undefined) {
      refuse({ reason: "a callback that is not a plain function expression", node });
      return value;
    }
    const scan = scanBody(lowerer, literal, written, hasPart);
    if (scan !== null) refuse(scan.refusal);
    return value;
  };

  /** Builds one option's reader: a property the call reads. */
  const readOption = (node: ts.Expression | undefined, fallback: number): OptionRead => {
    if (node === undefined) return absent(loc, fallback);
    // `{ grain: undefined }` is the option's default, as `??` reads it.
    if (isUndefinedValue(node)) return absent(loc, fallback);
    const type = lowerer.mapTypeOf(lowerer.typeOf(node));
    if (type === null || type.kind !== "f64") {
      discard(lowerer.lowerExpr(node));
      lowerer.noLowering(
        `a parallel option that is not a number`,
        node,
        "pass a number to grain and stride",
      );
    }
    const value = lowerer.lowerExpr(node);
    const staged = lowerer.coerceInto(node, value, F64);
    const local = lowerer.declareHiddenLocal("%parOption", staged.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: staged, loc });
    return {
      given: numLit(1, loc),
      value: { kind: "varRef", localId: local.id, type: staged.type, loc },
    };
  };

  /** Reads the options argument, evaluating its properties in source order. */
  const readOptions = (
    node: ts.Expression | undefined,
    option: "into" | "both",
  ): {
    grain: OptionRead;
    stride: OptionRead | null;
  } => {
    let grain = absent(loc, 0);
    let stride = option === "into" ? absent(loc, 1) : null;
    if (node === undefined || isUndefinedValue(node)) return { grain, stride };
    const literal = unadorned(node);
    if (!ts.isObjectLiteralExpression(literal))
      lowerer.noLowering(
        `${member} with options that are not an object literal`,
        node,
        "pass an object literal, such as { grain: 4 } or { stride: 4 }",
      );
    for (const property of literal.properties.nodes) {
      if (ts.isSpreadAssignment(property))
        lowerer.noLowering(
          `${member} with a spread in its options`,
          property,
          "spell each option out",
        );
      if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
        const entry = optionEntry(property);
        if (entry !== null) {
          if (entry.key === "grain") grain = readOption(entry.value, 0);
          else if (entry.key === "stride" && stride !== null) stride = readOption(entry.value, 1);
          else discard(lowerer.lowerExpr(entry.value));
          continue;
        }
        // A computed key: it could name an option the call reads.
        lowerer.noLowering(
          `${member} with a computed option name`,
          property,
          "spell each option out",
        );
      }
      lowerer.noLowering(
        `${member} with a method or accessor in its options`,
        property,
        "pass plain values: { grain?: number, stride?: number }",
      );
    }
    return { grain, stride };
  };

  const options: IrExpr[] = [];
  if (member === "parallelReduce") {
    const initialType = lowerer.mapTypeOf(lowerer.typeOf(args[1]!));
    if (initialType === null || initialType.kind !== "f64")
      lowerer.noLowering(
        `${member} with a result that is not a number`,
        args[1]!,
        "pass a number as the initial value: only number results are accepted",
      );
    options.push(stage(args[1]!, "%parInitial", F64));
    options.push(callback(args[2]!, "%parPart", callbackType(member, F64), "none", false));
    options.push(callback(args[3]!, "%parCombine", callbackType(member, F64), "none", false));
  } else if (member === "parallelInto") {
    options.push(callback(args[1]!, "%parBody", callbackType(member, partType), "part", true));
  } else {
    options.push(callback(args[1]!, "%parBody", callbackType(member, F64), "none", false));
  }
  const reads = readOptions(args[least], member === "parallelInto" ? "into" : "both");

  // parallelFor's general form has no disjointness proof yet: its chunks run
  // one after another, which is the Node.js loop.
  if (member === "parallelFor")
    refuse({ reason: "parallelFor's chunks are not yet proven disjoint", node: expr });

  // The typed arrays the body reads. The runtime runs the job one chunk at a
  // time when one of them overlaps the target: a chunk's write could race
  // another chunk's read.
  const readValues =
    member === "parallelInto" ? readArrays(lowerer, bodyFn, bodyCaptures, refuse, loc, expr) : [];

  const blocked = stayedSequential();
  const flag = numLit(blocked === null ? 1 : 0, loc);
  if (blocked !== null) {
    lowerer.parallelWarnings.push({
      code: SEQUENTIAL_CODE,
      loc,
      message: `${member} runs its chunks one after another: ${blocked.reason} (\`${textOf(blocked.node)}\`)`,
      hint: parallelHint(member),
    });
  }

  if (member === "parallelInto") {
    return finish(
      {
        kind: "intrinsic",
        name: "par.into",
        args: [
          target!,
          reads.stride!.value,
          reads.grain.given,
          reads.grain.value,
          flag,
          options[0]!,
          ...readValues,
        ],
        type: VOID,
        loc,
      },
      stmts,
      loc,
    );
  }
  if (member === "parallelReduce") {
    return finish(
      {
        kind: "intrinsic",
        name: "par.reduce",
        args: [
          count!,
          reads.grain.given,
          reads.grain.value,
          options[0]!,
          flag,
          options[1]!,
          options[2]!,
        ],
        type: F64,
        loc,
      },
      stmts,
      loc,
    );
  }
  return finish(
    {
      kind: "intrinsic",
      name: "par.for",
      args: [count!, reads.grain.given, reads.grain.value, flag, options[0]!],
      type: VOID,
      loc,
    },
    stmts,
    loc,
  );
}

/** The intrinsic alone, or the statements that stage its arguments and then
 * the intrinsic. */
function finish(intrinsic: IrExpr, stmts: IrStmt[], loc: SrcLoc): IrExpr {
  if (stmts.length === 0) return intrinsic;
  return { kind: "seqExpr", stmts, result: intrinsic, type: intrinsic.type, loc };
}

/** Whether two function types have the same parameters and result: the one
 * calling convention the runtime's function pointers spell. A variadic
 * function has a hidden trailing parameter, so it never matches. */
function typesMatch(actual: IrType, expected: IrType): boolean {
  if (actual.kind !== "func" || expected.kind !== "func") return false;
  if (actual.rest === true || actual.argumentsAll === true) return false;
  if (actual.params.length !== expected.params.length) return false;
  return (
    actual.params.every((p, i) => sameType(p, expected.params[i]!)) &&
    sameType(actual.ret, expected.ret)
  );
}

function sameType(a: IrType, b: IrType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "bytes" && b.kind === "bytes") return a.elem === b.elem;
  return true;
}

/** The typed arrays the body reads, as values to pass to the runtime: every
 * typed array the lifted body references other than the `part` it is given,
 * which is its own chunk of the target. Those are captured typed arrays and
 * module-level ones; the runtime compares each with the target and runs the
 * job one chunk at a time when one of them overlaps it, since a chunk's
 * write could race another chunk's read. A capture the compiler cannot type
 * cannot be checked, so it refuses the parallel path instead of guessing. */
function readArrays(
  lowerer: Lowerer,
  fnName: string | null,
  captures: readonly string[] | null,
  refuse: (reason: Refusal) => void,
  loc: SrcLoc,
  node: ts.Node,
): IrExpr[] {
  if (captures === null) return [];
  const lifted = [...lowerer.liftedFns].reverse().find((fn) => fn.name === fnName);
  if (lifted === undefined) {
    refuse({ reason: "a body whose captures the compiler cannot name", node });
    return [];
  }
  const typeOf = new Map<string, IrType>();
  for (const capture of lifted.captures ?? []) typeOf.set(capture.localId, capture.type);
  for (const local of lifted.locals) if (!typeOf.has(local.id)) typeOf.set(local.id, local.type);
  const partId = lifted.params[0]?.localId;
  // A reference the body makes to a local it declares itself is not a value
  // the call site can name; the scan refuses those, so the call runs its
  // chunks one after another anyway.
  const own = new Set(lifted.locals.map((local) => local.id));
  for (const capture of lifted.captures ?? []) own.delete(capture.localId);
  const arrays: IrExpr[] = [];
  const seen = new Set<string>();
  const walker: IrFieldWalker = {
    node: (n) => {
      if (n.kind !== "varRef" || n.type.kind !== "bytes" || n.localId === partId) return;
      if (own.has(n.localId)) return;
      if (seen.has(n.localId)) return;
      seen.add(n.localId);
      arrays.push({ kind: "varRef", localId: n.localId, type: n.type, loc });
    },
    string: () => {},
  };
  for (const statement of lifted.body) walkStmtFields(statement, walker, true);
  for (const id of captures) {
    if (seen.has(id)) continue;
    const type = typeOf.get(id);
    if (type === undefined) {
      refuse({ reason: "a captured value the compiler cannot type", node });
      continue;
    }
    if (type.kind === "bytes") {
      seen.add(id);
      arrays.push({ kind: "varRef", localId: id, type, loc });
    }
  }
  return arrays;
}
