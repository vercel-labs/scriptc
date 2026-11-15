import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import {
  BOOL,
  DYN,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrRecordShape,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import { isPlainDescriptorMap, isPlainObjectLiteral, lowerBytesIntegrity } from "./lower-calls.js";
import type { Lowerer } from "./lowerer.js";

const loc: SrcLoc = { file: "bytes.js", start: 0, end: 1 };
const bytes: IrType = { kind: "bytes", elem: "i8" };

/** The conversions the helper needs: a value boxes into dyn (dynFrom) and a
 * dyn value converts back to a typed slot through its checked cast. */
function stub(): Lowerer {
  return {
    coerceToExpected: (expr: IrExpr, expected: IrType): IrExpr =>
      expected.kind === "dyn"
        ? { kind: "dynFrom", value: expr, type: DYN, loc: expr.loc }
        : { kind: "dynCheck", value: expr, type: expected, loc: expr.loc },
  } as unknown as Lowerer;
}

const view: IrExpr = { kind: "varRef", localId: "s.0", type: bytes, loc };

describe("lowerBytesIntegrity", () => {
  test("seal boxes the view, seals it dynamically and answers the same view", () => {
    const result = lowerBytesIntegrity(stub(), "dyn.seal", view, loc);
    // A typed result: the checked cast of the same view (identity preserved).
    expect(result.kind).toBe("dynCheck");
    expect(result.type).toEqual(bytes);
    const call = result.kind === "dynCheck" ? result.value : null;
    expect(call?.kind).toBe("libCall");
    expect(call?.kind === "libCall" ? call.fn : null).toBe("dyn.seal");
    expect(call?.kind === "libCall" ? call.type : null).toEqual(DYN);
    const arg = call?.kind === "libCall" ? call.args[0] : null;
    expect(arg?.kind).toBe("dynFrom");
    expect(arg?.kind === "dynFrom" ? arg.value : null).toEqual(view);
  });

  test("freeze of a DataView (bytes<u8>) answers the view", () => {
    const dv: IrExpr = { kind: "varRef", localId: "s.1", type: { kind: "bytes", elem: "u8" }, loc };
    const result = lowerBytesIntegrity(stub(), "dyn.freeze", dv, loc);
    expect(result.kind).toBe("dynCheck");
  });

  test("a query answers a boolean and keeps no view result", () => {
    const result = lowerBytesIntegrity(stub(), "dyn.isSealed", view, loc);
    expect(result.kind).toBe("libCall");
    expect(result.type).toEqual(BOOL);
    expect(result.kind === "libCall" ? result.fn : null).toBe("dyn.isSealed");
  });
});

const descriptorLoc: SrcLoc = { file: "descriptors.ts", start: 0, end: 1 };

function dynObjLit(): IrExpr {
  return { kind: "dynObjLit", fields: [], type: DYN, loc: descriptorLoc };
}

function recordLit(): IrExpr {
  return {
    kind: "recordLit",
    fields: [],
    type: { kind: "record", shapeId: "r1" },
    loc: descriptorLoc,
  };
}

function recordClone(): IrExpr {
  return {
    kind: "recordClone",
    source: recordLit(),
    overrides: [],
    type: { kind: "record", shapeId: "r1" },
    loc: descriptorLoc,
  };
}

function dynFrom(value: IrExpr): IrExpr {
  return { kind: "dynFrom", value, type: DYN, loc: descriptorLoc };
}

test("a plain object keeps the default descriptor reader", () => {
  expect(isPlainObjectLiteral(dynObjLit())).toBe(true);
  // A typed object literal boxes into dyn through dynFrom, and so does any
  // expression already of a record type (a variable, a clone).
  expect(isPlainObjectLiteral(dynFrom(recordLit()))).toBe(true);
  expect(isPlainObjectLiteral(dynFrom(recordClone()))).toBe(true);
  const recordVariable: IrExpr = {
    kind: "varRef",
    localId: "p1",
    type: { kind: "record", shapeId: "r1" },
    loc: descriptorLoc,
  };
  expect(isPlainObjectLiteral(dynFrom(recordVariable))).toBe(true);
});

test("any other descriptor may be an object of any kind and takes the any-object entry points", () => {
  const variable: IrExpr = { kind: "varRef", localId: "p0", type: DYN, loc: descriptorLoc };
  const array: IrExpr = { kind: "dynArrLit", elems: [], type: DYN, loc: descriptorLoc };
  const call: IrExpr = {
    kind: "libCall",
    fn: "dyn.objCreate",
    args: [dynObjLit()],
    type: DYN,
    loc: descriptorLoc,
  };
  for (const expr of [variable, dynFrom(variable), array, call])
    expect(isPlainObjectLiteral(expr)).toBe(false);
});

test("a descriptor map is plain only when every descriptor in it is plain", () => {
  const key: IrExpr = { kind: "strLit", value: "a", type: { kind: "string" }, loc: descriptorLoc };
  const variable: IrExpr = { kind: "varRef", localId: "p0", type: DYN, loc: descriptorLoc };
  const map = (value: IrExpr): IrExpr => ({
    kind: "dynObjLit",
    fields: [{ key, value }],
    type: DYN,
    loc: descriptorLoc,
  });
  const shapes = new Map<string, IrRecordShape>([
    ["r1", { id: "r1", fields: [] }],
    ["plain", { id: "plain", fields: [{ name: "a", type: { kind: "record", shapeId: "r1" } }] }],
    ["dyn", { id: "dyn", fields: [{ name: "a", type: DYN }] }],
  ]);
  const record = (shapeId: string): IrExpr => ({
    kind: "varRef",
    localId: "p1",
    type: { kind: "record", shapeId },
    loc: descriptorLoc,
  });
  const getRecord = (id: string) => shapes.get(id);
  expect(isPlainDescriptorMap(map(dynObjLit()), getRecord)).toBe(true);
  expect(isPlainDescriptorMap(dynFrom(record("plain")), getRecord)).toBe(true);
  // `{ a: view }` with `view` a DataView, an array or any other dyn value.
  expect(isPlainDescriptorMap(map(variable), getRecord)).toBe(false);
  expect(isPlainDescriptorMap(dynFrom(record("dyn")), getRecord)).toBe(false);
  expect(isPlainDescriptorMap(variable, getRecord)).toBe(false);
});

/* `this.#f(args)` where `#f` is a private FIELD that holds a function, in a
 * JavaScript class's method. The method has two bodies: the one a call on a
 * receiver of the class's type enters, and the receiver-independent one a
 * method VALUE runs (a computed name, a detached method, an island's call),
 * whose `this` is a checked-dynamic value. Both read the field off the
 * instance; the second after the private name's brand check. */
const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function lowerProgram(source: string): Promise<IrModule> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "scriptc-calls-")));
  dirs.push(dir);
  const entry = join(dir, "main.mjs");
  await writeFile(entry, source);
  const outPath = join(dir, "main.ir.json");
  const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return deserializeModule(await readFile(outPath, "utf8"));
}

