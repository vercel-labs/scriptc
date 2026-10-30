import * as ts from "../../ts7/adapter.js";
import { F64, STRING, type IrExpr, type IrType } from "../../../ir/ir.js";
import type { Lowerer } from "../lowerer.js";
import { bindingNeverReassigned } from "../binding-analysis.js";

/** The captures of a regex literal's pattern (the whole match included)
 * and, per capture, whether every successful match sets it. A capture may
 * be unset when an enclosing group has alternatives, when an enclosing
 * group or the capture itself is quantified with a minimum of zero, or
 * when it sits inside a lookaround. Null for the `v` flag (nested
 * classes) and for a pattern the scan does not finish. */
export function regexCaptureParticipation(
  pattern: string,
  flags: string,
): { count: number; always: boolean[] } | null {
  if (flags.includes("v")) return null;
  const always: boolean[] = [true];
  /** Open groups: the group's own capture (-1 when it does not capture),
   * the captures nested in it, whether it has alternatives, and whether it
   * is a lookaround. */
  const frames: { own: number; nested: number[]; alternatives: boolean; lookaround: boolean }[] = [
    { own: -1, nested: [], alternatives: false, lookaround: false },
  ];
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") {
      // The first unescaped `]` ends the class (`[]` is an empty class).
      i++;
      while (i < pattern.length && pattern[i] !== "]") i += pattern[i] === "\\" ? 2 : 1;
      if (i >= pattern.length) return null;
      i++;
      continue;
    }
    if (c === "|") {
      frames[frames.length - 1]!.alternatives = true;
      i++;
      continue;
    }
    if (c === "(") {
      let capture = false;
      let lookaround = false;
      if (pattern[i + 1] !== "?") {
        capture = true;
        i++;
      } else if (pattern[i + 2] === "<" && pattern[i + 3] !== "=" && pattern[i + 3] !== "!") {
        const gt = pattern.indexOf(">", i + 3);
        if (gt < 0) return null;
        capture = true;
        i = gt + 1;
      } else {
        const kind = pattern[i + 2] === "<" ? pattern[i + 3] : pattern[i + 2];
        lookaround = kind === "=" || kind === "!";
        i += 2;
      }
      frames.push({
        own: capture ? always.length : -1,
        nested: [],
        alternatives: false,
        lookaround,
      });
      if (capture) always.push(true);
      continue;
    }
    if (c === ")") {
      if (frames.length === 1) return null;
      const frame = frames.pop()!;
      i++;
      const next = pattern[i];
      const optional =
        next === "?" || next === "*" || (next === "{" && /^\{0+[,}]/.test(pattern.slice(i)));
      const parent = frames[frames.length - 1]!;
      // Alternatives inside the group leave its nested captures unset, but
      // not the group's own capture.
      for (const index of frame.nested) {
        if (optional || frame.lookaround || frame.alternatives) always[index] = false;
        parent.nested.push(index);
      }
      if (frame.own >= 0) {
        if (optional || frame.lookaround) always[frame.own] = false;
        parent.nested.push(frame.own);
      }
      continue;
    }
    i++;
  }
  if (frames.length !== 1) return null;
  if (frames[0]!.alternatives) for (const index of frames[0]!.nested) always[index] = false;
  return { count: always.length, always };
}

/** String members a refined parameter may use: these lower from the
 * receiver's type whatever the checker resolved for an `any` receiver. */
const STRING_MEMBERS: ReadonlySet<string> = new Set([
  "length",
  "toUpperCase",
  "toLowerCase",
  "trim",
  "charCodeAt",
  "codePointAt",
  "slice",
  "substring",
  "repeat",
  "padStart",
  "padEnd",
  "includes",
  "startsWith",
  "endsWith",
  "indexOf",
]);

/** Whether every read of `symbol` in `body` is one that means the same
 * for an `any` value and for a `kind` value, and lowers for both: a
 * template span, the argument of Number or String, the text argument of
 * parseInt or parseFloat for a string and the radix of parseInt for a
 * number (each a parameter of that type, which an `any` value converts
 * to), a listed
 * string member, `+`, strict equality, arithmetic and comparisons of
 * numbers, a returned value, and a string key of an element access on a
 * string-indexed record or an `any` value. Anything else keeps the
 * parameter `any`. */
