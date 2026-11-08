/* The names a program writes on the global object.
 *
 * A built-in global named through the global object (`globalThis.fetch(…)`)
 * is the built-in its bare name names, unless the program replaces that
 * member: then the program means its own value there, and a compiled
 * program has only the built-in to give. This census finds every spelling
 * of such a write, in any source of the program, so that no call or read
 * through the global object answers the built-in for a member the program
 * wrote:
 *
 *   G.name = v, every compound assignment, G["name"] = v, delete G.name,
 *   Object.defineProperty(G, "name", …), Reflect.defineProperty(G, "name", …),
 *   Reflect.set(G, "name", v), Object.defineProperties(G, { name: … }),
 *   Object.assign(G, { name: v })
 *
 * where G is any spelling of the global object: `globalThis`, `global`, a
 * binding or an expression the checker types as the global object.
 *
 * A name that is not written out may be any name where nothing else
 * stops it: the key of a defining call, a spread or a value that is no
 * literal in one. An ASSIGNMENT by a computed key (`G[key] = v`, how a
 * package keeps its own state on the global object) does not count: the
 * runtime refuses such a write when the key names a built-in, where it
 * runs ("setting 'setTimeout' on a dynamic Object is not supported"), so
 * it cannot replace one. A key the checker types as a symbol does not
 * count either, in any spelling (`Reflect.set(G, KEY, v)` with `KEY` a
 * `Symbol.for(…)`): a symbol names no built-in. */
import * as ts from "../ts7/adapter.js";
import { withoutParenthesesTypeWrappers } from "../outer-expressions.js";
import type { Lowerer } from "./lowerer.js";
import { stdlibGlobalNameOf } from "./surfaces.js";

export interface GlobalObjectWrites {
  /** The names written by a literal key. */
  names: Set<string>;
  /** Some write names its member only when the program runs. */
  computed: boolean;
}

const DEFINERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["Object", new Set(["defineProperty", "defineProperties", "assign"])],
  ["Reflect", new Set(["defineProperty", "set", "deleteProperty"])],
]);

/** The census, made on first use. `globalType` is the checker's type of
 * the global object. */
export function globalObjectWrites(lowerer: Lowerer, globalType: ts.Type): GlobalObjectWrites {
  const known = lowerer.globalObjectWrites;
  if (known !== null) return known;
  const writes: GlobalObjectWrites = { names: new Set(), computed: false };
  lowerer.globalObjectWrites = writes;
  const isGlobalObject = (expr: ts.Expression): boolean => {
    const value = withoutParenthesesTypeWrappers(expr);
    return (
      lowerer.typeOf(value) === globalType || stdlibGlobalNameOf(lowerer, value) === "globalThis"
    );
  };
  const isSymbol = (expr: ts.Expression): boolean =>
    (lowerer.typeOf(expr).flags & ts.TypeFlags.ESSymbolLike) !== 0;
  const key = (name: ts.Node | undefined): void => {
    if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)))
      writes.names.add(name.text);
    else if (name === undefined || !ts.isComputedPropertyName(name) || !isSymbol(name.expression))
      writes.computed = true;
  };
  const member = (target: ts.Expression): void => {
    const written = withoutParenthesesTypeWrappers(target);
    if (ts.isPropertyAccessExpression(written) && isGlobalObject(written.expression))
      key(written.name);
    else if (ts.isElementAccessExpression(written) && isGlobalObject(written.expression)) {
      const argument = withoutParenthesesTypeWrappers(written.argumentExpression);
      if (ts.isStringLiteralLike(argument)) key(argument);
    }
  };
  const literalMembers = (value: ts.Expression | undefined): void => {
    const literal = value === undefined ? undefined : withoutParenthesesTypeWrappers(value);
    if (literal === undefined || !ts.isObjectLiteralExpression(literal)) {
      writes.computed = true;
      return;
    }
    for (const property of literal.properties.nodes) {
      if (ts.isSpreadAssignment(property)) writes.computed = true;
      else key(property.name);
    }
  };
  for (const sf of lowerer.program.getImplementationSourceFiles()) {
    // Every spelling of the global object contains "global".
    if (sf.isDeclarationFile || !ts.sourceTextIncludes(sf, "global")) continue;
    ts.walkPreorder(sf, (node) => {
      if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) {
        member(node.left);
      } else if (ts.isDeleteExpression(node)) {
        member(node.expression);
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression)
      ) {
        const methods = DEFINERS.get(node.expression.expression.text);
        const method = node.expression.name.text;
        const target = node.arguments.nodes[0];
        if (methods?.has(method) && target !== undefined && !ts.isSpreadElement(target)) {
          if (isGlobalObject(target)) {
            if (method === "defineProperties") literalMembers(node.arguments.nodes[1]);
            else if (method === "assign")
              for (const source of node.arguments.nodes.slice(1)) literalMembers(source);
            else {
              const name = node.arguments.nodes[1];
              const literal = name === undefined ? undefined : withoutParenthesesTypeWrappers(name);
              if (literal === undefined || ts.isSpreadElement(literal) || !isSymbol(literal))
                key(literal !== undefined && ts.isStringLiteralLike(literal) ? literal : undefined);
            }
          }
        }
      }
      return undefined;
    });
  }
  return writes;
}
