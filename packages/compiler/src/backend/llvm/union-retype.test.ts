import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import {
  F64,
  UNDEFINED_T,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrType,
} from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { analyzeCallLifetimes } from "./call-lifetimes.js";
import { emitLlvmModule } from "./emitter.js";
import { keepUnionsBoxed } from "./test-boxed-unions.js";

const loc = { file: "union-retype.ts", start: 0, end: 0 };
const record: IrType = { kind: "record", shapeId: "cell" };
const narrow: IrType = { kind: "union", unionId: "narrow" };
const wide: IrType = { kind: "union", unionId: "wide" };
const ref = (localId: string, type: IrType = narrow): IrExpr => ({
  kind: "varRef",
  localId,
  type,
  loc,
});
const retype = (value: IrExpr): IrExpr => ({
  kind: "unionRetype",
  fromId: "narrow",
  unionId: "wide",
  tags: [0, 1],
  value,
  type: wide,
  loc,
});

function body(ir: string, name: string): string {
  const found = new RegExp(`^define internal [^\\n]*@${name}(?:\\.i32)?\\([^]*?^}`, "m").exec(ir);
  expect(found, name).not.toBeNull();
  return found![0];
}

/** `retag(u: narrow): wide` returning the same box, plus a caller that
 * passes it a freshly wrapped record. */
function fixture(): IrModule {
  const retag: IrFunction = {
    name: "retag",
    params: [{ localId: "u", name: "u", type: narrow }],
    returnType: wide,
    locals: [{ id: "u", name: "u", type: narrow, mutable: false }],
    body: [{ kind: "return", value: retype(ref("u")), loc }],
    loc,
  };
  const main: IrFunction = {
    name: "main",
    params: [],
    returnType: VOID,
    locals: [],
    body: [
      {
        kind: "exprStmt",
        expr: {
          kind: "call",
          callee: "retag",
          args: [
            {
              kind: "unionWrap",
              unionId: "narrow",
              tag: 0,
              value: {
                kind: "recordLit",
                fields: [{ name: "x", value: { kind: "numLit", value: 1, type: F64, loc } }],
                type: record,
                loc,
              },
              type: narrow,
              loc,
            },
          ],
          type: wide,
          loc,
        },
        loc,
      },
    ],
    loc,
  };
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    records: [{ id: "cell", fields: [{ name: "x", type: F64 }] }],
    unions: [
      { id: "narrow", arms: [record, UNDEFINED_T, F64] },
      { id: "wide", arms: [record, UNDEFINED_T, F64, { kind: "string" }] },
    ],
    functions: [main, retag],
  };
}

function emit(mod: IrModule): string {
  expect(validateModule(mod)).toEqual([]);
  return emitLlvmModule(keepUnionsBoxed(mod), { pointerBits: 64 });
}

test("an identity retype retains the input box instead of allocating", () => {
  const ir = emit(fixture());
  const retag = body(ir, "sc_bf_retag");
  expect(retag).toMatch(/call ptr @scr_union_retain/);
  expect(retag).toMatch(/retype\.share\d+:\n {2}store ptr/);
  // No cast caches these boxes: the flag is never set and folds to false.
  expect(ir).toMatch(/^@sc_retype_guard_0 = internal global i8 0/m);
  expect(retag).toContain("load i8, ptr @sc_retype_guard_0");
  expect(ir).not.toMatch(/store i8 1, ptr @sc_retype_guard_0/);
  // Only the rebuild path behind the flag can allocate.
  const share = /retype\.share\d+:\n([^]*?)\n {2}br label/.exec(retag);
  expect(share?.[1]).not.toMatch(/@scr_union_new/);
});

test("the retyped operand escapes, so no caller passes it a stack box", () => {
  const mod = fixture();
  const lifetimes = analyzeCallLifetimes(new Map(mod.functions.map((fn) => [fn.name, fn])));
  expect(lifetimes.parameters.get("retag")?.has(0) ?? false).toBe(false);
  // The same helper projecting its parameter instead accepts a stack box.
  const projected = fixture();
  projected.functions[1]!.body = [
    {
      kind: "return",
      value: {
        kind: "unionWrap",
        unionId: "wide",
        tag: 0,
        value: {
          kind: "unionNarrow",
          unionId: "narrow",
          tag: 0,
          value: ref("u"),
          type: record,
          loc,
        },
        type: wide,
        loc,
      },
      loc,
    },
  ];
  const projectedLifetimes = analyzeCallLifetimes(
    new Map(projected.functions.map((fn) => [fn.name, fn])),
  );
  expect(projectedLifetimes.parameters.get("retag")?.has(0)).toBe(true);
  const main = body(emit(mod), "sc_f_main");
  expect(main).not.toContain("alloca %ScrUnion");
  expect(main).toContain("@scr_union_new_ref");
});