function expressions(fn: IrFunction): IrExpr[] {
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

/** The calls of the value `this.#load` holds in `fn`. Their callee is named
 * as V8 names it in "is not a function": a private name is a bracketed key. */
function privateFieldCalls(fn: IrFunction): (IrExpr & { kind: "dynCall" })[] {
  return expressions(fn).filter(
    (e): e is IrExpr & { kind: "dynCall" } =>
      e.kind === "dynCall" && e.calleeName === "this[#load]",
  );
}

const PRIVATE_FIELD_CALL = `class Reader {
  #load = (key) => this.label + key;
  #twice(text) {
    return text + text;
  }
  constructor(label) {
    this.label = label;
  }
  read() {
    return this.#twice(this.#load("text"));
  }
}
const reader = new Reader("a");
for (const name of ["read"]) console.log(reader[name]());
console.log(reader.read());
`;

describe("a private field's function in call position", () => {
  test("is the field of the brand-checked receiver when `this` is a checked-dynamic value", async () => {
    const mod = await lowerProgram(PRIVATE_FIELD_CALL);
    // The receiver-independent body of `read`: its `this` is dyn.this.
    const untyped = mod.functions.filter(
      (fn) =>
        expressions(fn).some((e) => e.kind === "libCall" && e.fn === "dyn.this") &&
        JSON.stringify(fn.body).includes("this[#load]"),
    );
    expect(untyped).toHaveLength(1);
    const body = untyped[0]!;
    const calls = privateFieldCalls(body);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    // The callee is the field's value, read off the instance.
    expect(call.callee.kind).toBe("fieldGet");
    expect(call.callee.kind === "fieldGet" ? call.callee.field : null).toBe("#load");
    expect(call.callee.kind === "fieldGet" ? call.callee.obj.type.kind : null).toBe("object");
    // The instance is the receiver after the private name's brand check: a
    // value that is no instance throws there, as under Node.
    const brandChecks = expressions(body).filter(
      (e) => e.kind === "call" && /^%private\.read:.*:#load$/.test(e.callee),
    );
    expect(brandChecks).toHaveLength(1);
    const helper = mod.functions.find(
      (fn) => brandChecks[0]!.kind === "call" && fn.name === brandChecks[0]!.callee,
    );
    expect(helper?.body.length).toBeGreaterThan(0);
    // The function is called with the receiver as `this`.
    expect(call.receiver?.type.kind).toBe("dyn");
    // Nothing asks the receiver for a property spelled like the private
    // name: a plain object holding one is not an instance.
    const byName = expressions(body).filter(
      (e) =>
        (e.kind === "dynInvoke" && e.method === "#load") ||
        (e.kind === "dynKeyGet" && e.key.kind === "strLit" && e.key.value === "#load"),
    );
    expect(byName).toEqual([]);
  });

  test("stays the field of the typed receiver in the method's own body", async () => {
    const mod = await lowerProgram(PRIVATE_FIELD_CALL);
    const typed = mod.functions.filter(
      (fn) => fn.params[0]?.name === "this" && privateFieldCalls(fn).length > 0,
    );
    expect(typed).toHaveLength(1);
    const call = privateFieldCalls(typed[0]!)[0]!;
    expect(call.callee.kind).toBe("fieldGet");
    expect(call.callee.kind === "fieldGet" ? call.callee.field : null).toBe("#load");
    // No brand check: the receiver's type is the class.
    expect(
      expressions(typed[0]!).some((e) => e.kind === "call" && e.callee.startsWith("%private.")),
    ).toBe(false);
  });
});
