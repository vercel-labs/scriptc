import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import type { IrExpr, IrFunction, IrModule } from "../src/ir/ir.js";
import { everyStmtList } from "../src/ir/traverse.js";

async function compileToIr(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-function-views-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    return mod;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The `viewOf` tests in a function's body. */
function viewTests(fn: IrFunction): Extract<IrExpr, { kind: "viewOf" }>[] {
  const tests: Extract<IrExpr, { kind: "viewOf" }>[] = [];
  everyStmtList(fn.body, {
    expr: (e) => {
      if (e.kind === "viewOf") tests.push(e);
      return true;
    },
    stmt: () => true,
  });
  return tests;
}

function allViewTests(mod: IrModule): Extract<IrExpr, { kind: "viewOf" }>[] {
  return mod.functions.flatMap(viewTests);
}

const LABEL = `function label(prefix: string, options?: { upper: boolean }): string {
  return options?.upper ? prefix.toUpperCase() : prefix;
}
function plain(prefix: string): string { return prefix + "!"; }
type One = (prefix: string) => string;
type Two = (prefix: string, options: { upper: boolean }) => string;
`;

test("a widening adapter tests for the views of its source type and for nothing else", async () => {
  const mod = await compileToIr(
    `${LABEL}function narrowOf(f: One): One { return f; }
function widen(f: One): Two { return f; }
console.log(widen(narrowOf(label))("abc", { upper: true }), widen(plain)("abc", { upper: true }));
`,
  );
  // One view of `One` exists (label's), and one adapter widens `One`: that
  // adapter's factory holds the one test, ahead of the plain adapter.
  const tests = allViewTests(mod);
  expect(tests).toHaveLength(1);
  const adapter = tests[0]!.adapter;
  expect(adapter).not.toBeNull();
  const body = mod.functions.find((fn) => fn.name === adapter);
  expect(body?.captures?.[0]?.type).toMatchObject({ kind: "func" });
  // The view's body forwards to a function of two parameters.
  const forwarded = body!.captures![0]!.type;
  expect(forwarded.kind === "func" && forwarded.params.length).toBe(2);
  const factory = mod.functions.find((fn) => viewTests(fn).length === 1)!;
  expect(factory.body.at(-1)).toMatchObject({ kind: "return", value: { kind: "closure" } });
});

test("a program that narrows without widening, or widens without narrowing, has no test", async () => {
  const narrowOnly = await compileToIr(
    `${LABEL}function narrowOf(f: One): One { return f; }
console.log(narrowOf(label)("abc"));
`,
  );
  expect(allViewTests(narrowOnly)).toEqual([]);
  const widenOnly = await compileToIr(
    `${LABEL}function widen(f: One): Two { return f; }
console.log(widen(plain)("abc", { upper: true }));
`,
  );
  expect(allViewTests(widenOnly)).toEqual([]);
});

test("a shared array-method helper tests for the views of its callback type", async () => {
  const withView = await compileToIr(
    `function show(x: string, i?: number): string { return x + (i ?? "_"); }
function each(xs: string[], f: (x: string) => string): string[] { return xs.map(f); }
console.log(each(["a", "b"], show).join(" "));
`,
  );
  const helpers = withView.functions.filter(
    (fn) => fn.name.startsWith("%arr.map.") && viewTests(fn).length > 0,
  );
  expect(helpers).toHaveLength(1);
  // The test hands the function to the helper built for (value, index, array).
  const wide = withView.functions.filter(
    (fn) =>
      fn.name.startsWith("%arr.map.") &&
      fn.params[1]?.type.kind === "func" &&
      fn.params[1].type.params.length === 3,
  );
  expect(wide).toHaveLength(1);
  const withoutView = await compileToIr(
    `function plain(x: string): string { return x + "!"; }
function each(xs: string[], f: (x: string) => string): string[] { return xs.map(f); }
console.log(each(["a", "b"], plain).join(" "), ["c"].map((x) => x + "?").join(" "));
`,
  );
  expect(allViewTests(withoutView)).toEqual([]);
});

const PAYLOAD = `interface Payload { diff: string; path: string }
type Show = (payload: Payload) => string;
function loose(payload: any): string { return "loose " + JSON.stringify(payload); }
function exact(payload: Payload): string { return "exact " + payload.diff; }
function keep(show: Show): Show { return show; }
`;

test("a conversion to a wider parameter type returns the function a view forwards to", async () => {
  const mod = await compileToIr(
    `${PAYLOAD}const wide: (payload: any) => string = keep(loose);
console.log(wide({}));
`,
  );
  // One view of `Show` converts the parameter (loose's), and one adapter
  // takes `Show` to a type whose parameter is untyped: its factory holds the
  // one test, and the test hands back the function itself.
  const tests = allViewTests(mod);
  expect(tests).toHaveLength(1);
  const factory = mod.functions.find((fn) => viewTests(fn).length === 1)!;
  expect(factory.body[0]).toMatchObject({
    kind: "if",
    then: [{ kind: "return", value: { kind: "viewSource", adapter: tests[0]!.adapter } }],
  });
  expect(factory.body.at(-1)).toMatchObject({ kind: "return", value: { kind: "closure" } });
  // The program boxes no function of the slot's type: the view has no mark.
  expect(mod.functions.some((fn) => fn.boxesSource === true)).toBe(false);
});

test("a view boxes as the function it forwards to in a program that boxes its type", async () => {
  const marked = (mod: IrModule): string[] =>
    mod.functions.filter((fn) => fn.boxesSource === true).map((fn) => fn.name);
  // Boxed by itself, and inside a record viewed at any.
  const direct = await compileToIr(
    `${PAYLOAD}const held: any = keep(loose);
console.log(held({}));
`,
  );
  expect(marked(direct)).toHaveLength(1);
  const contained = await compileToIr(
    `${PAYLOAD}const record: { show: Show } = { show: loose };
const held: any = record;
console.log(held.show({}));
`,
  );
  expect(marked(contained)).toHaveLength(1);
  // The view's body is the code of an adapting closure over the function.
  const body = contained.functions.find((fn) => fn.boxesSource === true)!;
  expect(body.captures?.[0]?.type).toMatchObject({ kind: "func", params: [{ kind: "dyn" }] });
  // A typed program that holds the same view boxes nothing.
  const typed = await compileToIr(
    `${PAYLOAD}console.log(keep(loose)({ diff: "d", path: "p" }));
`,
  );
  expect(marked(typed)).toEqual([]);
  expect(allViewTests(typed)).toEqual([]);
});

test("a call through the slot's type, or of a function the slot's type is the type of, has no test", async () => {
  // The slot's contract binds a call through its type.
  const typedCall = await compileToIr(
    `${PAYLOAD}const empty: any = {};
try { console.log(keep(loose)(empty)); } catch (error) { console.log("threw"); }
`,
  );
  expect(allViewTests(typedCall)).toEqual([]);
  // No view: the function has the slot's parameter type.
  const ownType = await compileToIr(
    `${PAYLOAD}const wide: (payload: any) => string = keep(exact);
try { console.log(wide({})); } catch (error) { console.log("threw"); }
`,
  );
  expect(allViewTests(ownType)).toEqual([]);
  expect(ownType.functions.some((fn) => fn.boxesSource === true)).toBe(false);
});

test("typed conversions of a parameter, one after the other, have no test", async () => {
  // A function of a base class in a slot of a subclass, read at a slot of a
  // further subclass: each step narrows what callers pass, so no caller
  // can hand the function more than the slot's type admits.
  const mod = await compileToIr(
    `class Animal { name = "a"; }
class Dog extends Animal { bark = "b"; }
class Puppy extends Dog { age = 1; }
function animal(a: Animal): string { return a.name; }
function dogs(f: (d: Dog) => string): (d: Dog) => string { return f; }
function puppies(f: (d: Dog) => string): (p: Puppy) => string { return f; }
console.log(puppies(dogs(animal))(new Puppy()));
`,
  );
  expect(allViewTests(mod)).toEqual([]);
});

test("a conversion to a wider parameter type converts a callable that crossed any itself", async () => {
  // The slot holds the checked-dynamic boundary's view of the callable.
  // The adapter to the untyped parameter asks for it and checks the
  // callable into the wide type, so no call converts through the slot's.
  const mod = await compileToIr(
    `${PAYLOAD}const crossed: any = loose;
const slot: { show: Show } = { show: crossed };
const wide: (payload: any) => string = slot.show;
console.log(wide({}));
`,
  );
  expect(allViewTests(mod).map((test) => test.adapter)).toEqual([null]);
});
