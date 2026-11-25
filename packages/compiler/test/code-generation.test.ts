import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrExpr, IrModule, IrStmt } from "../src/ir/ir.js";
import { everyExprChild, everyStmtChild } from "../src/ir/traverse.js";
import { CODE_GENERATION_DISALLOWED } from "../src/frontend/lowering/code-generation.js";

/** Compiles `source` (as `main.<extension>`) to its IR module. */
async function compileToIr(source: string, extension: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-code-generation-"));
  try {
    const entry = join(dir, `main.${extension}`);
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return deserializeModule(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every code-generation refusal the module throws. */
function codeGenerationThrows(mod: IrModule): IrExpr[] {
  const found: IrExpr[] = [];
  const expr = (e: IrExpr): boolean => {
    if (
      e.kind === "libCall" &&
      e.fn === "error.nodeThrow" &&
      e.args.some((arg) => arg.kind === "strLit" && arg.value === CODE_GENERATION_DISALLOWED)
    )
      found.push(e);
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => everyStmtChild(s, expr, stmt);
  for (const fn of mod.functions) for (const bodyStmt of fn.body) stmt(bodyStmt);
  return found;
}

/** The sequence expressions a module's bodies hold, outermost first. */
function sequences(mod: IrModule): Extract<IrExpr, { kind: "seqExpr" }>[] {
  const found: Extract<IrExpr, { kind: "seqExpr" }>[] = [];
  const expr = (e: IrExpr): boolean => {
    if (e.kind === "seqExpr") found.push(e);
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => everyStmtChild(s, expr, stmt);
  for (const fn of mod.functions) for (const bodyStmt of fn.body) stmt(bodyStmt);
  return found;
}

/** The dynamic call a `<function>.constructor(...)` site lowers to, found by
 * the `%constructorReceiver` slot its receiver is evaluated into. */
function constructorCall(mod: IrModule): {
  slot: string;
  init: IrExpr;
  call: Extract<IrExpr, { kind: "dynCall" }>;
} | null {
  for (const sequence of sequences(mod)) {
    const decl = sequence.stmts[0];
    if (decl?.kind !== "varDecl" || !decl.localId.startsWith("%constructorReceiver")) continue;
    for (const result of [sequence.result]) {
      if (result.kind === "dynCall" && result.receiver?.kind === "varRef")
        return { slot: decl.localId, init: decl.init, call: result };
    }
  }
  return null;
}

test("a function value's constructor read and call go through the value", async () => {
  const mod = await compileToIr(
    `function pick(): () => number {
  return () => 1;
}
function argument(): string {
  return "return 1";
}
pick().constructor(argument());
`,
    "ts",
  );
  // No static refusal: a callable return type cannot prove the function has
  // no own `constructor` property, so the value decides.
  expect(codeGenerationThrows(mod)).toEqual([]);
  const dispatched = constructorCall(mod);
  expect(dispatched).not.toBeNull();
  // The receiver is evaluated once, before the arguments reach the call.
  expect(dispatched!.init.kind).toBe("dynFrom");
  expect((dispatched!.init as Extract<IrExpr, { kind: "dynFrom" }>).value).toMatchObject({
    kind: "call",
    callee: "pick",
  });
  expect(dispatched!.call.calleeName).toBe("pick(...).constructor");
  expect(dispatched!.call.receiver).toMatchObject({ kind: "varRef", localId: dispatched!.slot });
  expect(dispatched!.call.args).toHaveLength(1);
});

test("a nullable function receiver reads the member before the arguments", async () => {
  const mod = await compileToIr(
    `const maybe: (() => number) | undefined = undefined;
function argument(): string {
  return "return 1";
}
maybe!.constructor(argument());
`,
    "ts",
  );
  // The receiver may be undefined at run time, where Node throws the
  // property-read TypeError instead of reaching the constructor at all, so
  // the read keeps deciding on the value.
  expect(codeGenerationThrows(mod)).toEqual([]);
  const dispatched = constructorCall(mod);
  expect(dispatched).not.toBeNull();
  expect(dispatched!.call.calleeName).toBe("maybe.constructor");
  // Only the receiver is evaluated into a statement of its own; the
  // argument stays in the call, so the member read (the call's callee) runs
  // before it and a nullish receiver throws first.
  expect(sequences(mod).find((seq) => seq.result === dispatched!.call)!.stmts).toHaveLength(1);
  expect(dispatched!.call.args).toHaveLength(1);
});

test("a class value's constructor keeps the static refusal", async () => {
  const mod = await compileToIr(
    `class Example {
  method() {
    return 4;
  }
}
Example.constructor("return 1");
`,
    "ts",
  );
  // A class object answers the Function constructor, which the compiler
  // refuses without running the arguments' conversions.
  expect(codeGenerationThrows(mod)).toHaveLength(1);
});

test("a function the program gives its own constructor property keeps it", async () => {
  const mod = await compileToIr(
    `const made = () => 1;
made.constructor = () => 2;
console.log(made.constructor());
`,
    "js",
  );
  expect(codeGenerationThrows(mod)).toEqual([]);
});

/** The construction a `new <function>.constructor(...)` site lowers to,
 * found by the `%constructorReceiver` slot its receiver is evaluated into.
 * The value the read answers is constructed through the checked-dynamic
 * tier's lifted `%class.construct:` helpers, the fixed-arity one or the
 * packed one a runtime-length spread uses, so a class value reaches the
 * class's own dispatch. */
function constructorConstruct(mod: IrModule): {
  slot: string;
  stmts: IrStmt[];
  result: IrExpr;
} | null {
  for (const sequence of sequences(mod)) {
    const decl = sequence.stmts[0];
    if (decl?.kind !== "varDecl" || !decl.localId.startsWith("%constructorReceiver")) continue;
    const result = sequence.result;
    if (result.kind === "call" && result.callee.startsWith("%class.construct:"))
      return { slot: decl.localId, stmts: sequence.stmts, result };
    if (
      result.kind === "seqExpr" &&
      result.result.kind === "call" &&
      result.result.callee.startsWith("%class.construct:")
    )
      return {
        slot: decl.localId,
        stmts: [...sequence.stmts, ...result.stmts],
        result: result.result,
      };
  }
  return null;
}

test("a construction through a function value's constructor reads the value", async () => {
  const mod = await compileToIr(
    `/**
 * @returns {() => number}
 */
function pick() {
  return () => 1;
}
function argument() {
  return "return 1";
}
new (pick().constructor)(argument());
`,
    "js",
  );
  // A callable return type cannot prove the function carries no own
  // `constructor` property, so the read decides and the value it answers is
  // constructed — a nullish receiver throws before any argument runs.
  expect(codeGenerationThrows(mod)).toEqual([]);
  const dispatched = constructorConstruct(mod);
  expect(dispatched).not.toBeNull();
  const call = dispatched!.result as Extract<IrExpr, { kind: "call" }>;
  expect(call.callee).toBe("%class.construct:1:pick(...).constructor");
  // The member read (the helper's first argument) reads the receiver slot,
  // so it evaluates before the construction's arguments, and the receiver
  // was evaluated once before it.
  expect(call.args[0]).toMatchObject({
    kind: "libCall",
    fn: "js.toDyn",
    args: [{ kind: "call", args: [{ kind: "varRef", localId: dispatched!.slot }] }],
  });
  expect(call.args[1]).toMatchObject({ kind: "dynFrom" });
  expect(dispatched!.stmts).toHaveLength(1);
});

test("a spread construction packs the arguments after the member read", async () => {
  const mod = await compileToIr(
    `/**
 * @returns {() => number}
 */
function pick() {
  return () => 1;
}
const values = ["return 1"];
new (pick().constructor)(...values);
`,
    "js",
  );
  expect(codeGenerationThrows(mod)).toEqual([]);
  const dispatched = constructorConstruct(mod);
  expect(dispatched).not.toBeNull();
  const call = dispatched!.result as Extract<IrExpr, { kind: "call" }>;
  expect(call.callee).toBe("%class.construct:packed:pick(...).constructor");
  // The read is held in its own slot before the argument pack evaluates, so
  // a nullish receiver throws before any argument runs.
  expect(dispatched!.stmts.map((stmt) => stmt.kind)).toContain("varDecl");
  expect(dispatched!.stmts[1]).toMatchObject({ kind: "varDecl" });
  expect(dispatched!.stmts[1]!.kind === "varDecl" && dispatched!.stmts[1]!.localId).toMatch(
    /^%constructorMember/,
  );
  expect(call.args[1]).toMatchObject({ kind: "varRef", localId: /^%spreadArgs/ });
});

test("a spread construction through a class-valued constructor dispatches to the class", async () => {
  const mod = await compileToIr(
    `class Box {
  constructor(value) {
    this.value = value;
  }
}
/**
 * @returns {() => number}
 */
function pick() {
  const made = () => 1;
  made.constructor = Box;
  return made;
}
const values = [2];
new (pick().constructor)(...values);
`,
    "js",
  );
  const dispatched = constructorConstruct(mod);
  expect(dispatched).not.toBeNull();
  expect(dispatched!.result).toMatchObject({
    kind: "call",
    callee: "%class.construct:packed:pick(...).constructor",
  });
  // The packed helper carries the class dispatch, so a class value the
  // function's own `constructor` property names constructs the class
  // instead of reaching the runtime's untyped constructor path.
  const helper = mod.functions.find((fn) =>
    fn.name.startsWith("%class.construct:packed:pick(...).constructor"),
  );
  expect(helper).toBeDefined();
  expect(JSON.stringify(helper!.body)).toContain("classval:Box");
});
