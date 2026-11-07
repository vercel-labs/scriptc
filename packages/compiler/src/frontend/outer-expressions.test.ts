/* Pins what each function of outer-expressions.ts looks through, and keeps
 * the loops in that module: a function elsewhere whose whole body peels
 * wrappers off an expression fails here. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import * as outer from "./outer-expressions.js";
import { getTextOfNode } from "./ts7/node-functions.js";
import { closeSourceParser, parseSourceFile } from "./ts7/source-parser-node.js";
import * as ts from "./ts7/syntax.js";

afterAll(closeSourceParser);

type Wrapper = "as" | "angle" | "satisfies" | "nonNull" | "await";

/** The wrapper written around an operand that is already parenthesized. */
const WRAP: Record<Wrapper, (operand: string) => string> = {
  as: (operand) => `${operand} as any`,
  angle: (operand) => `<any>${operand}`,
  satisfies: (operand) => `${operand} satisfies unknown`,
  nonNull: (operand) => `${operand}!`,
  await: (operand) => `await ${operand}`,
};

/** What each function looks through besides parentheses. */
const SETS: Record<keyof typeof outer, readonly Wrapper[]> = {
  withoutParentheses: [],
  withoutParenthesesNonNull: ["nonNull"],
  withoutParenthesesAssertions: ["as", "angle"],
  withoutParenthesesAsSatisfies: ["as", "satisfies"],
  withoutParenthesesAssertionsSatisfies: ["as", "angle", "satisfies"],
  withoutParenthesesAssertionsNonNull: ["as", "angle", "nonNull"],
  withoutParenthesesAsSatisfiesNonNull: ["as", "satisfies", "nonNull"],
  withoutParenthesesTypeWrappers: ["as", "angle", "satisfies", "nonNull"],
  withoutParenthesesNonNullAwait: ["nonNull", "await"],
};

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, at) =>
    permutations([...items.slice(0, at), ...items.slice(at + 1)]).map((rest) => [item, ...rest]),
  );
}

test("each function stops at the first wrapper outside its set", () => {
  // Every order of the five wrappers around `value`, innermost first, with
  // parentheses between the layers: layers[i] is the text of the expression
  // with the first i wrappers applied.
  const chains = permutations(Object.keys(WRAP) as Wrapper[]).map((order) => {
    const layers = ["value"];
    for (const wrapper of order) layers.push(WRAP[wrapper](`(${layers.at(-1)!})`));
    return { order, layers };
  });
  // An export makes the file a module, where `await` is the operator and
  // not an identifier.
  const source = chains
    .map((chain, at) => `export const c${at} = (${chain.layers.at(-1)!});`)
    .join("\n");
  const file = parseSourceFile("outer-expressions.ts", source, "ts");
  expect(file.statements.nodes.length).toBe(chains.length);
  for (const [name, set] of Object.entries(SETS) as [keyof typeof outer, readonly Wrapper[]][]) {
    for (const [at, chain] of chains.entries()) {
      const statement = file.statements.nodes[at]!;
      if (!ts.isVariableStatement(statement)) throw new Error("expected a declaration");
      const initializer = statement.declarationList.declarations.nodes[0]!.initializer!;
      let layer = chain.order.length;
      while (layer > 0 && set.includes(chain.order[layer - 1]!)) layer--;
      expect(getTextOfNode(outer[name](initializer)), `${name} on ${chain.layers.at(-1)!}`).toBe(
        chain.layers[layer],
      );
    }
  }
});

test("an expression without wrappers is returned as it is", () => {
  const file = parseSourceFile("outer-expressions-bare.ts", "value.member(1);", "ts");
  const statement = file.statements.nodes[0]!;
  if (!ts.isExpressionStatement(statement)) throw new Error("expected an expression");
  for (const name of Object.keys(SETS) as (keyof typeof outer)[])
    expect(outer[name](statement.expression), name).toBe(statement.expression);
});

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts") &&
      !name.includes(".generated.")
    )
      out.push(path);
  }
  return out;
}

/** A test of one of the wrapper kinds, in source text without whitespace. */
const GUARD = String.raw`ts\.is(?:Parenthesized|As|Satisfies|NonNull|Await|Assertion|PartiallyEmitted)Expression\(\w+\)|ts\.isTypeAssertion\(\w+\)`;
/** The pieces a function is made of when all it does is step through
 * wrappers: a copy of the parameter, the loop and branch heads, the tests,
 * the step `e = e.expression`, and the exits. */
const PIECE = String.raw`let\w+(?::ts\.\w+)?=\w+;|while\(|for\(;;\)|if\(|else|[{})]|\|\||true|${GUARD}|\w+=\w+\.expression;|continue;|break;|return\w+;`;
/** The head of a function or function-valued binding from one node to one
 * node, up to its body. */
