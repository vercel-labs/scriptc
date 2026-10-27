import * as ts from "../ts7/adapter.js";

/** The expression under parentheses and type assertions, which leave no
 * trace in the source text V8 prints. */
function unwrapped(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  )
    e = e.expression;
  return e;
}

/** The source text V8 prints for an iterated identifier or property path,
 * or null for other expressions. */
function iterableHeadText(expr: ts.Expression): string | null {
  const e = unwrapped(expr);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && !e.questionDotToken && ts.isIdentifier(e.name)) {
    const base = iterableHeadText(e.expression);
    return base === null ? null : `${base}.${e.name.text}`;
  }
  return null;
}

/** V8's TypeError message for iterating a value that is not iterable:
 * `x is not iterable` for an identifier or property path, `f is not a
 * function or its return value is not iterable` for a call of one, and ""
 * for other expressions, which the runtime words by the value's kind.
 * for await words it with "async iterable". */
export function notIterableSpelling(expr: ts.Expression, word = "iterable"): string {
  const name = iterableHeadText(expr);
  if (name !== null) return `${name} is not ${word}`;
  const e = unwrapped(expr);
  const callee = ts.isCallExpression(e) ? iterableHeadText(e.expression) : null;
  return callee !== null ? `${callee} is not a function or its return value is not ${word}` : "";
}
