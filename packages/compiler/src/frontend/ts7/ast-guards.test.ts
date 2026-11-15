import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import * as guards from "./ast-guards.generated.js";
import { tokenToString } from "./ast-tokens.generated.js";
import { NodeFlags, OuterExpressionKinds, ScriptKind, SyntaxKind } from "./enums.js";

const require = createRequire(import.meta.url);
const sdkRoot = dirname(require.resolve("typescript/package.json"));
type Predicate = (value: unknown, kinds?: number) => boolean;
const upstream = require(join(sdkRoot, "dist/ast/is.js")) as Record<string, Predicate>;
const owned = guards as unknown as Record<string, Predicate>;
const signatures = ["is.generated.d.ts", "is.d.ts"].flatMap((file) =>
  [
    ...readFileSync(join(sdkRoot, "dist/ast", file), "utf8").matchAll(
      /export declare function (is\w+)\((\w+):/g,
    ),
  ].map((match) => ({ name: match[1]!, node: match[2] !== "kind" })),
);

test("all owned guards match the pinned kind and flag predicates", () => {
  expect(signatures.length).toBeGreaterThan(300);
  expect(
    Object.keys(guards)
      .filter((name) => name.startsWith("is"))
      .sort(),
  ).toEqual(signatures.map((entry) => entry.name).sort());
  for (const entry of signatures) {
    const oracle = upstream[entry.name]!;
    const actual = owned[entry.name]!;
    for (let kind = -1; kind <= SyntaxKind.Count + 1; kind++) {
      for (const scriptKind of [ScriptKind.TS, ScriptKind.JS]) {
        const expression = { kind: SyntaxKind.AsExpression, type: { flags: NodeFlags.Reparsed } };
        const value = entry.node
          ? {
              kind,
              expression,
              // Some guards walk two levels up; a source file above a source
              // file ends every walk without a property name in sight.
              parent: { kind: SyntaxKind.SourceFile, parent: { kind: SyntaxKind.SourceFile } },
              getSourceFile: () => ({ scriptKind }),
            }
          : kind;
        expect(actual(value), `${entry.name}(${kind}, ${scriptKind})`).toBe(oracle(value));
        if (entry.name === "isOuterExpression") {
          for (const mask of [
            0,
            OuterExpressionKinds.Parentheses,
            OuterExpressionKinds.ExcludeJSDocTypeAssertion | OuterExpressionKinds.All,
          ]) {
            expect(actual(value, mask), `${entry.name}(${kind}, ${scriptKind}, ${mask})`).toBe(
              oracle(value, mask),
            );
          }
        }
      }
    }
    if (entry.node) expect(actual(undefined), `${entry.name}(missing node)`).toBe(false);
  }
});

test("native token spelling preserves every SDK token and unknown values", () => {
  const oracle = require(join(sdkRoot, "dist/ast/scanner.js")) as {
    tokenToString: typeof tokenToString;
  };
  for (let kind = -1; kind <= SyntaxKind.Count + 1; kind++)
    expect(tokenToString(kind), String(kind)).toBe(oracle.tokenToString(kind));
  for (const kind of [0.5, NaN, Infinity, -Infinity]) expect(tokenToString(kind)).toBeUndefined();
});
