/* The expression under its outer wrappers.
 *
 * Five node kinds wrap an expression without changing the value it evaluates
 * to: parentheses, the two assertion spellings (`x as T` and `<T>x`),
 * `x satisfies T` and the non-null assertion `x!`. A site that asks what an
 * expression is (a literal, a call, a reference to a binding) first decides
 * which of them it looks through, and that decision is part of the site's
 * meaning: an assertion can give the operand another checker type, so a site
 * that goes on to read a type may have to stop at it, while a site that only
 * matches syntax may not care.
 *
 * Every set of wrappers the frontend looks through has one function here,
 * named for what it removes, so a call site states its set and two sites
 * with the same set share a loop:
 *
 *     function                                 ( )  as  <T>  satisfies  !  await
 *     withoutParentheses                        x
 *     withoutParenthesesNonNull                 x                       x
 *     withoutParenthesesAssertions              x   x    x
 *     withoutParenthesesAsSatisfies             x   x          x
 *     withoutParenthesesAssertionsSatisfies     x   x    x     x
 *     withoutParenthesesAssertionsNonNull       x   x    x              x
 *     withoutParenthesesAsSatisfiesNonNull      x   x          x        x
 *     withoutParenthesesTypeWrappers            x   x    x     x        x
 *     withoutParenthesesNonNullAwait            x                       x    x
 *
 * In the names, "Assertions" is both assertion spellings and "As" is `as`
 * alone. New code wants withoutParentheses (syntax only) or
 * withoutParenthesesTypeWrappers (the expression that evaluates). The sets
 * that leave out one type wrapper exist because the sites that use them were
 * written that way; whether those sites should see through the missing
 * wrapper is a question about each site's behaviour, not about this module.
 *
 * Each function is its own loop on purpose. These run inside the lowering's
 * per-node analyses, and one function taking the set as an argument would be
 * a loop over a mask that the native compiler does not specialize.
 *
 * outer-expressions.test.ts keeps the loops here: a function elsewhere whose
 * whole body is such a loop fails it. This module imports only the syntax
 * surface, so the syntax-only frontend modules can use it, and it is not a
 * lowering module, so the frontend outside lowering can call it. */
import * as ts from "./ts7/syntax.js";

/** `node` without parentheses. For a site that matches syntax and must stop
 * at a type wrapper: a rewrite of source text, or a match whose answer
 * depends on the type the wrapper asserts. */
export function withoutParentheses(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** `node` without parentheses and `!`. For a reference matched by its
 * spelling (`a.b!`, `(i)`), where an assertion still ends the match. */
export function withoutParenthesesNonNull(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
}

/** `node` without parentheses and assertions (`x as T`, `<T>x`). For the
 * operand an assertion is written around (`({ ... } as T)`, `(value as R).f`).
 * It stops at `satisfies` and `!`. */
export function withoutParenthesesAssertions(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertion(e))
    e = e.expression;
  return e;
}

/** `node` without parentheses, `as` and `satisfies`. For a constant
 * initializer (`value as const`, `value satisfies T`). It stops at `<T>x`
 * and `!`. */
export function withoutParenthesesAsSatisfies(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e))
    e = e.expression;
  return e;
}

/** `node` without parentheses, assertions and `satisfies`. It stops at `!`. */
export function withoutParenthesesAssertionsSatisfies(node: ts.Expression): ts.Expression {
  let e = node;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isTypeAssertion(e) ||
    ts.isSatisfiesExpression(e)
  )
    e = e.expression;
  return e;
}

/** `node` without parentheses, assertions and `!`. For the spellings a
 * `require(...)` call rides in typed code
 * (`require("node:os") as typeof import("node:os")`), and other values
 * matched under an assertion. It stops at `satisfies`. */
export function withoutParenthesesAssertionsNonNull(node: ts.Expression): ts.Expression {
  let e = node;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isTypeAssertion(e) ||
    ts.isNonNullExpression(e)
  )
    e = e.expression;
  return e;
}

/** `node` without parentheses, `as`, `satisfies` and `!`. It stops at
 * `<T>x`. */
export function withoutParenthesesAsSatisfiesNonNull(node: ts.Expression): ts.Expression {
  let e = node;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  )
    e = e.expression;
  return e;
}

/** `node` without parentheses and every type-only wrapper (`x as T`,
 * `<T>x`, `x satisfies T`, `x!`): the expression that evaluates. For a site
 * that asks what value an expression produces. */
export function withoutParenthesesTypeWrappers(node: ts.Expression): ts.Expression {
  let e = node;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isTypeAssertion(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  )
    e = e.expression;
  return e;
}

/** `node` without parentheses, `!` and `await`. For the declaration
 * projection, which follows a receiver to the call or access that produces
 * it. `await` changes the value, so this is only for a site that asks about
 * the awaited operand. */
export function withoutParenthesesNonNullAwait(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAwaitExpression(e))
    e = e.expression;
  return e;
}
