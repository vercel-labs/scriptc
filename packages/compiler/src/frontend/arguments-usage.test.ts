import { afterAll, expect, test } from "vitest";
import { argumentsAliasingUnobservable } from "./arguments-usage.js";
import * as ts from "./ts7/adapter.js";
import { closeSourceParser, parseSourceFile } from "./ts7/source-parser-node.js";

afterAll(closeSourceParser);

function unobservable(source: string): boolean {
  const file = parseSourceFile("scan.js", source, "js");
  const fn = file.statements.nodes.find(ts.isFunctionDeclaration);
  if (fn === undefined) throw new Error("no function declaration");
  return argumentsAliasingUnobservable(fn);
}

test("element reads stay unobservable while nothing writes a parameter", () => {
  expect(unobservable("function f(a, b) { return arguments[0] + arguments.length; }")).toBe(true);
  expect(unobservable("function f(a) { var a; return arguments[0]; }")).toBe(true);
  expect(unobservable("function f(a) { var b = 1; return arguments[0] + b; }")).toBe(true);
});

test("a parameter written by assignment or by a declaration makes element reads observable", () => {
  for (const body of [
    "a = 5;",
    "a++;",
    "var a = 5;",
    "for (var a in o);",
    "for (var a of o);",
    "var { a } = o;",
    "var [a] = o;",
    "function a() {}",
  ]) {
    expect(unobservable(`function f(a, o) { ${body} return arguments[0]; }`), body).toBe(false);
  }
});