function readsFit(
  lowerer: Lowerer,
  body: ts.Node,
  symbol: ts.Symbol,
  kind: "string" | "f64",
): boolean {
  const name = ts.symbolName(symbol);
  const primitive = (e: ts.Expression): boolean => {
    const flags = lowerer.checker.getTypeAtLocation(e).flags;
    return (flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.StringLike)) !== 0;
  };
  const fits = (id: ts.Identifier): boolean => {
    let node: ts.Node = id;
    while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
    const parent = node.parent;
    if (ts.isTemplateSpan(parent) || ts.isReturnStatement(parent)) return true;
    if (ts.isElementAccessExpression(parent)) {
      if (kind !== "string" || parent.argumentExpression !== node) return false;
      const receiver = lowerer.mapTypeOf(lowerer.checker.getTypeAtLocation(parent.expression));
      if (receiver?.kind === "dyn") return true;
      const shape = receiver?.kind === "record" ? lowerer.shapes.get(receiver.shapeId) : undefined;
      return shape?.indexValue !== undefined && !shape.tuple;
    }
    if (ts.isArrowFunction(parent)) return parent.body === node;
    if (ts.isCallExpression(parent)) {
      if (parent.expression === node) return false;
      const position = parent.arguments.nodes.indexOf(node as ts.Expression);
      if (
        lowerer.isStdlibGlobal(parent.expression, "Number") ||
        lowerer.isStdlibGlobal(parent.expression, "String")
      )
        return position === 0;
      if (lowerer.isStdlibGlobal(parent.expression, "parseFloat"))
        return position === 0 && kind === "string";
      if (lowerer.isStdlibGlobal(parent.expression, "parseInt"))
        return position === 0 ? kind === "string" : position === 1 && kind === "f64";
      return false;
    }
    if (ts.isPropertyAccessExpression(parent)) {
      const member = parent.name.text;
      if (kind !== "string" || parent.expression !== node || !STRING_MEMBERS.has(member))
        return false;
      return (
        member === "length" ||
        (ts.isCallExpression(parent.parent) && parent.parent.expression === parent)
      );
    }
    if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken
      )
        return true;
      const other = parent.left === node ? parent.right : parent.left;
      if (op === ts.SyntaxKind.PlusToken) return kind === "string" || primitive(other);
      return (
        kind === "f64" &&
        (op === ts.SyntaxKind.MinusToken ||
          op === ts.SyntaxKind.AsteriskToken ||
          op === ts.SyntaxKind.SlashToken ||
          op === ts.SyntaxKind.PercentToken ||
          op === ts.SyntaxKind.LessThanToken ||
          op === ts.SyntaxKind.GreaterThanToken ||
          op === ts.SyntaxKind.LessThanEqualsToken ||
          op === ts.SyntaxKind.GreaterThanEqualsToken) &&
        (lowerer.checker.getTypeAtLocation(other).flags & ts.TypeFlags.NumberLike) !== 0
      );
    }
    return false;
  };
  let ok = true;
  const visit = (n: ts.Node): void => {
    if (!ok) return;
    if (ts.isIdentifier(n) && n.text === name && lowerer.resolveValueSymbol(n) === symbol) {
      if (!fits(n)) ok = false;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return ok;
}

/** The capture layout of a string search: the match, then the offset and
 * the subject. */
export const PLAIN_SEARCH_CAPTURES: { count: number; always: boolean[] } = {
  count: 1,
  always: [true],
};

/** The captures of a regex literal argument (regexCaptureParticipation),
 * or null for any other pattern expression. */
export function regexLiteralCapturesOf(
  pattern: ts.Expression,
): { count: number; always: boolean[] } | null {
  let regex = pattern;
  while (ts.isParenthesizedExpression(regex)) regex = regex.expression;
  if (!ts.isRegularExpressionLiteral(regex)) return null;
  const text = regex.text;
  const slash = text.lastIndexOf("/");
  return regexCaptureParticipation(text.slice(1, slash), text.slice(slash + 1));
}

/** Lowers an inline replace callback. JavaScript passes it the match, the
 * captures, the match offset and the subject (`captures` gives their
 * layout; null lowers the callback as written). TypeScript types the
 * parameters after the match `any`, so an unannotated parameter that is
 * never reassigned, whose every read fits its value (readsFit), and that
 * receives a capture every match sets, the offset or the subject takes
 * that value's type: a string or a number. The closure can then be called
 * directly (typed replacers in lib-dispatch.ts) with fewer boxed values. */
export function lowerReplacerCallback(
  lowerer: Lowerer,
  callback: ts.Expression,
  captures: { count: number; always: boolean[] } | null,
): IrExpr {
  let node = callback;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  // A named function expression can call itself with other arguments.
  const literal =
    ts.isArrowFunction(node) || (ts.isFunctionExpression(node) && !node.name) ? node : null;
  if (!literal || !captures) return lowerer.lowerExpr(callback);
  const bound: { symbol: ts.Symbol; previous: IrType | undefined }[] = [];
  const previousImplicit = lowerer.implicitParamTypes;
  let implicit: Map<ts.Symbol, ts.Type> | null = null;
  const params = literal.parameters.nodes;
  // A declared `this` parameter takes no argument position.
  const first =
    params[0] && ts.isIdentifier(params[0].name) && params[0].name.text === "this" ? 1 : 0;
  params.slice(first).forEach((param, i) => {
    const type =
      i === 0 || i > captures.count + 1
        ? null
        : i < captures.count
          ? captures.always[i] === true
            ? STRING
            : null
          : i === captures.count
            ? F64
            : STRING;
    if (
      type === null ||
      !ts.isIdentifier(param.name) ||
      param.type ||
      param.initializer ||
      param.dotDotDotToken ||
      param.questionToken
    )
      return;
    if ((lowerer.checker.getTypeAtLocation(param.name).flags & ts.TypeFlags.Any) === 0) return;
    const symbol = lowerer.checker.getSymbolAtLocation(param.name);
    if (
      !symbol ||
      !bindingNeverReassigned(lowerer, symbol, param) ||
      !readsFit(lowerer, literal.body, symbol, type === STRING ? "string" : "f64")
    )
      return;
    bound.push({ symbol, previous: lowerer.runtimeOptionalBindingTypes.get(symbol) });
    lowerer.runtimeOptionalBindingTypes.set(symbol, type);
    implicit ??= new Map(previousImplicit ?? []);
    implicit.set(
      symbol,
      type === STRING ? lowerer.checker.getStringType() : lowerer.checker.getNumberType(),
    );
  });
  if (implicit !== null) lowerer.implicitParamTypes = implicit;
  try {
    return lowerer.lowerExpr(callback);
  } finally {
    for (const { symbol, previous } of bound) {
      if (previous === undefined) lowerer.runtimeOptionalBindingTypes.delete(symbol);
      else lowerer.runtimeOptionalBindingTypes.set(symbol, previous);
    }
    lowerer.implicitParamTypes = previousImplicit;
  }
}