const HEAD = new RegExp(
  String.raw`(?:function(\w+)|(?:const|let|var)(\w+)=(?:function\w*)?)` +
    String.raw`\(\w+:ts\.(?:Expression|Node),?\):ts\.(?:Expression|Node)(?:=>)?`,
  "g",
);
const PIECE_AT = new RegExp(PIECE, "y");
/** The recursive spelling: `(e) => isWrapper(e) ? self(e.expression) : e`. */
const RECURSION_AT = new RegExp(String.raw`(?:${GUARD}|\|\|)+\?\w+\(\w+\.expression\):\w+;`, "y");

/** The functions in `source` whose whole body peels wrappers that include
 * parentheses. */
function peelFunctions(source: string): string[] {
  const text = source.replace(/\s+/g, "");
  const names: string[] = [];
  for (const head of text.matchAll(HEAD)) {
    const start = head.index + head[0].length;
    let body: string | null = null;
    if (text[start] === "{") {
      // Pieces only, up to the brace that closes the body.
      let at = start;
      let depth = 0;
      for (;;) {
        PIECE_AT.lastIndex = at;
        const piece = PIECE_AT.exec(text);
        if (piece === null) break;
        at += piece[0].length;
        if (piece[0] === "{") depth++;
        else if (piece[0] === "}" && --depth === 0) {
          body = text.slice(start, at);
          break;
        }
      }
    } else {
      RECURSION_AT.lastIndex = start;
      body = RECURSION_AT.exec(text)?.[0] ?? null;
    }
    if (body !== null && body.includes("ts.isParenthesizedExpression("))
      names.push(head[1] ?? head[2]!);
  }
  return names;
}

/** The peeling functions that stay outside outer-expressions.ts, each with
 * the reason. No other is accepted, and an entry that no longer matches a
 * function fails as well. */
const KEPT: Readonly<Record<string, string>> = {
  "node-islands/detect.ts#stripWrappers":
    "typed on ts.Node: the island scan holds call arguments, patterns and property names " +
    "as plain nodes, and the shared functions take and return expressions",
};

test("the search recognizes every spelling the frontend used for these functions", () => {
  const spellings = [
    `function peel(node: ts.Expression): ts.Expression {
       let e = node;
       while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
       return e;
     }`,
    `export function unparen(e: ts.Expression): ts.Expression {
       while (ts.isParenthesizedExpression(e)) {
         e = e.expression;
       }
       return e;
     }`,
    `function stripValueWrappers(e: ts.Expression): ts.Expression {
       let v: ts.Expression = e;
       for (;;) {
         if (ts.isParenthesizedExpression(v) || ts.isTypeAssertion(v)) {
           v = v.expression;
           continue;
         }
         return v;
       }
     }`,
    `function bare(expr: ts.Expression): ts.Expression {
       for (;;) {
         if (ts.isParenthesizedExpression(expr)) expr = expr.expression;
         else if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) expr = expr.expression;
         else return expr;
       }
     }`,
    `const strip = (e: ts.Expression): ts.Expression => {
       while (ts.isParenthesizedExpression(e)) e = e.expression;
       return e;
     };`,
    `const unwrap = (e: ts.Expression): ts.Expression =>
       ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e;`,
    `function stripWrappers(node: ts.Node): ts.Node {
       let value = node;
       for (;;) {
         if (ts.isParenthesizedExpression(value) || ts.isAsExpression(value)) value = value.expression;
         else return value;
       }
     }`,
  ];
  expect(spellings.flatMap(peelFunctions)).toEqual([
    "peel",
    "unparen",
    "stripValueWrappers",
    "bare",
    "strip",
    "unwrap",
    "stripWrappers",
  ]);
  // A walk that does more than peel, or that never looks through
  // parentheses, is another question and is not one of these.
  expect(
    peelFunctions(`function root(node: ts.Expression): ts.Expression {
       let e = node;
       while (ts.isParenthesizedExpression(e) || ts.isPropertyAccessExpression(e)) e = e.expression;
       return e;
     }
     function asserted(node: ts.Expression): ts.Expression {
       let e = node;
       while (ts.isAsExpression(e)) e = e.expression;
       return e;
     }
     function literal(node: ts.Expression): ts.Expression {
       let e = node;
       while (ts.isParenthesizedExpression(e)) {
         e = e.expression;
       }
       if (ts.isIdentifier(e)) return node;
       return e;
     }`),
  ).toEqual([]);
});

test("only outer-expressions.ts defines a function that peels wrappers off an expression", () => {
  const found: string[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    const path = relative(sourceRoot, file).split("\\").join("/");
    if (path === "frontend/outer-expressions.ts") continue;
    const text = readFileSync(file, "utf8");
    if (!text.includes("isParenthesizedExpression")) continue;
    for (const name of peelFunctions(text)) found.push(`${path}#${name}`);
  }
  expect(
    found.sort(),
    "a function whose whole body steps through parentheses and type wrappers belongs in " +
      "frontend/outer-expressions.ts: call the function there that looks through the same set " +
      "(withoutParentheses, withoutParenthesesTypeWrappers, ...), or add the set to that module",
  ).toEqual(Object.keys(KEPT).sort());
  expect(
    peelFunctions(readFileSync(join(sourceRoot, "frontend/outer-expressions.ts"), "utf8")),
  ).toEqual(Object.keys(SETS));
});
