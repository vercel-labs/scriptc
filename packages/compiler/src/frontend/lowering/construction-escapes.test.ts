import { afterAll, expect, test } from "vitest";
import * as ts from "../ts7/adapter.js";
import { closeSourceParser, parseSourceFile } from "../ts7/source-parser-node.js";
import { constructionEscape, mentionsReceiver } from "./construction-escapes.js";

afterAll(closeSourceParser);

function analyze(source: string, options: { derived?: boolean; baseEscapes?: boolean } = {}) {
  const file = parseSourceFile("classes.ts", source, "ts");
  let decl: ts.ClassDeclaration | undefined;
  ts.walkPreorder(file, (node) => {
    if (!decl && ts.isClassDeclaration(node)) decl = node;
  });
  if (!decl) throw new Error("fixture has no class");
  const cls = decl;
  const ctor = cls.members.nodes.find(ts.isConstructorDeclaration) ?? null;
  const fields = cls.members.nodes
    .filter(ts.isPropertyDeclaration)
    .map((member) => ({ name: ts.getTextOfNode(member.name), initializer: member.initializer }));
  const fieldNames = new Set(fields.map((field) => field.name));
  return constructionEscape({
    ctor,
    fields,
    paramProps: [],
    derived: options.derived ?? false,
    baseEscapes: options.baseEscapes ?? false,
    isField: (name) => fieldNames.has(name),
    privateMethodBody: (call) => {
      if (!ts.isPropertyAccessExpression(call.expression)) return null;
      const name = call.expression.name.text;
      const method = cls.members.nodes.find(
        (member): member is ts.MethodDeclaration =>
          ts.isMethodDeclaration(member) && ts.getTextOfNode(member.name) === name,
      );
      const isPrivate =
        method !== undefined &&
        (ts.isPrivateIdentifier(method.name) ||
          (ts.getModifiers(method)?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword) ?? false));
      return isPrivate ? (method.body ?? null) : null;
    },
  });
}

const sorted = (set: Set<string>): string[] => [...set].sort();

test("assignments before any exposure are proven", () => {
  const result = analyze(`
    class A {
      a: B; b: B; c: B;
      constructor() {
        this.a = new B();
        this.b = make(this.a);
        log("no receiver here");
        this.c = new B();
        this.report();
      }
    }`);
  expect(result.escapes).toBe(true);
  expect(sorted(result.assigned)).toEqual(["a", "b", "c"]);
});

test("a call that receives the instance stops the proof", () => {
  const result = analyze(`
    class A {
      seen: boolean; box: B;
      constructor() {
        this.seen = check(this);
        this.box = new B();
      }
    }`);
  expect(result.escapes).toBe(true);
  expect(sorted(result.assigned)).toEqual([]);
});

test("method calls, callbacks and reads of unassigned fields expose the instance", () => {
  for (const body of [
    "this.describe(); this.box = new B();",
    "const f = () => this.box; this.box = new B();",
    "this.other = this.box; this.box = new B();",
    "if (flag) this.box = new B(); this.box = new B();",
  ]) {
    const result = analyze(`class A { box: B; other: B; constructor() { ${body} } }`);
    expect(result.escapes, body).toBe(true);
    expect(result.assigned.has("box"), body).toBe(false);
  }
});

test("initializers run in order before the constructor body", () => {
  const result = analyze(`
    class A {
      first = new B();
      second = this.first;
      third = this.compute();
      fourth = new B();
      constructor() { this.fifth = new B(); }
    }`);
  expect(result.escapes).toBe(true);
  expect(sorted(result.assigned)).toEqual(["first", "second"]);
});

test("private helpers that only assign fields are followed", () => {
  const result = analyze(`
    class A {
      a!: B; b!: B; c: B;
      constructor() {
        this.setup();
        this.c = new B();
      }
      private setup(): void {
        this.a = new B();
        this.#more();
      }
      #more(): void {
        this.b = this.a;
      }
    }`);
  expect(result.escapes).toBe(false);
  expect(sorted(result.assigned)).toEqual(["a", "b", "c"]);
});

test("public helpers, helpers that return early, and early returns stop the proof", () => {
  for (const source of [
    "class A { a!: B; constructor() { this.setup(); } setup(): void { this.a = new B(); } }",
    "class A { a!: B; constructor() { this.setup(); } private setup(): void { if (x) return; this.a = new B(); } }",
    "class A { a!: B; constructor() { if (x) return; this.a = new B(); } }",
  ]) {
    const result = analyze(source);
    expect(result.escapes, source).toBe(true);
    expect(result.assigned.has("a"), source).toBe(false);
  }
});

test("derived classes inherit the base constructor's exposure", () => {
  const source = `
    class D {
      box: B;
      constructor() {
        super();
        this.box = new B();
      }
    }`;
  expect(analyze(source, { derived: true }).escapes).toBe(false);
  const exposed = analyze(source, { derived: true, baseEscapes: true });
  expect(exposed.escapes).toBe(true);
  expect(sorted(exposed.assigned)).toEqual([]);
  // Without a constructor, construction is the implicit super call.
  expect(analyze("class D { box = new B(); }", { derived: true, baseEscapes: true }).escapes).toBe(
    true,
  );
  expect(sorted(analyze("class D { box = new B(); }", { derived: true }).assigned)).toEqual([
    "box",
  ]);
});

test("nested functions with their own receiver are opaque", () => {
  const file = parseSourceFile(
    "nested.ts",
    "const f = function () { return this; }; const g = () => this;",
    "ts",
  );
  const found: boolean[] = [];
  ts.walkPreorder(file, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer)
      found.push(mentionsReceiver(node.initializer));
  });
  expect(found).toEqual([false, true]);
});