test("a nullable-pointer source rebuilds the target box", () => {
  const mod = fixture();
  mod.unions![0] = { id: "narrow", arms: [record, UNDEFINED_T] };
  const fn = mod.functions[1]!;
  fn.body = [{ kind: "return", value: retype(ref("u")), loc }];
  mod.functions[0]!.body = [];
  expect(validateModule(mod)).toEqual([]);
  // Only `wide` stays boxed: `narrow` keeps its nullable representation.
  const ir = emitLlvmModule(
    {
      ...mod,
      globals: [
        {
          id: "%g.keep.wide",
          name: "keep_wide",
          type: { kind: "set", elem: wide },
          mutable: false,
        },
      ],
    },
    { pointerBits: 64 },
  );
  const retag = body(ir, "sc_bf_retag");
  expect(retag).toContain("@scr_union_new_ref(i32 0");
  expect(retag).not.toContain("retype.share");
});

/** `boxed`: keep every union a tagged box (record unions otherwise become
 * shape unions, which retype without any box). */
async function llvmFor(source: string, boxed = true): Promise<{ module: IrModule; ir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-union-retype-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    return { module, ir: emitLlvmModule(boxed ? keepUnionsBoxed(module) : module) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const VISITOR = `
type Num = { kind: "num"; value: number };
type Neg = { kind: "neg"; operand: Expr };
type Add = { kind: "add"; left: Expr; right: Expr };
type Expr = Num | Neg | Add;
type Leaf = Add | Neg;
function evaluate(e: Expr): number {
  if (e.kind === "num") return e.value;
  if (e.kind === "neg") return -evaluate(e.operand);
  return evaluate(e.left) + evaluate(e.right);
}
function leafValue(l: Leaf): number {
  return evaluate(l);
}
const n: Num = { kind: "num", value: 2 };
const leaves: Leaf[] = [
  { kind: "neg", operand: n },
  { kind: "add", left: n, right: n },
];
let total = 0;
for (const leaf of leaves) total += leafValue(leaf);
console.log(total);
`;

test("lowered identity retags share the box", async () => {
  const { module, ir } = await llvmFor(VISITOR);
  const helpers = module.functions.filter((fn) => fn.name.startsWith("%union.retag."));
  expect(helpers.length).toBeGreaterThan(0);
  const shared = helpers.filter(
    (fn) =>
      fn.body.length === 1 &&
      fn.body[0]!.kind === "return" &&
      fn.body[0]!.value?.kind === "unionRetype",
  );
  expect(shared.length).toBeGreaterThan(0);
  for (const helper of shared) {
    const symbol = `sc_bf__x25_union_retag_${helper.name.slice("%union.retag.".length)}`;
    const share = /retype\.share\d+:\n([^]*?)\n {2}br label/.exec(body(ir, symbol));
    expect(share, symbol).not.toBeNull();
    expect(share![1]).not.toMatch(/@scr_union_new/);
  }
});

test("a union whose boxes a cast caches stops sharing them", async () => {
  const { ir } = await llvmFor(`${VISITOR}
const parsed = JSON.parse('{"kind":"neg","operand":{"kind":"num","value":3}}') as Leaf;
console.log(leafValue(parsed));
`);
  // Caching a checked box sets its union's flag, which the retype reads.
  const stored = /store i8 1, ptr (@sc_retype_guard_\d+)/.exec(ir);
  expect(stored).not.toBeNull();
  expect(ir).toContain(`load i8, ptr ${stored![1]}`);
});

test("record unions retype as the record pointer itself", async () => {
  const { module, ir } = await llvmFor(VISITOR, false);
  const helpers = module.functions.filter((fn) => fn.name.startsWith("%union.retag."));
  expect(helpers.length).toBeGreaterThan(0);
  for (const helper of helpers) {
    const symbol = `sc_bf__x25_union_retag_${helper.name.slice("%union.retag.".length)}`;
    const retag = body(ir, symbol);
    expect(retag).not.toMatch(/@scr_union_new|retype\.share|sc_retype_guard/);
  }
  // No record of the visitor is ever boxed.
  expect(ir).not.toMatch(/call ptr @scr_union_new_ref/);
});
