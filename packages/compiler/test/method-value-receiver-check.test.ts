// A class method read as a value checks, at each call, that the receiver the
// call supplied is an instance. Only a method whose source never mentions
// `this` or `super` is called without that check. The lowered body does not
// decide it: tests of the receiver and of a member's type are answered from
// the class type and leave no read of `this` behind.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

type IrFunction = { name: string; body: unknown };
type IrModule = { functions: IrFunction[] };

async function compileToIr(body: string[]): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-method-receiver-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, body.join("\n"));
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const module = deserializeModule(await readFile(outPath, "utf8")) as unknown as IrModule;
    expect(validateModule(module as never)).toEqual([]);
    return module;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The adapter a value read of `Logger.<method>` produces, as text. */
function adapter(module: IrModule, method: string): string {
  const fn = module.functions.find((f) => f.name === `%method.value:%Logger.${method}`);
  if (!fn) throw new Error(`no method value adapter for ${method}`);
  return JSON.stringify(fn.body);
}

const names = (module: IrModule): string[] => module.functions.map((fn) => fn.name);

function program(method: string): string[] {
  return [
    "class Logger {",
    '  tag = "L";',
    "  #secret = 1;",
    `  ${method}`,
    "}",
    "const logger = new Logger();",
    "const f = logger.m;",
    "console.log(f());",
    "",
  ];
}

// Every one of these bodies lowers without a read of `this`: the test is
// folded on the class type.
const FOLDED = [
  "m(): boolean { return this === undefined; }",
  "m(): boolean { return this == null; }",
  "m(): boolean { return this !== undefined; }",
  "m(): string { return typeof this; }",
  "m(): boolean { return this instanceof Logger; }",
  "m(): string { return typeof this.tag; }",
  "m(): boolean { return this.tag !== undefined; }",
  "m(): boolean { return #secret in this; }",
  // An overloaded method: the implementation decides, not a signature.
  'm(): string; m(prefix: string): string; m(prefix?: string): string { return (prefix ?? "") + typeof this; }',
  "m(missing: boolean = this === undefined): boolean { return missing; }",
  "m(): boolean { const absent = (): boolean => this === undefined; return absent(); }",
];

for (const method of FOLDED)
  test(`a method value checks its receiver: ${method}`, async () => {
    const module = await compileToIr(program(method));
    expect(adapter(module, "m")).toContain("%method.receiver:Logger");
    expect(names(module)).not.toContain("%method.receiverless:%Logger.m");
  });

test("a method that reads a member checks its receiver, as before", async () => {
  const module = await compileToIr(program("m(): string { return this.tag; }"));
  expect(adapter(module, "m")).toContain("%method.receiver:Logger");
  expect(names(module)).not.toContain("%method.receiverless:%Logger.m");
});

// No `this` in the method's own source: it is callable without a receiver.
const RECEIVER_FREE = [
  'm(): string { return "plain"; }',
  "m(): boolean { function inner(this: unknown): boolean { return this === undefined; } return inner.call(1); }",
  "m(): boolean { const inner = function (this: unknown): boolean { return this === undefined; }; return inner.call(1); }",
  'm(): string { const copy: this | undefined = undefined; return copy === undefined ? "none" : "some"; }',
];

for (const method of RECEIVER_FREE)
  test(`a method value needs no receiver: ${method}`, async () => {
    const module = await compileToIr(program(method));
    expect(adapter(module, "m")).not.toContain("%method.receiver:Logger");
    expect(names(module)).toContain("%method.receiverless:%Logger.m");
  });

// `(c.m)()`, `c.m!()` and `(c.m as F)()` are method calls: no method value is
// read, so no adapter exists. A comma in the callee reads the value.
test("a parenthesized or asserted member callee is a method call", async () => {
  const direct = await compileToIr([
    "class Logger {",
    '  tag = "L";',
    "  m(): string { return this.tag; }",
    "}",
    "const logger = new Logger();",
    "console.log((logger.m)(), logger.m!(), (logger.m as () => string)());",
    "",
  ]);
  expect(names(direct)).not.toContain("%method.value:%Logger.m");
  const value = await compileToIr([
    "class Logger {",
    '  tag = "L";',
    "  m(): string { return this.tag; }",
    "}",
    "const logger = new Logger();",
    "console.log((0, logger.m)());",
    "",
  ]);
  expect(names(value)).toContain("%method.value:%Logger.m");
});
