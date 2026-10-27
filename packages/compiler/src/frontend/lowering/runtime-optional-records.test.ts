import { afterAll, expect, test } from "vitest";
import * as ts from "../ts7/adapter.js";
import { closeSourceParser, parseSourceFile } from "../ts7/source-parser-node.js";
import { RecordFlowClasses, type RecordFlowHost } from "./runtime-optional-records.js";

afterAll(closeSourceParser);

/** Flow classes over one parsed file. Names are unique per test, so a
 * binding's symbol is its name; a slot holds a record when its annotation
 * names a type starting with `R` (the shape) or, unannotated, when it is
 * initialized from an object literal or a call. */
function classes(source: string): {
  classOf(name: string): number | null;
  closed(name: string): boolean;
  opened(name: string): boolean;
  returns(name: string): number | null;
} {
  const file = parseSourceFile("records.ts", source, "ts");
  const symbols = new Map<string, ts.Symbol>();
  const declarations = new Map<ts.Symbol, ts.Node>();
  const symbolFor = (name: string): ts.Symbol => {
    let symbol = symbols.get(name);
    if (!symbol) {
      symbol = { escapedName: name, declarations: [] } as unknown as ts.Symbol;
      symbols.set(name, symbol);
    }
    return symbol;
  };
  ts.walkPreorder(file, (node) => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isMethodDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      const symbol = symbolFor(node.name.text);
      declarations.set(symbol, node);
      (symbol.declarations as unknown as ts.Node[]).push(node);
    }
    return undefined;
  });
  const annotated = (type: ts.TypeNode | undefined): string | null => {
    if (!type || !ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return null;
    return type.typeName.text.startsWith("R") ? type.typeName.text : null;
  };
  const host: RecordFlowHost = {
    symbolOf: (node) =>
      ts.isIdentifier(node) && node.text !== "console" && node.text !== "undefined"
        ? symbolFor(node.text)
        : null,
    declarationOf: (symbol) => declarations.get(symbol),
    recordShape: (node) => {
      // Field slots: a binding's field read where a record is expected.
      if (ts.isPropertyAccessExpression(node)) return "R";
      const declaration = node.parent;
      if (!declaration) return null;
      if (ts.isParameter(declaration)) return annotated(declaration.type);
      if (!ts.isVariableDeclaration(declaration)) return null;
      if (declaration.type) return annotated(declaration.type);
      const init = declaration.initializer;
      return init && (ts.isObjectLiteralExpression(init) || ts.isCallExpression(init)) ? "R" : null;
    },
    returnShape: (fn) => annotated(fn.type),
    mayBeRecord: (node) => host.recordShape(node) !== null,
    prefetchTypes: () => {},
    mayReturnRecord: (fn) => annotated(fn.type) !== null,
    familyOf: () => undefined,
    isGlobal: (node, name) => ts.isIdentifier(node) && node.text === name,
  };
  const flows = new RecordFlowClasses([file], host);
  const classOf = (name: string): number | null => flows.bindingClass(symbolFor(name));
  return {
    classOf,
    closed: (name) => {
      const id = classOf(name);
      return id !== null && flows.closed(id);
    },
    opened: (name) => flows.opened(symbolFor(name)),
    returns: (name) => flows.returnClass(symbolFor(name)),
  };
}

test("literals, parameters, returns and bindings form one closed class", () => {
  const flows = classes(`
    function make(a: number[], i: number): R { return { v: a[i] }; }
    function show(p: R): string { return String(p.v); }
    function pass(q: R): R { return q; }
    const made = make([], 0);
    const passed = pass(made);
    console.log(show(passed), show({ v: 1 }), passed === made, made.v);
  `);
  expect(flows.closed("made")).toBe(true);
  for (const name of ["passed", "p", "q"]) expect(flows.classOf(name)).toBe(flows.classOf("made"));
  expect(flows.returns("make")).toBe(flows.classOf("made"));
  expect(flows.returns("pass")).toBe(flows.classOf("made"));
});

