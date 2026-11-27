import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import type { IrExpr, IrFunction, IrModule, IrStmt } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";

/** Lower one program to IR, with the project's tsconfig written beside it
 * (the legacy dialect is a tsconfig fact). */
async function lower(source: string, tsconfig: object | null = null): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-legacy-decorators-"));
  try {
    const entry = join(dir, "main.ts"),
      outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    if (tsconfig !== null) await writeFile(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    return deserializeModule(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const legacyTsconfig = {
  compilerOptions: {
    target: "ES2022",
    strict: true,
    experimentalDecorators: true,
    module: "nodenext",
    moduleResolution: "nodenext",
  },
};

function initFunction(mod: IrModule): IrFunction {
  const init = mod.functions.find((fn) => fn.name === "%init.0");
  expect(init).toBeDefined();
  return init!;
}

function exprs(fn: IrFunction): IrExpr[] {
  const found: IrExpr[] = [];
  everyStmtList(fn.body, {
    stmt: () => true,
    expr: (e) => {
      found.push(e);
      return true;
    },
  });
  return found;
}

function statements(fn: IrFunction): IrStmt[] {
  return fn.body;
}

/** The statement that stores the class's first static field initializer. */
function staticStore(fn: IrFunction, className: string): IrStmt | undefined {
  return statements(fn).find(
    (s) => s.kind === "assign" && s.localId.startsWith(`%g.s.${className}.`),
  );
}

test("a legacy method decorator runs after the static initializers, with a method descriptor", async () => {
  const source = [
    "function make(): (t: object, k: string, d: PropertyDescriptor) => void {",
    "  return (t: object, k: string, d: PropertyDescriptor): void => { console.log(k, d.value); };",
    "}",
    "class Widget {",
    "  static s = 1;",
    "  @make()",
    "  run(x: number): number { return x + 1; }",
    "}",
    "console.log(new Widget().run(1));",
    "",
  ].join("\n");
  const mod = await lower(source, legacyTsconfig);
  const init = initFunction(mod);
  const store = staticStore(init, "Widget");
  expect(store).toBeDefined();
  const expressions = exprs(init);
  const application = expressions.find((e) => e.kind === "dynCall" && e.calleeName === "decorator");
  expect(application).toBeDefined();
  // The static initializer's statement precedes the decoration statements.
  const storeAt = statements(init).indexOf(store!);
  const applicationStatement = statements(init).findIndex((s) => {
    let found = false;
    everyStmtList([s], {
      stmt: () => true,
      expr: (e) => {
        if (e === application) found = true;
        return true;
      },
    });
    return found;
  });
  expect(storeAt).toBeGreaterThanOrEqual(0);
  expect(applicationStatement).toBeGreaterThan(storeAt);
  // The descriptor is read from the prototype at decoration time, so a
  // replacement made before the decoration is what the decorators see.
  const descriptor = expressions.find(
    (e) => e.kind === "libCall" && e.fn === "dyn.getOwnPropertyDescriptor",
  );
  expect(descriptor).toBeDefined();
  // The final descriptor is defined on the prototype (the defineProperty
  // builtin may be lifted to a `%dyn.class.defineProperty` call).
  const defines = expressions.filter(
    (e) =>
      (e.kind === "libCall" && e.fn === "dyn.defineProperty") ||
      (e.kind === "call" && e.callee.startsWith("%dyn.class.defineProperty")),
  );
  expect(defines.length).toBeGreaterThan(0);
});

test("a legacy property decorator gets (target, key, undefined) and defines nothing", async () => {
  const source = [
    "function mark(): (t: object, k: string) => void {",
    "  return (t: object, k: string): void => { console.log(k); };",
    "}",
    "class Widget {",
    "  @mark()",
    "  name = 'w';",
    "}",
    "console.log(new Widget().name);",
    "",
  ].join("\n");
  const mod = await lower(source, legacyTsconfig);
  const init = initFunction(mod);
  const expressions = exprs(init);
  const application = expressions.find((e) => e.kind === "dynCall" && e.calleeName === "decorator");
  expect(application).toBeDefined();
  if (application?.kind !== "dynCall") throw new Error("expected a dynamic call");
  expect(application.args).toHaveLength(3);
  const defines = expressions.filter((e) => e.kind === "libCall" && e.fn === "dyn.defineProperty");
  expect(defines).toHaveLength(0);
});

test("constructor parameter decorators decorate a class with no class decorator", async () => {
  const source = [
    "function inject(): (t: object, k: string | symbol | undefined, i: number) => void {",
    "  return (t: object, k: string | symbol | undefined, i: number): void => { console.log(k, i); };",
    "}",
    "class Widget {",
    "  constructor(@inject() public dep: number) {}",
    "}",
    "console.log(new Widget(1).dep);",
    "",
  ].join("\n");
  const mod = await lower(source, legacyTsconfig);
  const init = initFunction(mod);
  const application = exprs(init).find((e) => e.kind === "dynCall" && e.calleeName === "decorator");
  expect(application).toBeDefined();
  if (application?.kind !== "dynCall") throw new Error("expected a dynamic call");
  // (class, undefined, index)
  expect(application.args).toHaveLength(3);
});

test("a class whose only decoration is a method decorator still runs it", async () => {
  const source = [
    "function make(): (t: object, k: string, d: PropertyDescriptor) => void {",
    "  return (t: object, k: string, d: PropertyDescriptor): void => { console.log(k); };",
    "}",
    "class Widget {",
    "  @make()",
    "  run(): number { return 1; }",
    "}",
    "console.log(new Widget().run());",
    "",
  ].join("\n");
  const mod = await lower(source, legacyTsconfig);
  const init = initFunction(mod);
  const application = exprs(init).find((e) => e.kind === "dynCall" && e.calleeName === "decorator");
  expect(application).toBeDefined();
});

test("a legacy class decorator applies after the static initializers", async () => {
  const source = [
    "function register(t: typeof Widget): void { console.log(t.name); }",
    "@register",
    "class Widget {",
    "  static s = (console.log('static'), 1);",
    "}",
    "console.log(Widget.s);",
    "",
  ].join("\n");
  const mod = await lower(source, legacyTsconfig);
  const init = initFunction(mod);
  const store = staticStore(init, "Widget");
  expect(store).toBeDefined();
  const storeAt = statements(init).indexOf(store!);
  const apply = statements(init).findIndex((s) => s.kind === "exprStmt");
  expect(storeAt).toBeGreaterThanOrEqual(0);
  expect(apply).toBeGreaterThan(storeAt);
});

test("legacy class decorator expressions evaluate after the static field, in source order", async () => {
  const source = [
    "function tag(t: typeof Widget): void { console.log(t.name); }",
    "function pick(): typeof tag { console.log('factory'); return tag; }",
    "@pick()",
    "class Widget {",
    "  static s = (console.log('static'), 1);",
    "}",
    "",
  ].join("\n");
  const mod = await lower(source, legacyTsconfig);
  const init = initFunction(mod);
  const store = staticStore(init, "Widget");
  const expressions = exprs(init);
  const factory = expressions.find((e) => e.kind === "call" && e.callee === "pick");
  expect(factory).toBeDefined();
  const storeIndex = statements(init).indexOf(store!);
  const factoryStatement = statements(init).findIndex((s) => {
    let found = false;
    everyStmtList([s], {
      stmt: () => true,
      expr: (e) => {
        if (e === factory) found = true;
        return true;
      },
    });
    return found;
  });
  expect(factoryStatement).toBeGreaterThan(storeIndex);
});

test("a standard-decorator program still fenced member decorators", async () => {
  const source = [
    "function make(): (value: object, context: any) => void {",
    "  return (value: object, context: any): void => { console.log(typeof value, context); };",
    "}",
    "class Widget {",
    "  @make()",
    "  run(): number { return 1; }",
    "}",
    "",
  ].join("\n");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-legacy-decorators-fence-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    const result = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "main.ir.json"),
      outputKind: "ir",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.diagnostics.map((d) => d.code)).toContain("SC1090");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy method decorators on a base with a generic subclass are refused", async () => {
  const source = [
    "function guard(t: object, k: string, d: PropertyDescriptor): void {",
    "  d.value = function (this: unknown, x: number): number { return x; };",
    "}",
    "class Base {",
    "  @guard",
    "  m(x: number): number { return x; }",
    "}",
    "class Sub<T> extends Base {}",
    "console.log(new Sub<number>().m(1));",
    "",
  ].join("\n");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-legacy-decorators-generic-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify(legacyTsconfig));
    const result = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "main.ir.json"),
      outputKind: "ir",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.diagnostics.map((d) => d.code)).toContain("SC1090");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a dynamic legacy class decorator on a base with subclasses is refused", async () => {
  const source = [
    "type LegacyClassDecorator = <T>(target: T) => T | void;",
    "function injectable(): LegacyClassDecorator {",
    "  return <T>(target: T): T | void => { return undefined; };",
    "}",
    "@injectable()",
    "class Base {}",
    "class Sub extends Base {}",
    "console.log(new Sub() instanceof Base);",
    "",
  ].join("\n");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-legacy-decorators-dynamic-sub-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify(legacyTsconfig));
    const result = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "main.ir.json"),
      outputKind: "ir",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.diagnostics.map((d) => d.code)).toContain("SC1090");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy accessor decorators on a built-in error subclass are refused", async () => {
  const source = [
    "function guard(t: object, k: string, d: PropertyDescriptor): void {",
    '  d.get = function (this: unknown): string { return "guarded"; };',
    "}",
    "class E extends Error {",
    "  @guard",
    '  get info(): string { return "orig"; }',
    "}",
    "console.log(new E().info);",
    "",
  ].join("\n");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-legacy-decorators-error-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify(legacyTsconfig));
    const result = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "main.ir.json"),
      outputKind: "ir",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.diagnostics.map((d) => d.code)).toContain("SC1090");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