test("a member stored elsewhere opens its whole class", () => {
  const flows = classes(`
    function keep(p: R, out: unknown[]): void { out.push(p); }
    const o = { v: 1 };
    keep(o, []);
    const other = { v: 2 };
    console.log(other.v);
  `);
  expect(flows.classOf("p")).toBe(flows.classOf("o"));
  expect(flows.closed("o")).toBe(false);
  expect(flows.opened("p")).toBe(true);
  expect(flows.closed("other")).toBe(true);
  expect(flows.opened("other")).toBe(false);
});

test("methods the runtime can call without a call site are not tracked", () => {
  const flows = classes(`
    class Plain { use(p: R): number { return p.v; } }
    class Listener { handleEvent(e: R): void { console.log(e.v); } }
    class Mine extends EventTarget { mine(q: R): number { return q.v; } }
    class Base { base(): number { return 0; } }
    class Derived extends Base { derived(s: R): number { return s.v; } }
    new Plain().use({ v: 1 });
    new Listener().handleEvent({ v: 2 });
    new Mine().mine({ v: 3 });
    new Derived().derived({ v: 4 });
  `);
  expect(flows.classOf("p")).not.toBeNull();
  expect(flows.classOf("s")).not.toBeNull();
  expect(flows.classOf("e")).toBeNull();
  expect(flows.classOf("q")).toBeNull();
});

test("a function used as a value has no tracked parameters", () => {
  const flows = classes(`
    function show(p: R): string { return String(p.v); }
    const shown = [].map(show);
    const r = { v: 1 };
    show(r);
  `);
  expect(flows.classOf("p")).toBeNull();
  expect(flows.closed("r")).toBe(false);
});

test("shorthand properties, element writes and foreign sources open a class", () => {
  const flows = classes(`
    const nested = { v: 1 };
    const holder = { nested };
    const fromField = holder.inner;
    const copied = { v: 2 };
    const box: unknown[] = [copied];
    const read = { v: 3 };
    console.log(read.v, { ...read }, read === undefined, \`\${read}\`);
  `);
  expect(flows.closed("nested")).toBe(false);
  expect(flows.closed("fromField")).toBe(false);
  expect(flows.closed("copied")).toBe(false);
  expect(flows.closed("read")).toBe(true);
});

test("members of different declared shapes do not share a widened layout", () => {
  const flows = classes(`
    function wide(p: RWide): RWide { return p; }
    const narrow: RNarrow = { v: 1 };
    wide(narrow);
  `);
  expect(flows.classOf("narrow")).toBe(flows.classOf("p"));
  expect(flows.closed("narrow")).toBe(false);
  // Not opened: the class reaches no other storage.
  expect(flows.opened("narrow")).toBe(false);
});

test("assignments join their target and a foreign value opens it", () => {
  const flows = classes(`
    let target = { v: 1 };
    const joined = { v: 2 };
    target = joined;
    let other = { v: 3 };
    other ??= target;
    let foreign = { v: 4 };
    foreign = holder.inner;
  `);
  expect(flows.classOf("target")).toBe(flows.classOf("joined"));
  expect(flows.classOf("other")).toBe(flows.classOf("target"));
  expect(flows.closed("target")).toBe(true);
  expect(flows.closed("foreign")).toBe(false);
});

test("a binding's record field joins the slots it reaches and widens with its owner", () => {
  const flows = classes(`
    function fill(into: R): void { into.v = 1; }
    const state = { parsed: { v: 0 } };
    fill(state.parsed);
    function mark(m: R): void { m.v = 2; }
    const spread = { parsed: { v: 0 } };
    mark(spread.parsed);
    console.log({ ...spread });
  `);
  expect(flows.closed("into")).toBe(true);
  expect(flows.closed("state")).toBe(true);
  // A spread copies the field out of its owner, so the record keeps its layout.
  expect(flows.closed("m")).toBe(false);
});
